// Cloudflare Worker 진입 파일: 정적 페이지와 방송 기록(/data/streams.json)을 내보내고, 1분마다 방송 상태를 수집해 D1에 저장한다.
// 하루 한 번 Steam 프로필 스냅샷도 찍는다.
// 런타임은 이 파일의 export를 모두 핸들러로 보므로 default 외에는 export하지 않는다
import { collect, loadDoc } from './run.js';
import { watchSteam } from './steam.js';

// Worker가 먼저 처리하는 응답에는 public/_headers가 붙지 않으므로 nosniff를 직접 단다
const json = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

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
    // Steam 감시는 부가 기능이라 실패해도 방송 수집과 섞이지 않게 따로 잡는다
    ctx.waitUntil(
      watchSteam(env, { now: event.scheduledTime }).catch((e) => console.warn(JSON.stringify({ message: 'Steam 감시 실패', error: e.message }))),
    );
  },
};
