// Cloudflare Worker: 정적 페이지와 방송 기록(/data/streams.json)을 내보내고, 1분마다 방송 상태를 수집해 D1에 저장한다.
import { applyLiveStatus, backfillFromReplays, fetchLiveStatus, todayKst, validateData } from './collect.js';

const DOC_KEY = 'streams';
// 다시보기 보충은 보조 수단이라 10분에 한 번만 한다 (비공식 API 호출을 줄이려고)
export const BACKFILL_EVERY_MIN = 10;

// 저장된 원문(raw)도 함께 돌려줘, 저장할 때 그 사이 다른 실행이 바꿨는지 비교한다
export async function loadDoc(db) {
  const row = await db.prepare('SELECT value FROM docs WHERE key = ?').bind(DOC_KEY).first();
  return row ? { raw: row.value, data: validateData(JSON.parse(row.value)) } : null;
}

// 읽은 뒤 바뀌지 않았을 때만 쓴다 (1분 cron이 겹쳐 옛 결과가 새 결과를 덮어쓰지 않도록). 썼으면 true
export async function saveDoc(db, doc, prevRaw) {
  const res = await db
    .prepare('UPDATE docs SET value = ? WHERE key = ? AND value = ?')
    .bind(JSON.stringify(doc), DOC_KEY, prevRaw)
    .run();
  return res.meta.changes === 1;
}

// 한 번의 수집. 조회를 먼저 해서 실패하면 저장된 기록을 건드리지 않고, 바뀐 게 있을 때만 쓴다.
// 기록이 없으면 빈 기록을 새로 만들지 않는다 (D1을 잘못 비웠을 때 지난 기록을 덮어쓰고 백업까지 번지지 않도록 시드가 먼저다)
export async function collect(env, { fetchImpl = fetch, now = Date.now(), serviceBase, log = console.log, warn = console.warn } = {}) {
  const today = todayKst(now);
  const live = await fetchLiveStatus(fetchImpl);
  const doc = await loadDoc(env.DB);
  if (!doc) throw new Error('D1에 방송 기록이 없습니다. data/streams.json으로 먼저 시드하세요');
  let next = applyLiveStatus(doc.data, live, today, new Date(now).toISOString());
  if (Math.floor(now / 60000) % BACKFILL_EVERY_MIN === 0) {
    try {
      next = await backfillFromReplays(next, { fetchImpl, serviceBase });
    } catch (e) {
      // 보충은 부가 기능이라 실패해도 live-status 결과는 저장한다
      warn(`다시보기 보충 실패: ${e.message}`);
    }
  }
  let changed = JSON.stringify(next) !== doc.raw;
  if (changed && !(await saveDoc(env.DB, next, doc.raw))) {
    warn('그 사이 다른 실행이 기록을 바꿔 이번 결과는 저장하지 않습니다');
    changed = false;
  }
  log(`${changed ? '갱신됨' : '변경 없음'}: status=${live.status}, openDate=${live.openDate}`);
  return { changed, data: next };
}

const json = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/data/streams.json') {
      const doc = await loadDoc(env.DB);
      return doc ? json(doc.raw) : json('{"error":"no data"}', 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env, { now: event.scheduledTime }));
  },
};
