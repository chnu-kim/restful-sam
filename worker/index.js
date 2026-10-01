// Cloudflare Worker: 정적 페이지와 방송 기록(/data/streams.json)을 내보내고, 1분마다 방송 상태를 수집해 D1에 저장한다.
import { applyLiveStatus, backfillFromReplays, emptyData, fetchLiveStatus, todayKst, validateData } from './collect.js';

const DOC_KEY = 'streams';
// 다시보기 보충은 보조 수단이라 10분에 한 번만 한다 (비공식 API 호출을 줄이려고)
export const BACKFILL_EVERY_MIN = 10;

export async function loadDoc(db) {
  const row = await db.prepare('SELECT value FROM docs WHERE key = ?').bind(DOC_KEY).first();
  return row ? validateData(JSON.parse(row.value)) : null;
}

export async function saveDoc(db, doc) {
  await db
    .prepare('INSERT INTO docs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(DOC_KEY, JSON.stringify(doc))
    .run();
}

// 한 번의 수집. 조회를 먼저 해서 실패하면 저장된 기록을 건드리지 않고, 바뀐 게 있을 때만 쓴다
export async function collect(env, { fetchImpl = fetch, now = Date.now(), serviceBase, log = console.log, warn = console.warn } = {}) {
  const today = todayKst(now);
  const live = await fetchLiveStatus(fetchImpl);
  const data = (await loadDoc(env.DB)) ?? emptyData(today);
  let next = applyLiveStatus(data, live, today, new Date(now).toISOString());
  if (Math.floor(now / 60000) % BACKFILL_EVERY_MIN === 0) {
    try {
      next = await backfillFromReplays(next, { fetchImpl, serviceBase });
    } catch (e) {
      // 보충은 부가 기능이라 실패해도 live-status 결과는 저장한다
      warn(`다시보기 보충 실패: ${e.message}`);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  if (changed) await saveDoc(env.DB, next);
  log(`${changed ? '갱신됨' : '변경 없음'}: status=${live.status}, openDate=${live.openDate}`);
  return { changed, data: next };
}

const json = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/data/streams.json') {
      const doc = await loadDoc(env.DB);
      return doc ? json(JSON.stringify(doc)) : json('{"error":"no data"}', 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env, { now: event.scheduledTime }));
  },
};
