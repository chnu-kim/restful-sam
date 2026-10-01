// 치지직 live-status 수집 로직. 부수효과(fetch, 파일 IO, 현재 시각)는 모두 주입받는다.
import { readFile, writeFile } from 'node:fs/promises';

export const CHANNEL_ID = '86d3d8d5997609df783949d107fbde24';
export const DEFAULT_API_URL = `https://api.chzzk.naver.com/polling/v2/channels/${CHANNEL_ID}/live-status`;
export const DEFAULT_DATA_PATH = new URL('../data/streams.json', import.meta.url);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export function todayKst(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function fetchLiveStatus(fetchImpl = fetch, url = DEFAULT_API_URL) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`live-status HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 200 || !body.content) {
    throw new Error(`live-status 응답 이상: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.content;
}

export function emptyData(today) {
  return { channelId: CHANNEL_ID, since: today, lastCheckedDate: null, live: false, streams: [] };
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

export function applyLiveStatus(data, live, today) {
  const isLive = live.status === 'OPEN';
  const next = {
    ...data,
    live: isLive,
    // 하루 한 번은 값이 바뀌어 커밋이 생기게 한다 (public 저장소 schedule 60일 비활성 중지 방지)
    lastCheckedDate: today,
    streams: [...data.streams],
  };

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
    next.streams.sort((a, b) => a.openDate.localeCompare(b.openDate));
  }
  return next;
}

export async function run({
  fetchImpl = fetch,
  apiUrl = DEFAULT_API_URL,
  dataPath = DEFAULT_DATA_PATH,
  now = Date.now(),
  log = console.log,
} = {}) {
  const today = todayKst(now);
  // 조회를 먼저 해서, 실패하면 파일을 건드리지 않는다
  const live = await fetchLiveStatus(fetchImpl, apiUrl);
  const data = await loadData(dataPath, today);
  const next = applyLiveStatus(data, live, today);
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  if (changed) await writeFile(dataPath, JSON.stringify(next, null, 2) + '\n');
  log(`${changed ? '갱신됨' : '변경 없음'}: status=${live.status}, openDate=${live.openDate}`);
  return { changed, data: next };
}
