// 치지직 live-status 수집 로직. 부수효과(fetch, 파일 IO, 현재 시각)는 모두 주입받는다.
import { readFile, writeFile } from 'node:fs/promises';

export const CHANNEL_ID = '86d3d8d5997609df783949d107fbde24';
export const DEFAULT_API_URL = `https://api.chzzk.naver.com/polling/v2/channels/${CHANNEL_ID}/live-status`;
// 다시보기 보충용 (CHZZK_SERVICE_BASE로 교체 가능)
export const DEFAULT_SERVICE_BASE = 'https://api.chzzk.naver.com/service';
export const DEFAULT_DATA_PATH = new URL('../data/streams.json', import.meta.url);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const KST_OFFSET = 9 * 60 * 60 * 1000;

export function todayKst(now = Date.now()) {
  return new Date(now + KST_OFFSET).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD HH:MM:SS'(KST) <-> epoch ms
export const parseKst = (s) => Date.parse(s.replace(' ', 'T') + '+09:00');
export const formatKst = (ms) => new Date(ms + KST_OFFSET).toISOString().slice(0, 19).replace('T', ' ');

async function fetchContent(fetchImpl, url, name) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
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

// 파일이 없을 때만 새로 만든다. 깨진 JSON은 덮어쓰지 않도록 그대로 throw한다.
export async function loadData(path, today) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return emptyData(today);
  }
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.streams) || typeof data.since !== 'string') {
    throw new Error('streams.json 형식이 올바르지 않습니다');
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

export function applyLiveStatus(data, live, today) {
  const isLive = live.status === 'OPEN';
  const next = { ...normalize(data), live: isLive, streams: [...data.streams] };
  // 수집에 성공한 날을 남긴다. d의 휴방은 d+1에 수집이 있어야 확정된다 (하루 한 번 커밋도 생겨 schedule 비활성 중지 방지)
  if (!next.checkedDays.includes(today)) next.checkedDays.push(today);

  if (live.openDate) {
    const stream = {
      openDate: live.openDate,
      closeDate: isLive ? null : live.closeDate ?? null,
      title: live.liveTitle ?? '',
      category: live.liveCategoryValue || null,
    };
    const idx = next.streams.findIndex((s) => s.openDate === stream.openDate);
    if (idx === -1) next.streams.push(stream);
    else next.streams[idx] = stream;
    sortStreams(next.streams);
  }
  return next;
}

const MATCH_WINDOW_MS = 30 * 60 * 1000;
export const MAX_DETAIL_CALLS = 3;

// live-status는 마지막 방송만 알려주므로, 수집이 하루 이상 멈춘 사이의 방송은 다시보기로 보충한다.
// 이미 아는 방송(추정 시작 시각 ±30분)은 건너뛰고, 새로 넣기만 하며 기존 항목은 덮어쓰지 않는다.
export async function backfillFromReplays(data, { fetchImpl = fetch, serviceBase = DEFAULT_SERVICE_BASE } = {}) {
  const list = await fetchContent(
    fetchImpl,
    `${serviceBase}/v1/channels/${CHANNEL_ID}/videos?sortType=LATEST&pagingType=PAGE&page=0&size=10`,
    'videos',
  );
  const known = data.streams.map((s) => parseKst(s.openDate));
  const added = [];
  let calls = 0;
  for (const v of list.data ?? []) {
    if (v.videoType !== 'REPLAY' || !v.publishDate || !v.duration) continue;
    const estimated = parseKst(v.publishDate) - v.duration * 1000;
    if (known.some((t) => Math.abs(t - estimated) <= MATCH_WINDOW_MS)) continue;
    if (calls >= MAX_DETAIL_CALLS) break;
    calls++;
    const detail = await fetchContent(fetchImpl, `${serviceBase}/v3/videos/${v.videoNo}`, 'video');
    const openDate = detail.liveOpenDate;
    if (!openDate || known.includes(parseKst(openDate))) continue;
    added.push({
      openDate,
      closeDate: formatKst(parseKst(openDate) + v.duration * 1000),
      title: v.videoTitle ?? '',
      category: v.videoCategoryValue || null,
    });
    known.push(parseKst(openDate));
  }
  if (!added.length) return data;
  return { ...data, streams: sortStreams([...data.streams, ...added]) };
}

export async function run({
  fetchImpl = fetch,
  apiUrl = DEFAULT_API_URL,
  serviceBase = DEFAULT_SERVICE_BASE,
  dataPath = DEFAULT_DATA_PATH,
  now = Date.now(),
  log = console.log,
  warn = console.warn,
} = {}) {
  const today = todayKst(now);
  // 조회를 먼저 해서, 실패하면 파일을 건드리지 않는다
  const live = await fetchLiveStatus(fetchImpl, apiUrl);
  const data = await loadData(dataPath, today);
  let next = applyLiveStatus(data, live, today);
  try {
    next = await backfillFromReplays(next, { fetchImpl, serviceBase });
  } catch (e) {
    // 보충은 부가 기능이라 실패해도 live-status 결과는 저장한다
    warn(`다시보기 보충 실패: ${e.message}`);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  if (changed) await writeFile(dataPath, JSON.stringify(next, null, 2) + '\n');
  log(`${changed ? '갱신됨' : '변경 없음'}: status=${live.status}, openDate=${live.openDate}`);
  return { changed, data: next };
}
