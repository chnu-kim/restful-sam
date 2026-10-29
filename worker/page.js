// Worker가 직접 내보내는 페이지 응답: 링크 카드 메타를 넣은 index.html과 카드 이미지(/og.png)
import { CARD_HEIGHT, CARD_WIDTH, SITE_NAME, TONE_COLORS, cardView, storedCardKey } from './card.js';
import { esc } from '../public/src/calendar.js';
import { loadDoc } from './run.js';

// Worker가 만든 응답에는 public/_headers가 붙지 않아 같은 헤더를 직접 단다. tests/unit/headers.test.js가 _headers와 어긋남을 잡는다
export const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'sha256-entfcl0IDpM4MQ3iK6GuZpe3VBG8E9mU4KI5TzOJOiU=' 'sha256-qx/qC/I7QwN3OSCZpmYYni2LuQXTDq0EyP/HipuqS2M='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// theme-color는 모바일 브라우저 주소창 색까지 바꾸므로, 임베드 띠 색으로 쓰는 Discord 봇에게만 준다
const isDiscordBot = (ua) => /Discordbot/i.test(ua ?? '');

// 기록을 못 읽어도 페이지는 떠야 하므로 메타는 사이트 이름만으로 채운다
async function cardMeta(env, now) {
  try {
    const doc = await loadDoc(env.DB);
    const view = doc && cardView(doc.data, now);
    const key = doc ? doc.cardKey : await storedCardKey(env.DB);
    return view ? { title: `${SITE_NAME} — ${view.headline}`, description: view.description, color: TONE_COLORS[view.tone], key } : { title: SITE_NAME, key };
  } catch (e) {
    console.warn(JSON.stringify({ message: '링크 카드 메타 실패', error: e.message }));
    return { title: SITE_NAME, key: null };
  }
}

export function metaTags(meta, origin, { themeColor = false } = {}) {
  const tag = (attr, name, content) => `<meta ${attr}="${name}" content="${esc(content)}">`;
  return [
    `<link rel="canonical" href="${esc(origin)}/">`,
    meta.description && tag('name', 'description', meta.description),
    tag('property', 'og:type', 'website'),
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:url', `${origin}/`),
    tag('property', 'og:title', meta.title),
    meta.description && tag('property', 'og:description', meta.description),
    ...(meta.key
      ? [
          tag('property', 'og:image', `${origin}/og.png?k=${meta.key}`),
          tag('property', 'og:image:width', String(CARD_WIDTH)),
          tag('property', 'og:image:height', String(CARD_HEIGHT)),
          tag('property', 'og:image:alt', meta.description ? `${meta.title}. ${meta.description}` : meta.title),
          tag('name', 'twitter:card', 'summary_large_image'),
        ]
      : []),
    themeColor && meta.color && tag('name', 'theme-color', meta.color),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function servePage(request, env, now = Date.now()) {
  const url = new URL(request.url);
  // 조건부 요청 헤더를 넘기면 304가 와서 메타를 넣을 본문이 없으므로 헤더 없이 받는다
  const asset = await env.ASSETS.fetch(new Request(url));
  if (!asset.ok) return asset;
  const meta = await cardMeta(env, now);
  const html = (await asset.text()).replace('</head>', `${metaTags(meta, url.origin, { themeColor: isDiscordBot(request.headers.get('User-Agent')) })}\n</head>`);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...PAGE_HEADERS },
  });
}

// 페이지가 / 하나뿐이라 sitemap에도 그 주소만 싣는다. 주소는 canonical·og:url처럼 요청이 들어온 origin으로 만든다
export function serveSitemap(origin) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(origin)}/</loc></url>
</urlset>
`;
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}

// ?k=에 맞는 카드를 준다. 페이지를 읽은 뒤 카드가 바뀌어도 그 페이지가 가리킨 카드가 나가야 제목과 이미지가 어긋나지 않는다.
// 오래돼 지워졌거나 k가 없으면 최신 카드를 준다
export async function serveCardImage(env, key = null) {
  const exact = key && (await env.DB.prepare('SELECT png FROM og_cards WHERE key = ?').bind(key).first());
  const row = exact || (await env.DB.prepare('SELECT png FROM og_cards ORDER BY rendered_at DESC LIMIT 1').first());
  if (!row) return new Response('no card', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
  // key가 맞으면 내용이 바뀌지 않으므로 오래 캐시하고, 최신 카드로 대신 줬으면 잠깐만 캐시한다
  return new Response(new Uint8Array(row.png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': exact ? 'public, max-age=86400, immutable' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
