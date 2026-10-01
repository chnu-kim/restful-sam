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

// 지난 날 aria-label에 읽어 줄 방송 시간대: 그날 첫 시작 ~ 마지막 종료. 끝나지 않은 방송이 있으면 지어내지 않고 null
export function dayTimeRange(streams) {
  if (!streams?.length || streams.some((s) => !s.closeDate)) return null;
  const close = streams.map((s) => s.closeDate).sort().at(-1);
  return { open: hm(streams[0].openDate), close: hm(close) };
}

// 분 단위로 자른 시각끼리 빼서, 화면에 보이는 시작~종료와 방송 시간이 어긋나지 않게 한다
const toMinutes = (dt) => Date.parse(dt.slice(0, 16).replace(' ', 'T') + 'Z') / 60000;
export const streamMinutes = (s) => (s.closeDate ? toMinutes(s.closeDate) - toMinutes(s.openDate) : null);

// 그날 방송 시간의 합(분). 끝나지 않은 방송이 있으면 null
export function dayMinutes(streams) {
  if (!streams?.length || streams.some((s) => !s.closeDate)) return null;
  return streams.reduce((sum, s) => sum + streamMinutes(s), 0);
}

// 달력 칸을 아래부터 채울 높이(%). 칸 전체가 하루(24시간)이고, 아주 짧은 방송도 보이도록 최소 높이를 둔다
export const DAY_MINUTES = 24 * 60;
export const fillPercent = (m) => Math.max(3, Math.min(100, Math.round((m / DAY_MINUTES) * 100)));

// 상세용 '8시간 22분'
export function durationLong(m) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return [h && `${h}시간`, r && `${r}분`].filter(Boolean).join(' ') || '0분';
}

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

// 판정 컨텍스트. checkedDays는 수집기가 한 번이라도 성공한 날짜 목록이다
export function makeContext(data, today) {
  const checkedDays = data.checkedDays ?? [];
  return {
    byDay: groupByDay(data.streams),
    since: data.since,
    today,
    checked: new Set(checkedDays),
    // 수집기 가동 전 날짜는 사용자가 직접 확인해 넣은 기록이라 확정으로 본다
    firstChecked: checkedDays[0] ?? '9999-12-31',
  };
}

// d의 마지막 방송은 d+1 첫 수집에서 잡히므로, d+1에 수집이 있었거나 수집기 가동 전이면 확정이다
export const isFinal = (d, ctx) => d < ctx.firstChecked || ctx.checked.has(addDays(d, 1));

// on: 방송 / off: 휴방 / pending: 오늘인데 아직 방송 없음 / unknown: 지난 날인데 아직 확인 안 됨
// nodata: 기록 시작 전 / future: 미래
export function dayStatus(d, ctx) {
  if (ctx.byDay.has(d)) return 'on';
  if (d > ctx.today) return 'future';
  if (d < ctx.since) return 'nodata';
  if (d === ctx.today) return 'pending';
  return isFinal(d, ctx) ? 'off' : 'unknown';
}

// ym 달(기본: 오늘이 속한 달)의 1일부터 말일 또는 오늘까지의 방송·휴방 일수. 휴방률은 판정된 날이 없으면 null
// 기록 시작 전 날짜는 방송 기록이 있어도 세지 않는다 (휴방 여부를 모르는 날과 같은 기준으로 맞춤)
export function computeStats(ctx, ym = ctx.today.slice(0, 7)) {
  let on = 0;
  let off = 0;
  for (const d of monthDays(ym)) {
    if (d > ctx.today) break;
    if (d < ctx.since) continue;
    const s = dayStatus(d, ctx);
    if (s === 'on') on++;
    else if (s === 'off') off++;
  }
  const offRate = on + off ? Math.round((off / (on + off)) * 100) : null;
  return { on, off, offRate, ...currentStreak(ctx) };
}

// 가장 최근에 판정된 날부터 거슬러 올라가며 같은 상태가 이어진 일수를 센다 (오늘 미정·미확인인 날은 건너뜀)
export function currentStreak(ctx) {
  let d = ctx.today;
  while (['pending', 'unknown'].includes(dayStatus(d, ctx))) d = addDays(d, -1);
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

// 통계 라벨용 월 표기. 올해가 아니면 연도를 붙인다
export function monthLabel(ym, today) {
  const [y, m] = ym.split('-').map(Number);
  return ym.slice(0, 4) === today.slice(0, 4) ? `${m}월` : `${y}년 ${m}월`;
}
