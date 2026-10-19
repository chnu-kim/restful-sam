// Cloudflare Worker 진입 파일: 정적 페이지와 방송 기록(/data/streams.json)을 내보내고, 1분마다 방송 상태를 수집해 D1에 저장한다.
// 첫 페이지(/)에는 링크 카드 메타를 넣고, 카드 이미지(/og.png)는 수집 뒤 내용이 바뀌었을 때 다시 찍는다. 하루 한 번 Steam 프로필 스냅샷도 찍는다.
// 런타임은 이 파일의 export를 모두 핸들러로 보므로 default 외에는 export하지 않는다
import { updateCard } from './card.js';
import { serveCardImage, servePage } from './page.js';
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
    const { pathname } = new URL(request.url);
    if (pathname === '/data/streams.json') {
      const doc = await loadDoc(env.DB);
      return doc ? json(doc.raw) : json('{"error":"no data"}', 404);
    }
    if (pathname === '/' && request.method === 'GET') return servePage(request, env);
    if (pathname === '/og.png') return serveCardImage(env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const collected = collect(env, { now: event.scheduledTime });
    ctx.waitUntil(collected);
    // 링크 카드는 방금 수집한 기록으로 그린다. 수집이 실패해도 날짜가 바뀌는 등 카드는 갱신될 수 있어 저장된 기록으로 그린다
    ctx.waitUntil(
      collected
        .then(({ data }) => data, () => undefined)
        .then((data) => updateCard(env, { now: event.scheduledTime, data }))
        .catch((e) => console.warn(JSON.stringify({ message: '링크 카드 갱신 실패', error: e.message }))),
    );
    // Steam 감시는 부가 기능이라 실패해도 방송 수집과 섞이지 않게 따로 잡는다
    ctx.waitUntil(
      watchSteam(env, { now: event.scheduledTime }).catch((e) => console.warn(JSON.stringify({ message: 'Steam 감시 실패', error: e.message }))),
    );
  },
};
