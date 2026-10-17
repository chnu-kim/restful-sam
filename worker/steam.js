// 삼덕이 Steam 프로필을 KST 날짜마다 한 번 찍어 D1에 쌓고, 직전 스냅샷과 비교해 방송 시간보다 많이 늘어난 플레이 시간을 로그로 남긴다.
// 사이트에는 내보내지 않는다. 부수효과(fetch, 현재 시각)는 주입받는다
import { FETCH_TIMEOUT_MS, USER_AGENT, parseKst, todayKst } from './collect.js';
import { loadDoc } from './run.js';

export const PROFILE_URL = 'https://steamcommunity.com/id/nunsister/?xml=1';
// 매분 D1을 읽지 않도록 10분에 한 번만 오늘 스냅샷이 있는지 본다. 한 번 실패해도 10분 뒤 다시 찍는다
export const STEAM_EVERY_MIN = 10;
// hoursOnRecord는 100시간이 넘으면 정수로만 나오고, 방송 중 플레이도 똑같이 늘어나므로 방송 시간 + 1시간까지는 넘긴다
export const SLACK_HOURS = 1;

const HOUR_MS = 60 * 60 * 1000;
const round1 = (n) => Math.round(n * 10) / 10;
const tag = (xml, name) => xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1];

// Workers에는 DOMParser가 없어 정규식으로 읽는다. mostPlayedGames에는 최근 2주 안에 플레이한 게임만 나온다
export function parseProfile(xml) {
  if (!tag(xml, 'steamID64')) throw new Error(`Steam 프로필 응답 이상: ${xml.slice(0, 300)}`);
  const games = {};
  for (const [, block] of xml.matchAll(/<mostPlayedGame>([\s\S]*?)<\/mostPlayedGame>/g)) {
    const name = tag(block, 'gameName');
    const hours = Number(tag(block, 'hoursOnRecord')?.replace(/,/g, ''));
    if (name && Number.isFinite(hours)) games[name] = hours;
  }
  return { privacy: tag(xml, 'privacyState'), onlineState: tag(xml, 'onlineState'), games };
}

// 게임별로 늘어난 시간. 직전 목록에 없던 게임은 기준이 없어 시간을 알 수 없으니 이름만 모은다
// (직전에 있다가 빠진 게임은 2주 넘게 안 한 것이라 무시한다)
export function diffGames(prev, curr) {
  const played = {};
  const firstSeen = [];
  for (const [name, hours] of Object.entries(curr)) {
    if (!(name in prev)) firstSeen.push(name);
    else if (hours > prev[name]) played[name] = round1(hours - prev[name]);
  }
  return { played, firstSeen };
}

// [from, to] 구간에 걸친 방송 시간(시간 단위). 자정을 넘긴 방송, 진행 중인 방송도 구간 안쪽만 센다
export function streamedHours(streams, from, to) {
  let ms = 0;
  for (const s of streams) {
    const start = Math.max(parseKst(s.openDate), from);
    const end = Math.min(s.closeDate ? parseKst(s.closeDate) : to, to);
    if (end > start) ms += end - start;
  }
  return ms / HOUR_MS;
}

export async function watchSteam(env, { fetchImpl = fetch, now = Date.now(), log = console.log, warn = console.warn } = {}) {
  if (Math.floor(now / 60000) % STEAM_EVERY_MIN !== 0) return null;
  const date = todayKst(now);
  if (await env.DB.prepare('SELECT 1 FROM steam_snapshots WHERE date = ?').bind(date).first()) return null;

  const res = await fetchImpl(PROFILE_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Steam 프로필 HTTP ${res.status}`);
  const profile = parseProfile(await res.text());
  // 비공개로 바뀌면 게임 목록이 비어 다음 비교가 어긋나므로 찍지 않는다
  if (profile.privacy !== 'public') {
    warn(JSON.stringify({ message: 'Steam 프로필이 공개가 아닙니다', privacy: profile.privacy }));
    return null;
  }

  const takenAt = new Date(now).toISOString();
  const prev = await env.DB.prepare('SELECT taken_at, games FROM steam_snapshots ORDER BY date DESC LIMIT 1').first();
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO steam_snapshots (date, taken_at, games) VALUES (?, ?, ?)')
    .bind(date, takenAt, JSON.stringify(profile.games))
    .run();
  // 그 사이 다른 실행이 먼저 찍었다
  if (inserted.meta.changes !== 1) return null;
  if (!prev) {
    log(JSON.stringify({ message: 'Steam 첫 스냅샷', date, games: profile.games }));
    return { date, games: profile.games };
  }

  // 실패한 날이 있으면 구간이 하루보다 길어지므로 어제가 아니라 직전 스냅샷 시각부터 센다
  const { played, firstSeen } = diffGames(JSON.parse(prev.games), profile.games);
  const doc = await loadDoc(env.DB);
  const streamed = round1(streamedHours(doc?.data.streams ?? [], Date.parse(prev.taken_at), now));
  const steamHours = round1(Object.values(played).reduce((a, b) => a + b, 0));
  const offStream = steamHours > streamed + SLACK_HOURS || (firstSeen.length > 0 && streamed === 0);
  const result = { date, from: prev.taken_at, to: takenAt, played, firstSeen, steamHours, streamedHours: streamed, offStream };
  // 대시보드에서 "방송 밖 플레이"로 검색할 수 있게 메시지를 나눈다
  log(JSON.stringify({ message: offStream ? 'Steam 방송 밖 플레이' : 'Steam 스냅샷', ...result, onlineState: profile.onlineState }));
  return result;
}
