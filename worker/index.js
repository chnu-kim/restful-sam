// Cloudflare Worker 진입 파일: 정적 페이지와 방송 기록(/data/streams.json)을 내보내고, 1분마다 방송 상태를 수집해 D1에 저장한다.
// 런타임은 이 파일의 export를 모두 핸들러로 보므로 default 외에는 export하지 않는다
import { collect, loadDoc } from './run.js';

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
  },
};
