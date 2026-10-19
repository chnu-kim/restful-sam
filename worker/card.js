// 링크 카드(Discord·카카오톡 등에 주소를 붙였을 때 뜨는 미리보기): <head>에 넣을 문구와 og:image로 쓸 카드 이미지.
// 무료 플랜 CPU 한도(10ms) 안에서는 한글이 든 이미지를 그릴 수 없어, 카드 HTML을 Browser Run으로 찍고
// 그린 내용이 바뀔 때만 다시 찍어 D1에 둔다. 판정은 사이트와 같은 calendar.js 함수를 써서 어긋나지 않게 한다
import {
  DOW, computeStats, currentStreak, dayMinutes, dayOfWeek, dayStatus, durationLong, esc, fillPercent, hm, liveStream, makeContext, monthDays, offStreakBefore,
  offStreakText, startedAt, todayKst,
} from '../public/src/calendar.js';
import { loadDoc } from './run.js';

export const SITE_NAME = '삼덕이 휴방 체크';
// 매분 D1을 읽지 않도록 2분에 한 번만 카드가 바뀌었는지 본다. 찍기에 실패해도 2분 뒤 다시 시도한다
export const CARD_EVERY_MIN = 2;
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
// Discord 임베드 왼쪽 띠 색 (theme-color)
export const TONE_COLORS = { on: '#00b36b', off: '#e5484d', pending: '#b8b4a8' };

const dateText = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 (${DOW[dayOfWeek(d)]})`;
const joinParts = (...parts) => parts.filter(Boolean).join(' · ');

// 카드에 그릴 내용. tone은 색, cells는 오늘이 속한 달의 달력 칸(앞쪽 빈칸 포함)
export function cardView(data, now) {
  const today = todayKst(now);
  const ctx = makeContext(data, today);
  const live = liveStream(data, now);
  const todays = ctx.byDay.get(today) ?? [];
  let tone, headline, sub;
  if (live) {
    tone = 'on';
    headline = '방송 중';
    const r = offStreakBefore(live.openDate.slice(0, 10), ctx);
    sub = joinParts(`${startedAt(live.openDate, today)} 시작`, r && offStreakText(r));
  } else if (todays.length) {
    tone = 'on';
    headline = '오늘 방송함';
    const m = dayMinutes(todays);
    const r = offStreakBefore(today, ctx);
    sub = joinParts(m === null ? `${hm(todays[0].openDate)} 시작` : `${durationLong(m)} 방송`, r && offStreakText(r));
  } else {
    // 오늘은 아직 모르므로 세지 않는다 (사이트의 '현재 연속 휴방'과 같은 값)
    const { streak, streakKind } = currentStreak(ctx);
    tone = streakKind === 'off' ? 'off' : 'pending';
    headline = streakKind === 'off' ? `${streak}일 연속 휴방` : '아직 안 켬';
    const last = data.streams.at(-1);
    sub = last ? `마지막 방송 ${dateText(last.openDate.slice(0, 10))}` : '';
  }

  const ym = today.slice(0, 7);
  const days = monthDays(ym);
  const stats = computeStats(ctx, ym);
  const month = `${Number(ym.slice(5))}월`;
  const cells = [
    ...Array.from({ length: dayOfWeek(days[0]) }, () => ({ status: 'blank', fill: null })),
    ...days.map((d) => {
      const status = dayStatus(d, ctx);
      const m = status === 'on' ? dayMinutes(ctx.byDay.get(d)) : null;
      return { status, fill: m === null ? null : fillPercent(m) };
    }),
  ];
  return {
    tone,
    live: Boolean(live),
    headline,
    sub,
    description: joinParts(sub, `${month} 방송 ${stats.on}일, 휴방 ${stats.off}일`),
    month,
    cells,
  };
}

// 다크 팔레트는 사이트 다크 테마에서 가져오되, 작게 보여도 구분되도록 휴방·방송 칸을 조금 진하게 했다
const HEADLINE_COLORS = { on: '#1fd286', off: '#ff6b6f', pending: '#ecebe6' };

// 폰트를 다 받으면 body에 data-ready를 달아, 찍는 쪽이 그때까지 기다리게 한다 (안 기다리면 글자가 빈 채로 찍힌다)
export const READY_SELECTOR = 'body[data-ready]';

export function cardHtml(view) {
  const cells = view.cells.map((c) => `<div class="c ${c.status}">${c.fill === null ? '' : `<i style="height:${c.fill}%"></i>`}</div>`).join('');
  // 한글 웹폰트는 크므로 카드에 쓰는 글자만 담은 파일을 받는다
  const text = [...new Set(SITE_NAME + view.headline + view.sub + view.month)].join('');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@600;700&display=block&text=${encodeURIComponent(text)}" rel="stylesheet">
<style>
* { box-sizing: border-box; }
body { margin: 0; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden; background: #141413; color: #ecebe6; font-family: 'IBM Plex Sans KR', sans-serif; }
.card { width: 100%; height: 100%; padding: 72px; display: flex; align-items: center; justify-content: space-between; gap: 48px; }
.text { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.site { font-size: 30px; font-weight: 600; color: #9a988f; }
.headline { font-size: 88px; font-weight: 700; letter-spacing: -0.04em; line-height: 1.15; word-break: keep-all; color: ${HEADLINE_COLORS[view.tone]}; }
.dot { display: inline-block; width: 30px; height: 30px; border-radius: 50%; background: #ff6b6f; margin-right: 20px; vertical-align: middle; }
.sub { font-size: 32px; font-weight: 600; color: #9a988f; word-break: keep-all; }
.cal { flex: none; display: flex; flex-direction: column; gap: 14px; }
.month { font-size: 26px; font-weight: 600; color: #9a988f; }
.grid { width: 400px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.c { position: relative; overflow: hidden; aspect-ratio: 1; border-radius: 10px; }
.c i { position: absolute; left: 0; right: 0; bottom: 0; background: #23a86a; }
.on { background: #143a29; }
.off { background: #5a2629; }
.pending { border: 3px dashed #6b685f; }
.unknown { background: repeating-linear-gradient(135deg, #6b685f 0 3px, transparent 3px 9px); }
.nodata { background: #262523; }
.future { border: 2px solid #2f2e2b; }
</style>
</head>
<body>
<div class="card">
  <div class="text">
    <div class="site">${SITE_NAME}</div>
    <div class="headline">${view.live ? '<span class="dot"></span>' : ''}${esc(view.headline)}</div>
    ${view.sub ? `<div class="sub">${esc(view.sub)}</div>` : ''}
  </div>
  <div class="cal">
    <div class="month">${view.month}</div>
    <div class="grid">${cells}</div>
  </div>
</div>
<script>
Promise.all([document.fonts.load('700 88px "IBM Plex Sans KR"'), document.fonts.load('600 32px "IBM Plex Sans KR"')])
  .then(() => document.fonts.ready)
  .then(() => { document.body.dataset.ready = '1'; });
</script>
</body>
</html>`;
}

// 그린 HTML의 해시. 내용이나 템플릿이 바뀌면 달라져 다시 찍고, og:image 주소에 붙여 메신저의 이미지 캐시도 피한다
export async function cardKey(html) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const isPng = (buf) => PNG_SIGNATURE.every((b, i) => new Uint8Array(buf, 0, 4)[i] === b);

// 최근 몇 장까지 남길지. 카드는 하루 몇 번 바뀌므로 하루치 남짓이다
export const KEEP_CARDS = 10;

// 가장 최근에 찍은 카드의 key
export async function storedCardKey(db) {
  return (await db.prepare('SELECT key FROM og_cards ORDER BY rendered_at DESC LIMIT 1').first())?.key ?? null;
}

// 카드가 바뀌었으면 다시 찍어 저장한다. 찍었으면 새 key, 아니면 null. data를 받으면 D1을 다시 읽지 않는다
export async function updateCard(env, { now = Date.now(), data, log = console.log } = {}) {
  if (Math.floor(now / 60000) % CARD_EVERY_MIN !== 0) return null;
  data ??= (await loadDoc(env.DB))?.data;
  if (!data) return null;
  const html = cardHtml(cardView(data, now));
  const key = await cardKey(html);
  if ((await storedCardKey(env.DB)) === key) return null;

  // 폰트를 못 받으면 글자 없는 카드를 저장하지 않도록 기다리다 실패한다
  const res = await env.BROWSER.quickAction('screenshot', {
    html,
    viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
    gotoOptions: { waitUntil: 'networkidle0', timeout: 30_000 },
    waitForSelector: { selector: READY_SELECTOR, timeout: 20_000 },
  });
  if (!res.ok) throw new Error(`카드 스크린샷 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const png = await res.arrayBuffer();
  if (png.byteLength < 8 || !isPng(png)) throw new Error(`카드 스크린샷이 PNG가 아닙니다 (${png.byteLength}바이트)`);
  // 예전과 같은 카드로 돌아왔으면 그 줄을 최신으로 바꾼다
  await env.DB.prepare('INSERT OR REPLACE INTO og_cards (key, png, rendered_at) VALUES (?, ?, ?)').bind(key, png, new Date(now).toISOString()).run();
  await env.DB.prepare('DELETE FROM og_cards WHERE key NOT IN (SELECT key FROM og_cards ORDER BY rendered_at DESC LIMIT ?)').bind(KEEP_CARDS).run();
  log(JSON.stringify({ message: '링크 카드 갱신', key, bytes: png.byteLength }));
  return key;
}
