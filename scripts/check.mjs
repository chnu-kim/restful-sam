// 치지직 live-status를 조회해 data/streams.json에 방송 기록을 누적한다.
// live-status는 "마지막 방송"의 openDate/closeDate(KST)를 주므로, 주기적으로 호출만 하면 짧은 방송도 놓치지 않는다.
import { readFile, writeFile } from 'node:fs/promises';

const CHANNEL_ID = '86d3d8d5997609df783949d107fbde24';
const DATA_PATH = new URL('../data/streams.json', import.meta.url);
const API_URL = `https://api.chzzk.naver.com/polling/v2/channels/${CHANNEL_ID}/live-status`;

const todayKst = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function fetchLiveStatus() {
  const res = await fetch(API_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`live-status HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 200 || !body.content) throw new Error(`live-status 응답 이상: ${JSON.stringify(body).slice(0, 300)}`);
  return body.content;
}

async function loadData() {
  try {
    return JSON.parse(await readFile(DATA_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { channelId: CHANNEL_ID, since: todayKst(), lastCheckedDate: null, live: false, streams: [] };
  }
}

const live = await fetchLiveStatus();
const data = await loadData();
const before = JSON.stringify(data);

const isLive = live.status === 'OPEN';
data.live = isLive;
// 하루 한 번은 값이 바뀌어 커밋이 생기게 한다 (public 저장소 schedule 60일 비활성 중지 방지)
data.lastCheckedDate = todayKst();

if (live.openDate) {
  const stream = {
    openDate: live.openDate,
    closeDate: isLive ? null : live.closeDate,
    title: live.liveTitle,
    category: live.liveCategoryValue || null,
  };
  const idx = data.streams.findIndex((s) => s.openDate === stream.openDate);
  if (idx === -1) data.streams.push(stream);
  else data.streams[idx] = stream;
  data.streams.sort((a, b) => a.openDate.localeCompare(b.openDate));
}

const after = JSON.stringify(data);
if (after !== before) {
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`갱신됨: status=${live.status}, openDate=${live.openDate}`);
} else {
  console.log(`변경 없음: status=${live.status}, openDate=${live.openDate}`);
}
