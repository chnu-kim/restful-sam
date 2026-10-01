// 페이지 렌더링. 상태는 state 객체 하나로 들고, DOM은 root(document)에서 찾는다.
import {
  DOW, addDays, addMonths, computeStats, dayOfWeek, dayStatus, esc, firstMonth, groupByDay, hm, monthDays, todayKst,
} from './calendar.js';

const MARKS = { on: '방송', off: '휴방', pending: '?', nodata: '', future: '' };

export function createState(data, now = Date.now()) {
  const today = todayKst(now);
  return { data, today, byDay: groupByDay(data.streams), view: today.slice(0, 7), selected: null };
}

const ctx = (state) => ({ byDay: state.byDay, since: state.data.since, today: state.today });

export function renderToday(root, state) {
  const { today } = state;
  const streams = state.byDay.get(today) || [];
  const liveStream = state.data.live ? streams.find((s) => !s.closeDate) : null;
  let verdict, cls, detail;
  if (liveStream) {
    verdict = '<span class="live-dot"></span>방송 중';
    cls = 'on';
    detail = `${hm(liveStream.openDate)} 시작 · ${esc(liveStream.title)}`;
  } else if (streams.length) {
    verdict = '방송함';
    cls = 'on';
    detail = streams.map((s) => `${hm(s.openDate)}~${hm(s.closeDate)} · ${esc(s.title)}`).join('<br>');
  } else {
    verdict = '아직 안 켬';
    cls = 'pending';
    const y = dayStatus(addDays(today, -1), ctx(state));
    detail = y === 'off' ? '어제는 휴방이었어요.' : y === 'on' ? '어제는 방송했어요.' : '';
  }
  root.getElementById('today').innerHTML =
    `<div class="label">오늘 (${today})</div><div class="verdict ${cls}">${verdict}</div><div class="detail">${detail}</div>`;
}

export function renderStats(root, state) {
  const s = computeStats(ctx(state));
  root.getElementById('stats').innerHTML = [
    [s.on + '일', '이번 달 방송한 날'],
    [s.off + '일', '이번 달 휴방한 날'],
    [s.offRate === null ? '-' : s.offRate + '%', '이번 달 휴방률'],
    [s.streak + '일', s.streakKind === 'off' ? '연속 휴방' : '연속 방송'],
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
    const sel = d === state.selected ? ' selected' : '';
    html += `<button class="day ${s}${sel}" data-d="${d}"${s === 'future' ? ' disabled' : ''}><span>${Number(d.slice(8))}</span><span class="mark">${MARKS[s]}</span></button>`;
  }
  const grid = root.getElementById('grid');
  grid.innerHTML = html;
  grid.querySelectorAll('button.day').forEach((b) => b.addEventListener('click', () => select(root, state, b.dataset.d)));

  root.getElementById('prev').disabled = state.view <= firstMonth(state.data);
  root.getElementById('next').disabled = state.view >= state.today.slice(0, 7);
}

export function renderInfo(root, state) {
  const d = state.selected;
  const streams = state.byDay.get(d) || [];
  const s = dayStatus(d, ctx(state));
  let body;
  if (streams.length) {
    body = '<ul>' + streams.map((x) =>
      `<li>${hm(x.openDate)}~${x.closeDate ? hm(x.closeDate) : '방송 중'} · ${esc(x.title)}${x.category ? ` <span class="muted">(${esc(x.category)})</span>` : ''}</li>`,
    ).join('') + '</ul>';
  } else if (s === 'off') body = '<div class="muted">휴방</div>';
  else if (s === 'pending') body = '<div class="muted">아직 방송 기록이 없어요.</div>';
  else body = '<div class="muted">기록을 시작하기 전이라 알 수 없어요.</div>';
  root.getElementById('info').innerHTML = `<b>${d} (${DOW[dayOfWeek(d)]})</b>${body}`;
}

export function select(root, state, d) {
  state.selected = d;
  renderInfo(root, state);
  renderCalendar(root, state);
}

export function shiftMonth(root, state, n) {
  state.view = addMonths(state.view, n);
  renderCalendar(root, state);
}

export function renderAll(root, state) {
  renderToday(root, state);
  renderStats(root, state);
  renderCalendar(root, state);
  root.getElementById('footer').textContent =
    `${state.data.since}부터 기록 · 매시간 자동 확인 · 마지막 확인일 ${state.data.lastCheckedDate ?? '-'}`;
}

export function renderError(root) {
  root.getElementById('today').innerHTML = '<div class="label">데이터를 불러오지 못했어요.</div>';
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
    renderAll(root, state);
    return state;
  } catch {
    renderError(root);
    return null;
  }
}
