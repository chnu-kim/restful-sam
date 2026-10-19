import { describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index.js';
import { CARD_HEIGHT, CARD_WIDTH, cardHtml, cardKey, cardView, updateCard } from '../../worker/card.js';
import { PAGE_HEADERS, serveCardImage, servePage } from '../../worker/page.js';

// 2026-10-19 12:00 KST (짝수 분이라 카드 갱신 차례)
const NOW = Date.parse('2026-10-19T03:00:00Z');
const daysFrom = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const stream = (openDate, closeDate) => ({ openDate, closeDate, title: '방송', category: 'talk' });
// 9/24·9/25 방송 뒤 10/18까지 휴방 (수집기는 10/2부터 돌아 그 전은 확정, 10/19 수집이 있어 10/18도 확정)
const DATA = {
  channelId: 'x',
  since: '2026-09-24',
  checkedDays: daysFrom('2026-10-02', '2026-10-19'),
  live: false,
  streams: [stream('2026-09-24 07:55:37', '2026-09-24 16:17:09'), stream('2026-09-25 08:49:35', '2026-09-25 15:24:35')],
};
const withStreams = (...extra) => ({ ...DATA, streams: [...DATA.streams, ...extra] });

// D1 스텁: docs의 방송 기록과 og_card 한 줄
function cardDb(data, card = null) {
  const db = { card };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => {
      if (sql.startsWith('SELECT value FROM docs')) return data ? { value: JSON.stringify(data) } : null;
      if (sql === 'SELECT key FROM og_card WHERE id = 1') return db.card && { key: db.card.key };
      if (sql === 'SELECT png FROM og_card WHERE id = 1') return db.card && { png: db.card.png };
      throw new Error(`예상 못 한 SQL: ${sql}`);
    },
    run: async () => {
      expect(sql).toMatch(/^INSERT INTO og_card/);
      const [key, png, renderedAt] = args;
      // D1은 BLOB을 숫자 배열로 돌려준다
      db.card = { key, png: [...new Uint8Array(png)], renderedAt };
      return { meta: { changes: 1 } };
    },
  });
  db.prepare = (sql) => stmt(sql);
  return db;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const browser = (res = () => new Response(PNG)) => ({ quickAction: vi.fn(async () => res()) });

describe('cardView', () => {
  it('휴방이 이어지면 오늘을 빼고 센 연속 휴방 일수와 마지막 방송일을 보여 준다', () => {
    const v = cardView(DATA, NOW);
    expect(v).toMatchObject({ tone: 'off', live: false, headline: '23일 연속 휴방', sub: '마지막 방송 9월 25일 (금)', month: '10월' });
    expect(v.description).toBe('마지막 방송 9월 25일 (금) · 10월 방송 0일, 휴방 18일');
  });

  it('방송 중이면 시작 시각과 며칠 쉬고 켰는지', () => {
    const data = { ...withStreams(stream('2026-10-19 11:30:00', null)), live: true, liveCheckedAt: new Date(NOW - 60_000).toISOString() };
    expect(cardView(data, NOW)).toMatchObject({ tone: 'on', live: true, headline: '방송 중', sub: '11:30 시작 · 23일 휴방 후 첫 방송' });
  });

  it('방송 중 확인이 오래됐으면 방송 중으로 믿지 않는다 (사이트와 같은 기준)', () => {
    const data = { ...withStreams(stream('2026-10-19 11:30:00', null)), live: true, liveCheckedAt: new Date(NOW - 11 * 60_000).toISOString() };
    expect(cardView(data, NOW)).toMatchObject({ live: false, headline: '오늘 방송함', sub: '11:30 시작 · 23일 휴방 후 첫 방송' });
  });

  it('오늘 방송이 끝났으면 방송 시간', () => {
    const v = cardView(withStreams(stream('2026-10-19 09:00:00', '2026-10-19 12:00:00')), Date.parse('2026-10-19T04:00:00Z'));
    expect(v).toMatchObject({ tone: 'on', headline: '오늘 방송함', sub: '3시간 방송 · 23일 휴방 후 첫 방송' });
  });

  it('어제 방송했고 오늘은 아직이면 회색 톤', () => {
    const v = cardView(withStreams(stream('2026-10-18 20:00:00', '2026-10-18 23:00:00')), NOW);
    expect(v).toMatchObject({ tone: 'pending', headline: '아직 안 켬', sub: '마지막 방송 10월 18일 (일)' });
  });

  it('달력 칸은 그달 1일 요일만큼 비우고 오늘·미래를 구분한다', () => {
    const { cells } = cardView(withStreams(stream('2026-10-01 10:00:00', '2026-10-01 16:00:00')), NOW);
    expect(cells).toHaveLength(4 + 31); // 2026-10-01은 목요일
    expect(cells.slice(0, 4).every((c) => c.status === 'blank')).toBe(true);
    expect(cells[4]).toEqual({ status: 'on', fill: 25 });
    expect(cells[4 + 1]).toEqual({ status: 'off', fill: null });
    expect(cells[4 + 18].status).toBe('pending');
    expect(cells[4 + 19].status).toBe('future');
  });
});

describe('cardHtml / cardKey', () => {
  it('문구를 이스케이프하고, 내용이 같으면 key도 같다', async () => {
    const view = { ...cardView(DATA, NOW), sub: '<b>"x"</b>' };
    const html = cardHtml(view);
    expect(html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(html).toContain(`width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px`);
    expect(await cardKey(html)).toBe(await cardKey(cardHtml(view)));
    expect(await cardKey(html)).not.toBe(await cardKey(cardHtml(cardView(DATA, NOW))));
    expect(await cardKey(html)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('updateCard', () => {
  it('카드가 바뀌었을 때만 찍어 저장한다', async () => {
    const env = { DB: cardDb(DATA), BROWSER: browser() };
    const log = vi.fn();
    const key = await updateCard(env, { now: NOW, log });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(env.BROWSER.quickAction).toHaveBeenCalledWith('screenshot', expect.objectContaining({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT } }));
    expect(env.BROWSER.quickAction.mock.calls[0][1].html).toContain('23일 연속 휴방');
    expect(env.DB.card).toMatchObject({ key, png: [...PNG], renderedAt: new Date(NOW).toISOString() });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ message: '링크 카드 갱신', key });

    expect(await updateCard(env, { now: NOW + 120_000, log })).toBeNull();
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it('넘겨받은 기록이 있으면 그것으로 그린다', async () => {
    const env = { DB: cardDb(null), BROWSER: browser() };
    expect(await updateCard(env, { now: NOW, data: DATA, log: vi.fn() })).not.toBeNull();
  });

  it('홀수 분에는 D1도 읽지 않는다', async () => {
    const env = { DB: { prepare: vi.fn() }, BROWSER: browser() };
    expect(await updateCard(env, { now: NOW + 60_000 })).toBeNull();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it('찍기에 실패하거나 PNG가 아니면 저장하지 않고 throw한다', async () => {
    const failing = { DB: cardDb(DATA), BROWSER: browser(() => new Response('limit', { status: 429 })) };
    await expect(updateCard(failing, { now: NOW })).rejects.toThrow('카드 스크린샷 HTTP 429: limit');
    const notPng = { DB: cardDb(DATA), BROWSER: browser(() => new Response('{"ok":true}')) };
    await expect(updateCard(notPng, { now: NOW })).rejects.toThrow('PNG가 아닙니다');
    expect(failing.DB.card).toBeNull();
    expect(notPng.DB.card).toBeNull();
  });
});

const PAGE = '<!doctype html><html><head><title>t</title></head><body></body></html>';
const assets = () => ({ fetch: vi.fn(async () => new Response(PAGE, { headers: { ETag: '"a"' } })) });

describe('servePage', () => {
  it('<head>에 카드 메타를 넣고 _headers와 같은 보안 헤더를 단다', async () => {
    const env = { DB: cardDb(DATA, { key: 'abc123', png: [...PNG] }), ASSETS: assets() };
    const res = await servePage(new Request('https://site.dev/', { headers: { 'If-None-Match': '"a"' } }), env, NOW);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="삼덕이 휴방 체크 — 23일 연속 휴방">');
    expect(html).toContain('<meta property="og:description" content="마지막 방송 9월 25일 (금) · 10월 방송 0일, 휴방 18일">');
    expect(html).toContain('<meta property="og:image" content="https://site.dev/og.png?k=abc123">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).not.toContain('theme-color');
    expect(html.indexOf('og:title')).toBeLessThan(html.indexOf('</head>'));
    for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('ETag')).toBeNull();
    // 304를 받지 않도록 조건부 요청 헤더는 넘기지 않는다
    expect(env.ASSETS.fetch.mock.calls[0][0].headers.get('If-None-Match')).toBeNull();
  });

  it('Discord 봇에게만 임베드 띠 색(theme-color)을 준다', async () => {
    const env = { DB: cardDb(DATA, { key: 'abc123', png: [] }), ASSETS: assets() };
    const req = new Request('https://site.dev/', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
    expect(await (await servePage(req, env, NOW)).text()).toContain('<meta name="theme-color" content="#e5484d">');
  });

  it('카드 이미지가 아직 없으면 og:image 없이, 기록을 못 읽으면 사이트 이름만 넣는다', async () => {
    const noCard = await (await servePage(new Request('https://site.dev/'), { DB: cardDb(DATA), ASSETS: assets() }, NOW)).text();
    expect(noCard).toContain('23일 연속 휴방');
    expect(noCard).not.toContain('og:image');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 끊김'); } }) }) };
    const res = await servePage(new Request('https://site.dev/'), { DB: broken, ASSETS: assets() }, NOW);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<meta property="og:title" content="삼덕이 휴방 체크">');
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ message: '링크 카드 메타 실패', error: 'D1 끊김' });
    warn.mockRestore();
  });

  it('자산을 못 받으면 그 응답을 그대로 넘긴다', async () => {
    const env = { DB: cardDb(DATA), ASSETS: { fetch: async () => new Response('x', { status: 500 }) } };
    expect((await servePage(new Request('https://site.dev/'), env, NOW)).status).toBe(500);
  });
});

describe('serveCardImage', () => {
  it('저장된 PNG를 내보내고, 없으면 404', async () => {
    const res = await serveCardImage({ DB: cardDb(DATA, { key: 'k', png: [...PNG] }) });
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await serveCardImage({ DB: cardDb(DATA) })).status).toBe(404);
  });
});

describe('Worker 라우팅', () => {
  it('/는 카드 메타를 넣은 페이지, /og.png는 카드 이미지', async () => {
    const env = { DB: cardDb(DATA, { key: 'k', png: [...PNG] }), ASSETS: assets() };
    expect(await (await worker.fetch(new Request('https://site.dev/'), env)).text()).toContain('og:title');
    expect((await worker.fetch(new Request('https://site.dev/og.png?k=k'), env)).headers.get('Content-Type')).toBe('image/png');
  });

  it('예약 실행은 수집이 실패해도 저장된 기록으로 카드를 갱신한다', async () => {
    const env = { DB: cardDb(DATA), BROWSER: browser() };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits = [];
    await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil: (p) => waits.push(p) });
    await expect(waits[0]).rejects.toThrow();
    await waits[1];
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(env.DB.card).not.toBeNull();
    await Promise.allSettled(waits);
    fetchSpy.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });
});
