// 방송 기록으로부터 날짜별 상태와 통계를 계산하는 순수 함수 모음. 날짜는 모두 KST 'YYYY-MM-DD' 문자열.

export const DOW = ['일', '월', '화', '수', '목', '금', '토'];

export const todayKst = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);

export const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

export const dayOfWeek = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

export const hm = (dt) => (dt ? dt.slice(11, 16) : '');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 방송은 시작일 기준으로 그 날짜에 속한다
export function groupByDay(streams) {
  const byDay = new Map();
  for (const s of streams) {
    const d = s.openDate.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  return byDay;
}

// on: 방송 / off: 휴방 / pending: 오늘인데 아직 방송 없음 / nodata: 기록 시작 전 / future: 미래
export function dayStatus(d, { byDay, since, today }) {
  if (byDay.has(d)) return 'on';
  if (d > today) return 'future';
  if (d < since) return 'nodata';
  if (d === today) return 'pending';
  return 'off';
}

// 이번 달(오늘이 속한 달) 1일부터 오늘까지의 방송·휴방 일수. 휴방률은 판정된 날이 없으면 null
// 기록 시작 전 날짜는 방송 기록이 있어도 세지 않는다 (휴방 여부를 모르는 날과 같은 기준으로 맞춤)
export function computeStats(ctx) {
  let on = 0;
  let off = 0;
  for (const d of monthDays(ctx.today.slice(0, 7))) {
    if (d > ctx.today) break;
    if (d < ctx.since) continue;
    const s = dayStatus(d, ctx);
    if (s === 'on') on++;
    else if (s === 'off') off++;
  }
  const offRate = on + off ? Math.round((off / (on + off)) * 100) : null;
  return { on, off, offRate, ...currentStreak(ctx) };
}

// 오늘이 미정이면 어제부터 거슬러 올라가며 같은 상태가 이어진 일수를 센다
export function currentStreak(ctx) {
  let d = dayStatus(ctx.today, ctx) === 'pending' ? addDays(ctx.today, -1) : ctx.today;
  const kind = dayStatus(d, ctx);
  if (kind !== 'on' && kind !== 'off') return { streak: 0, streakKind: null };
  let streak = 0;
  while (dayStatus(d, ctx) === kind) {
    streak++;
    d = addDays(d, -1);
  }
  return { streak, streakKind: kind };
}

// 달력에서 이동 가능한 첫 달: 기록 시작일과 가장 오래된 방송 중 더 이른 쪽
export function firstMonth(data) {
  const first = data.streams[0]?.openDate ?? data.since;
  return (first < data.since ? first : data.since).slice(0, 7);
}

export function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
}
