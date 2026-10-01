// 페이지 렌더링. 상태는 state 객체 하나로 들고, DOM은 root(document)에서 찾는다.
import {
  DOW, addDays, addMonths, barPercent, computeStats, dayOfWeek, dayMinutes, dayStatus, dayTimeRange, durationLong, esc, firstMonth, hm, makeContext, monthDays, monthLabel,
  streamMinutes, todayKst,
} from './calendar.js';

const MARKS = { on: '방송', off: '휴방', pending: '?', unknown: '미확인', nodata: '', future: '' };
const LABELS = { on: '방송', off: '휴방', pending: '아직 방송 전', unknown: '확인 전', nodata: '기록 없음', future: '' };

export function createState(data, now = Date.now()) {
  const today = todayKst(now);
  const ctx = makeContext(data, today);
  return { data, now, today, ctx, byDay: ctx.byDay, lastChecked: data.checkedDays?.at(-1) ?? null, view: today.slice(0, 7), selected: null };
}

const ctx = (state) => state.ctx;

// 매시간 수집 + cron 지연 여유
export const LIVE_FRESH_MS = 2 * 60 * 60 * 1000;

// 자정을 넘긴 방송은 시작일(어제)에 속하므로 오늘 목록이 아니라 전체에서 열린 방송을 찾는다.
// 수집이 멈춰 live가 남아 있을 수 있으니 최근(2시간 이내)에 방송 중으로 확인된 경우만 믿는다
const isLiveFresh = (state) => state.now - Date.parse(state.data.liveCheckedAt ?? '') <= LIVE_FRESH_MS;

function findLiveStream(state) {
  if (!state.data.live || !isLiveFresh(state)) return null;
  return state.data.streams.findLast((s) => !s.closeDate) ?? null;
}

function startedAt(openDate, today) {
  const d = openDate.slice(0, 10);
  if (d === today) return hm(openDate);
  if (d === addDays(today, -1)) return `어제 ${hm(openDate)}`;
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8))} ${hm(openDate)}`;
}

function staleNotice(state) {
  if (state.data.live && !isLiveFresh(state)) {
    return '<div class="stale">방송 중이었지만 최근 2시간 동안 상태를 확인하지 못해 최신 정보가 아닐 수 있어요.</div>';
  }
  if (state.lastChecked && state.lastChecked >= addDays(state.today, -1)) return '';
  const when = state.lastChecked ? `마지막 자동 확인이 ${state.lastChecked}이라` : '자동 확인 기록이 없어';
  return `<div class="stale">${when} 최신 정보가 아닐 수 있어요.</div>`;
}

export function renderToday(root, state) {
  const { today } = state;
  const streams = state.byDay.get(today) || [];
  const liveStream = findLiveStream(state);
  let verdict, cls, detail;
  if (liveStream) {
    verdict = '<span class="live-dot"></span>방송 중';
    cls = 'on';
    detail = `${startedAt(liveStream.openDate, today)} 시작 · ${esc(liveStream.title)}`;
  } else if (streams.length) {
    verdict = '방송함';
    cls = 'on';
    detail = streams.map((s) => `${hm(s.openDate)}~${hm(s.closeDate)} · ${esc(s.title)}`).join('<br>');
  } else {
    verdict = '아직 안 켬';
    cls = 'pending';
    const y = dayStatus(addDays(today, -1), ctx(state));
    detail = {
      off: '어제는 휴방이었어요.',
      on: '어제는 방송했어요.',
      unknown: '어제 방송 여부는 아직 확인 중이에요.',
    }[y] ?? '';
  }
  root.getElementById('today').innerHTML =
    `<div class="label">오늘 (${today})</div><div class="verdict ${cls}">${verdict}</div><div class="detail">${detail}</div>${staleNotice(state)}`;
}

export function renderStats(root, state) {
  // 월 통계는 달력에서 보고 있는 달을 따르고, 연속 일수는 항상 현재 기준이다
  const s = computeStats(ctx(state), state.view);
  const month = monthLabel(state.view, state.today);
  root.getElementById('stats').innerHTML = [
    [s.on + '일', `${month} 방송한 날`],
    [s.off + '일', `${month} 휴방한 날`],
    [s.offRate === null ? '-' : s.offRate + '%', `${month} 휴방률`],
    [s.streak + '일', s.streakKind === 'off' ? '현재 연속 휴방' : '현재 연속 방송'],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}

export function renderCalendar(root, state) {
  const [y, m] = state.view.split('-').map(Number);
  root.getElementById('month').textContent = `${y}년 ${m}월`;
  const days = monthDays(state.view);
  let html = DOW.map((d) => `<div class="dow">${d}</div>`).join('');
  html += '<div class="day blank"></div>'.repeat(dayOfWeek(days[0]));
  for (const d of days) {
    const s = dayStatus(d, ctx(state));
    const sel = d === state.selected;
    // 지난 방송일은 '방송' 대신 방송 시간을 막대로 보여 주고, 시작~종료는 상세(누르기·마우스 올리기)에서 보여 준다
    const mins = s === 'on' && d < state.today ? dayMinutes(state.byDay.get(d)) : null;
    let label = `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일${LABELS[s] ? ' ' + LABELS[s] : ''}`;
    let mark = `<span class="mark">${MARKS[s]}</span>`;
    if (mins !== null) {
      const range = dayTimeRange(state.byDay.get(d));
      label += ` ${durationLong(mins)}, ${range.open}~${range.close}`;
      mark = `<span class="bar" aria-hidden="true"><i style="width:${barPercent(mins)}%"></i></span>`;
    }
    html += `<button class="day ${s}${sel ? ' selected' : ''}" data-d="${d}" aria-label="${label}" aria-pressed="${sel}"${s === 'future' ? ' disabled' : ''}><span>${Number(d.slice(8))}</span>${mark}</button>`;
  }
  const grid = root.getElementById('grid');
  grid.innerHTML = html;
  grid.querySelectorAll('button.day').forEach((b) => b.addEventListener('click', () => select(root, state, b.dataset.d)));

  root.getElementById('prev').disabled = state.view <= firstMonth(state.data);
  root.getElementById('next').disabled = state.view >= state.today.slice(0, 7);
}

// 날짜 상세. 아래 정보 칸과 마우스 툴팁이 같이 쓴다
export function dayDetail(state, d) {
  const streams = state.byDay.get(d) || [];
  const s = dayStatus(d, ctx(state));
  let body;
  if (streams.length) {
    body = '<ul>' + streams.map((x) => {
      const time = x.closeDate
        ? `<b>${hm(x.openDate)} ~ ${hm(x.closeDate)}</b> · ${durationLong(streamMinutes(x))}`
        : `<b>${hm(x.openDate)} ~ 방송 중</b>`;
      return `<li>${time}<br>${esc(x.title)}${x.category ? ` <span class="muted">(${esc(x.category)})</span>` : ''}</li>`;
    }).join('') + '</ul>';
    const total = dayMinutes(streams);
    if (streams.length > 1 && total !== null) body += `<div class="muted">총 ${durationLong(total)}</div>`;
  } else if (s === 'off') body = '<div class="muted">휴방</div>';
  else if (s === 'pending') body = '<div class="muted">아직 방송 기록이 없어요.</div>';
  else if (s === 'unknown') body = '<div class="muted">아직 확인되지 않았어요. 다음 자동 확인 후 반영돼요.</div>';
  else body = '<div class="muted">기록을 시작하기 전이라 알 수 없어요.</div>';
  return `<b>${d} (${DOW[dayOfWeek(d)]})</b>${body}`;
}

export function renderInfo(root, state) {
  root.getElementById('info').innerHTML = dayDetail(state, state.selected);
}

export function select(root, state, d) {
  state.selected = d;
  hideTip(root);
  renderInfo(root, state);
  renderCalendar(root, state);
  // 폰에선 상세 칸이 화면 아래에 있을 수 있어 보이도록 끌어온다
  root.getElementById('info').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

const hideTip = (root) => {
  const tip = root.getElementById('tip');
  tip.hidden = true;
  delete tip.dataset.for;
};

// 마우스를 방송한 날 위에 올리면 상세를 툴팁으로 보여 준다. 터치는 누르기(정보 칸)로 충분해 제외.
// 달력은 다시 그려지므로 grid에 한 번만 위임해서 건다
export function bindHover(root, state) {
  const grid = root.getElementById('grid');
  const tip = root.getElementById('tip');
  grid.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest('button.day.on');
    // 선택한 날은 아래 정보 칸에 이미 같은 내용이 있다
    if (!b || b.dataset.d === state.selected) return hideTip(root);
    if (tip.dataset.for === b.dataset.d) return;
    tip.dataset.for = b.dataset.d;
    tip.innerHTML = dayDetail(state, b.dataset.d);
    tip.hidden = false;
    const box = tip.parentElement.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const left = r.left - box.left + r.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(8, Math.min(left, box.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${r.bottom - box.top + 6}px`;
  });
  grid.addEventListener('pointerleave', () => hideTip(root));
}

export function shiftMonth(root, state, n) {
  state.view = addMonths(state.view, n);
  renderStats(root, state);
  renderCalendar(root, state);
}

export function renderAll(root, state) {
  renderToday(root, state);
  renderStats(root, state);
  renderCalendar(root, state);
  root.getElementById('footer').textContent =
    `${state.data.since}부터 기록 · 매시간 자동 확인 · 마지막 확인일 ${state.lastChecked ?? '-'}`;
}

export function renderError(root) {
  root.getElementById('today').innerHTML = '<div class="label">데이터를 불러오지 못했어요.</div>';
}

export const THEME_KEY = 'theme';

// 지금 보이는 테마: 고른 값(data-theme)이 있으면 그것, 없으면 기기 설정
export function currentTheme(root, win) {
  return root.documentElement.dataset.theme ?? (win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

// 테마 버튼: 누르면 지금 보이는 테마의 반대로 바꾸고 저장한다. 아이콘은 지금 테마(data-theme-now)를 따른다
export function bindTheme(root = document, win = window) {
  const btn = root.getElementById('theme');
  const media = win.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const now = currentTheme(root, win);
    root.documentElement.dataset.themeNow = now;
    btn.setAttribute('aria-label', now === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
  };
  btn.addEventListener('click', () => {
    const next = currentTheme(root, win) === 'dark' ? 'light' : 'dark';
    root.documentElement.dataset.theme = next;
    try {
      win.localStorage.setItem(THEME_KEY, next);
    } catch {
      // 저장이 막힌 환경에서도 이번 화면에선 바뀐다
    }
    sync();
  });
  // 고른 테마가 없을 때 기기 설정이 바뀌면 아이콘도 따라간다
  media.addEventListener('change', sync);
  sync();
}

export async function init(root = document, fetchImpl = fetch, now = Date.now()) {
  try {
    const res = await fetchImpl('data/streams.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.streams) || typeof data.since !== 'string') throw new Error('형식 오류');
    const state = createState(data, now);
    root.getElementById('prev').addEventListener('click', () => shiftMonth(root, state, -1));
    root.getElementById('next').addEventListener('click', () => shiftMonth(root, state, 1));
    bindHover(root, state);
    renderAll(root, state);
    return state;
  } catch {
    renderError(root);
    return null;
  }
}
