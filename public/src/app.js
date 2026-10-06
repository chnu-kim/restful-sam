// 페이지 렌더링. 상태는 state 객체 하나로 들고, DOM은 root(document)에서 찾는다.
import {
  DOW, addDays, addMonths, computeStats, dayOfWeek, dayMinutes, dayStatus, dayTimeRange, durationLong, esc, fillPercent, firstMonth, hm, makeContext, monthDays, monthLabel,
  offStreakBefore, streamMinutes, todayKst,
} from './calendar.js';

const MARKS = { on: '방송', off: '휴방', pending: '?', unknown: '미확인', nodata: '', future: '' };
const LABELS = { on: '방송', off: '휴방', pending: '아직 방송 전', unknown: '확인 전', nodata: '기록 없음', future: '' };
// 날짜 상세와 오늘 카드가 같은 문구를 쓴다. 기록 시작 전·확인 전에 닿아 정확히 모르면 '이상'
const offStreakText = (r) => `${r.days}일${r.atLeast ? ' 이상' : ''} 휴방 후 첫 방송`;

export function createState(data, now = Date.now()) {
  const today = todayKst(now);
  const ctx = makeContext(data, today);
  return { data, now, today, ctx, byDay: ctx.byDay, lastChecked: data.checkedDays?.at(-1) ?? null, view: today.slice(0, 7), selected: null };
}

const ctx = (state) => state.ctx;

// 1분마다 수집 + 지연 여유
export const LIVE_FRESH_MS = 10 * 60 * 1000;

// 자정을 넘긴 방송은 시작일(어제)에 속하므로 오늘 목록이 아니라 전체에서 열린 방송을 찾는다.
// 수집이 멈춰 live가 남아 있을 수 있으니 최근(10분 이내)에 방송 중으로 확인된 경우만 믿는다
const isLiveFresh = (state) => state.now - Date.parse(state.data.liveCheckedAt ?? '') <= LIVE_FRESH_MS;

function findLiveStream(state) {
  if (!state.data.live || !isLiveFresh(state)) return null;
  return state.data.streams.findLast((s) => !s.closeDate && !s.ended) ?? null;
}

// 종료를 놓쳐 마지막으로 본 시각으로 추정한 종료 시각에는 '약'을 붙인다
const approx = (s) => (s.closeApprox ? '약 ' : '');

function startedAt(openDate, today) {
  const d = openDate.slice(0, 10);
  if (d === today) return hm(openDate);
  if (d === addDays(today, -1)) return `어제 ${hm(openDate)}`;
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8))} ${hm(openDate)}`;
}

function staleNotice(state) {
  if (state.data.live && !isLiveFresh(state)) {
    return '<div class="stale">방송 중이었지만 최근 10분 동안 상태를 확인하지 못해 최신 정보가 아닐 수 있어요.</div>';
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
    // 여기 온 열린 방송은 방송 중으로 믿을 수 없으니(끝났거나 수집이 멈춤) 끝을 '확인 중'으로 둔다
    detail = streams.map((s) => `${hm(s.openDate)}~${s.closeDate ? approx(s) + hm(s.closeDate) : '확인 중'} · ${esc(s.title)}`).join('<br>');
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
  // 휴방 뒤 처음 켰으면 며칠 쉬었는지 덧붙인다. 자정을 넘긴 방송은 시작일 기준이고, 아직 안 켰으면 기준일이 없다
  const anchor = liveStream ? liveStream.openDate.slice(0, 10) : streams.length ? today : null;
  const r = anchor && offStreakBefore(anchor, ctx(state));
  if (r) detail += `<br>${offStreakText(r)}이에요.`;
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
    // 지난 방송일은 '방송' 대신 칸을 방송 시간만큼(하루 24시간 기준) 아래부터 채우고, 시작~종료는 상세(누르기·마우스 올리기)에서 보여 준다
    const mins = s === 'on' && d < state.today ? dayMinutes(state.byDay.get(d)) : null;
    let label = `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일${LABELS[s] ? ' ' + LABELS[s] : ''}`;
    let mark = `<span class="mark">${MARKS[s]}</span>`;
    let fill = '';
    if (mins !== null) {
      const range = dayTimeRange(state.byDay.get(d));
      label += ` ${durationLong(mins)}, ${range.open}~${range.close}`;
      mark = '';
      fill = ` style="--fill:${fillPercent(mins)}%"`;
    }
    html += `<button class="day ${s}${fill ? ' filled' : ''}${sel ? ' selected' : ''}" data-d="${d}"${fill} aria-label="${label}" aria-pressed="${sel}"${s === 'future' ? ' disabled' : ''}><span>${Number(d.slice(8))}</span>${mark}</button>`;
  }
  const grid = root.getElementById('grid');
  grid.innerHTML = html;
  grid.querySelectorAll('button.day').forEach((b) => b.addEventListener('click', () => select(root, state, b.dataset.d)));

  root.getElementById('prev').disabled = state.view <= firstMonth(state.data);
  root.getElementById('next').disabled = state.view >= state.today.slice(0, 7);
}

// 날짜 상세. 아래 정보 칸과 마우스 툴팁이 같이 쓴다
// 방송 중 카테고리를 바꿨으면 구간별로, 아니면 카테고리 하나를 괄호로 보여 준다.
// 마지막 구간의 끝은 방송 종료와 같게 표시하고(추정이면 '약', 방송 중이면 비우고, 모르면 '확인 중'),
// 길이가 0이거나 거꾸로인 구간(종료 직전에 바뀌었거나 다시보기로 종료 시각이 당겨짐)은 뺀다
function categoryText(x, live) {
  const segments = (x.categories ?? []).flatMap((c, i, all) => {
    // 끝은 다음 구간 시작과 방송 종료 중 이른 쪽
    const next = all[i + 1]?.from;
    const atClose = Boolean(x.closeDate) && (!next || next >= x.closeDate);
    const endAt = atClose ? x.closeDate : next;
    if (endAt && endAt <= c.from) return [];
    const end = atClose ? approx(x) + hm(x.closeDate) : next ? hm(next) : live ? '' : '확인 중';
    return [{ text: `${hm(c.from)}~${end} ${esc(c.category ?? '카테고리 없음')}`, category: c.category }];
  });
  if (segments.length > 1) return `<div class="muted">${segments.map((g) => g.text).join('<br>')}</div>`;
  const category = segments.length ? segments[0].category : x.category;
  return category ? ` <span class="muted">(${esc(category)})</span>` : '';
}

export function dayDetail(state, d) {
  const streams = state.byDay.get(d) || [];
  const s = dayStatus(d, ctx(state));
  // 종료 시각이 없어도 최근에 방송 중으로 확인된 방송만 '방송 중'이고, 나머지(끝남·수집 멈춤)는 지어내지 않는다
  const liveStream = findLiveStream(state);
  let body;
  if (streams.length) {
    body = '<ul>' + streams.map((x) => {
      const live = x === liveStream;
      const time = x.closeDate
        ? `<b>${hm(x.openDate)} ~ ${approx(x)}${hm(x.closeDate)}</b> · ${approx(x)}${durationLong(streamMinutes(x))}`
        : `<b>${hm(x.openDate)} ~ ${live ? '방송 중' : '종료 시각 확인 중'}</b>`;
      return `<li>${time}<br>${esc(x.title)}${categoryText(x, live)}</li>`;
    }).join('') + '</ul>';
    const total = dayMinutes(streams);
    if (streams.length > 1 && total !== null) body += `<div class="muted">총 ${durationLong(total)}</div>`;
  } else if (s === 'off') body = '<div class="muted">휴방</div>';
  else if (s === 'pending') body = '<div class="muted">아직 방송 기록이 없어요.</div>';
  else if (s === 'unknown') body = '<div class="muted">아직 확인되지 않았어요. 다음 자동 확인 후 반영돼요.</div>';
  else body = '<div class="muted">기록을 시작하기 전이라 알 수 없어요.</div>';
  // 휴방 뒤 첫 방송이면 날 단위 사실이라 방송 목록이 아니라 날짜 바로 아래에 둔다
  const r = offStreakBefore(d, ctx(state));
  return `<b>${d} (${DOW[dayOfWeek(d)]})</b>${r ? `<div class="muted">${offStreakText(r)}</div>` : ''}${body}`;
}

export function renderInfo(root, state) {
  root.getElementById('info').innerHTML = dayDetail(state, state.selected);
}

export function select(root, state, d) {
  // 달력을 다시 그리면 누른 버튼이 사라져 포커스가 맨 위로 가므로, 키보드 등으로 그 칸에 있던 포커스는 새 칸으로 되돌린다
  const refocus = root.activeElement?.closest?.('#grid button.day');
  state.selected = d;
  hideTip(root);
  renderInfo(root, state);
  renderCalendar(root, state);
  if (refocus) root.querySelector(`#grid button.day[data-d="${refocus.dataset.d}"]`)?.focus({ preventScroll: true });
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
  const pressed = root.activeElement;
  state.view = addMonths(state.view, n);
  renderStats(root, state);
  renderCalendar(root, state);
  // 끝 달에 닿아 누른 버튼이 비활성화되면 포커스가 사라지므로 반대쪽 버튼으로 옮긴다
  if (pressed?.disabled && (pressed.id === 'prev' || pressed.id === 'next')) root.getElementById(pressed.id === 'prev' ? 'next' : 'prev').focus();
}

export function renderAll(root, state) {
  renderToday(root, state);
  renderStats(root, state);
  renderCalendar(root, state);
  root.getElementById('footer').textContent =
    `${state.data.since}부터 기록 · 1분마다 자동 확인 · 마지막 확인일 ${state.lastChecked ?? '-'}`;
}

export function renderError(root) {
  root.getElementById('today').innerHTML = '<div class="label">데이터를 불러오지 못했어요.</div>';
}

export const THEME_KEY = 'theme';
const THEME_LABELS = { system: '시스템', light: '라이트', dark: '다크' };

// 테마 선택: 'system'(기본, 기기 설정을 따름) · 'light' · 'dark'. 기본값은 저장하지 않고 지운다
export function applyTheme(root, win, choice) {
  const html = root.documentElement;
  try {
    if (choice === 'system') {
      delete html.dataset.theme;
      win.localStorage.removeItem(THEME_KEY);
    } else {
      html.dataset.theme = choice;
      win.localStorage.setItem(THEME_KEY, choice);
    }
  } catch {
    // 저장이 막힌 환경에서도 이번 화면에선 바뀐다
  }
}

// 테마 버튼: 누를 때마다 시스템 → 라이트 → 다크 순서로 바뀐다. 아이콘은 고른 값(data-theme 유무)을 CSS로 따른다
const THEME_ORDER = ['system', 'light', 'dark'];

export function bindTheme(root = document, win = window) {
  const btn = root.getElementById('theme');
  const current = () => root.documentElement.dataset.theme ?? 'system';
  const sync = () => {
    const label = `테마: ${THEME_LABELS[current()]}`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  btn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current()) + 1) % THEME_ORDER.length];
    applyTheme(root, win, next);
    sync();
  });
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
