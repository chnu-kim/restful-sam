// 치지직 live-status 수집 로직 (Cloudflare Worker에서 1분마다 실행). 부수효과(fetch, 현재 시각)는 주입받는다.

export const CHANNEL_ID = '86d3d8d5997609df783949d107fbde24';
export const DEFAULT_API_URL = `https://api.chzzk.naver.com/polling/v2/channels/${CHANNEL_ID}/live-status`;
// 다시보기 보충용
export const DEFAULT_SERVICE_BASE = 'https://api.chzzk.naver.com/service';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const KST_OFFSET = 9 * 60 * 60 * 1000;

export function todayKst(now = Date.now()) {
  return new Date(now + KST_OFFSET).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD HH:MM:SS'(KST) <-> epoch ms
export const parseKst = (s) => Date.parse(s.replace(' ', 'T') + '+09:00');
export const formatKst = (ms) => new Date(ms + KST_OFFSET).toISOString().slice(0, 19).replace('T', ' ');
// 비공식 API의 시각이 위 형식인지 확인한다. Date.parse는 2월 30일·24시를 다음 날로 넘겨 받아 주므로,
// 다시 형식화한 값이 원래 문자열과 같은지 비교해 없는 날짜까지 거른다
const KST_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const roundTrips = (s, t) => !Number.isNaN(t) && formatKst(t) === s;
export const isKst = (s) => typeof s === 'string' && KST_RE.test(s) && roundTrips(s, parseKst(s));

// 치지직이 응답 없이 멈춰도 실행이 15분(cron 한도)까지 붙잡혀 1분 수집이 쌓이지 않도록 끊는다
export const FETCH_TIMEOUT_MS = 10_000;

async function fetchContent(fetchImpl, url, name) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 200 || !body.content) {
    throw new Error(`${name} 응답 이상: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.content;
}

export function fetchLiveStatus(fetchImpl = fetch, url = DEFAULT_API_URL) {
  return fetchContent(fetchImpl, url, 'live-status');
}

export function emptyData(today) {
  return { channelId: CHANNEL_ID, since: today, checkedDays: [], live: false, streams: [] };
}

// 저장된 문서가 수집 결과로 덮어써도 되는 형식인지 확인한다. 깨진 데이터는 덮어쓰지 않도록 throw한다
export function validateData(data) {
  if (!data || !Array.isArray(data.streams) || typeof data.since !== 'string') {
    throw new Error('streams 문서 형식이 올바르지 않습니다');
  }
  return data;
}

// 예전 형식(lastCheckedDate)을 checkedDays로 옮긴다
function normalize(data) {
  const { lastCheckedDate, ...rest } = data;
  const checkedDays = data.checkedDays ?? (lastCheckedDate ? [lastCheckedDate] : []);
  return { ...rest, checkedDays: [...checkedDays] };
}

const sortStreams = (streams) => streams.sort((a, b) => a.openDate.localeCompare(b.openDate));

// 방송 중에 카테고리를 바꾸면 언제부터 무엇을 했는지(categories: [{ from, category }]) 남긴다.
// 바뀐 적이 없으면 남기지 않고, 처음 바뀔 때 '시작부터 직전 카테고리'를 첫 구간으로 채운다. at: 바뀐 걸 확인한 시각(KST)
function categoryHistory(prev, stream, at) {
  if (!prev) return undefined;
  const history = prev.categories ?? [{ from: prev.openDate, category: prev.category }];
  if (history.at(-1).category === stream.category) return prev.categories;
  return [...history, { from: at, category: stream.category }];
}

// checkedAt: 이번 수집 시각(ISO). 방송 중일 때만 남겨 페이지가 live 값의 신선도를 판단하게 한다.
// 방송 중인 방송에는 마지막으로 방송 중인 걸 본 시각(seenAt, KST)을 남겨, 종료를 놓쳤을 때 종료 시각 추정에 쓴다
export function applyLiveStatus(data, live, today, checkedAt = null) {
  // 형식이 바뀌면 정렬·같은 방송 비교가 조용히 어긋나므로, 조회 실패처럼 throw해 아무것도 저장하지 않는다
  for (const field of ['openDate', 'closeDate']) {
    if (live[field] != null && !isKst(live[field])) throw new Error(`live-status ${field} 형식 이상: ${JSON.stringify(live[field])}`);
  }
  const isLive = live.status === 'OPEN';
  const { liveCheckedAt, ...rest } = normalize(data);
  const next = { ...rest, live: isLive, streams: [...data.streams] };
  if (isLive && checkedAt) next.liveCheckedAt = checkedAt;
  // 수집에 성공한 날을 남긴다. d의 휴방은 d+1에 수집이 있어야 확정된다
  if (!next.checkedDays.includes(today)) next.checkedDays.push(today);

  if (live.openDate) {
    const stream = {
      openDate: live.openDate,
      closeDate: isLive ? null : live.closeDate ?? null,
      title: live.liveTitle ?? '',
      category: live.liveCategoryValue || null,
    };
    if (isLive && checkedAt) stream.seenAt = formatKst(Date.parse(checkedAt));
    const idx = next.streams.findIndex((s) => s.openDate === stream.openDate);
    // 방송 중이면 이번 확인 시각, 끝난 뒤 처음 확인이면(마지막 확인과 종료 사이에 바뀜) 종료 시각부터로 본다
    const changedAt = stream.seenAt ?? stream.closeDate ?? formatKst(Date.parse(checkedAt ?? '') || Date.now());
    const categories = categoryHistory(next.streams[idx], stream, changedAt);
    if (categories) stream.categories = categories;
    if (idx === -1) next.streams.push(stream);
    else next.streams[idx] = stream;
    // live-status는 마지막 방송만 알려준다. 그보다 먼저 시작해 아직 열려 있는 방송은 두 확인 사이에 끝난 것이다.
    // 마지막으로 본 시각(seenAt)을 종료 시각으로 추정(closeApprox)하고, 본 기록이 없으면 끝났다고(ended)만 표시한다.
    // 다시보기가 남아 있으면 보충에서 정확한 값으로 고친다
    next.streams = next.streams.map((s) => {
      if (s.closeDate || s.ended || s.openDate >= stream.openDate) return s;
      const { seenAt, ...other } = s;
      return seenAt ? { ...other, closeDate: seenAt, closeApprox: true } : { ...other, ended: true };
    });
    sortStreams(next.streams);
  }
  return next;
}

const MATCH_WINDOW_MS = 30 * 60 * 1000;
// 상세의 시작 시각과 저장된 시작 시각이 이만큼 이내면 같은 방송으로 본다 (API 간 초 단위 차이 허용).
// 끊겼다 다시 켠 방송을 구분해야 해서 위 추정 범위보다 훨씬 좁게 둔다
const SAME_STREAM_MS = 2 * 60 * 1000;
const closest = (times, t) =>
  times.filter((x) => Math.abs(x - t) <= SAME_STREAM_MS).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
export const MAX_DETAIL_CALLS = 3;
// 다시보기 길이와 기록된 방송 길이가 이만큼 이내면 같은 방송의 다시보기로 본다
const SAME_DURATION_MS = 5 * 60 * 1000;

// 종료 시각이 정확하지 않은 방송: 끝났는데 종료 시각을 모르거나(ended) 추정값(closeApprox)인 방송
const needsClose = (s) => (s.ended && !s.closeDate) || s.closeApprox;

// 다시보기는 남지 않을 수도 있어 보조 수단이다. 있으면 놓친 방송을 추가하고, 종료 시각이 정확하지 않은 방송을 고친다.
// 시작 시각 추정(올린 시각 - 길이)이 아는 방송과 ±30분 이내이고 길이도 비슷하면 같은 방송으로 보고 건너뛴다.
// 그 외(길이가 다르거나 아는 방송이 아직 열려 있거나 고칠 방송 근처)는 상세의 정확한 시작 시각으로 판단한다
export async function backfillFromReplays(data, { fetchImpl = fetch, serviceBase = DEFAULT_SERVICE_BASE } = {}) {
  const list = await fetchContent(
    fetchImpl,
    `${serviceBase}/v1/channels/${CHANNEL_ID}/videos?sortType=LATEST&pagingType=PAGE&page=0&size=10`,
    'videos',
  );
  const span = (s) => (s.closeDate && !needsClose(s) ? parseKst(s.closeDate) - parseKst(s.openDate) : null);
  const known = data.streams.map((s) => ({ t: parseKst(s.openDate), span: span(s) }));
  const pending = data.streams.filter(needsClose).map((s) => parseKst(s.openDate));
  const added = [];
  const closed = new Map(); // 저장된 시작 시각(ms) -> 채울 종료 시각
  let calls = 0;
  for (const v of list.data ?? []) {
    // 보충은 부가 기능이라 형식이 이상한 영상은 상세 조회 없이 건너뛴다
    if (v.videoType !== 'REPLAY' || !isKst(v.publishDate) || !(Number.isFinite(v.duration) && v.duration > 0)) continue;
    const estimated = parseKst(v.publishDate) - v.duration * 1000;
    const near = (t) => Math.abs(t - estimated) <= MATCH_WINDOW_MS;
    const sameKnown = known.some((k) => near(k.t) && k.span !== null && Math.abs(k.span - v.duration * 1000) <= SAME_DURATION_MS);
    if (sameKnown && !pending.some(near)) continue;
    if (calls >= MAX_DETAIL_CALLS) break;
    calls++;
    const detail = await fetchContent(fetchImpl, `${serviceBase}/v3/videos/${v.videoNo}`, 'video');
    const openDate = detail.liveOpenDate;
    if (!isKst(openDate)) continue;
    const closeDate = formatKst(parseKst(openDate) + v.duration * 1000);
    const t = parseKst(openDate);
    const match = closest(pending, t);
    if (match !== undefined) {
      closed.set(match, closeDate);
      pending.splice(pending.indexOf(match), 1);
      continue;
    }
    if (closest(known.map((k) => k.t), t) !== undefined) continue;
    added.push({ openDate, closeDate, title: v.videoTitle ?? '', category: v.videoCategoryValue || null });
    known.push({ t, span: v.duration * 1000 });
  }
  if (!added.length && !closed.size) return data;
  const streams = data.streams.map((s) => {
    const closeDate = closed.get(parseKst(s.openDate));
    if (!closeDate) return s;
    const { ended, closeApprox, seenAt, ...rest } = s;
    return { ...rest, closeDate };
  });
  return { ...data, streams: sortStreams([...streams, ...added]) };
}
