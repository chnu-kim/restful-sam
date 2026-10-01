import { describe, expect, it, vi } from 'vitest';
import worker, { BACKFILL_EVERY_MIN, collect, loadDoc, saveDoc } from '../../worker/index.js';
import { emptyData } from '../../worker/collect.js';

// D1 스텁: docs 테이블 하나를 Map으로 흉내 낸다. UPDATE는 WHERE value = ? 조건까지 지킨다
function fakeDb(initial) {
  const rows = new Map(initial ? [['streams', JSON.stringify(initial)]] : []);
  const db = {
    rows,
    writes: 0,
    // 읽은 직후 다른 실행이 끼어드는 상황을 흉내 낼 때 쓴다
    beforeWrite: null,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (rows.has(args[0]) ? { value: rows.get(args[0]) } : null),
        run: async () => {
          expect(sql).toBe('UPDATE docs SET value = ? WHERE key = ? AND value = ?');
          db.beforeWrite?.();
          const [value, key, prev] = args;
          if (rows.get(key) !== prev) return { meta: { changes: 0 } };
          rows.set(key, value);
          db.writes++;
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return db;
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const CLOSED = { status: 'CLOSE', openDate: '2026-09-25 08:49:35', closeDate: '2026-09-25 15:24:35', liveTitle: '포더킹2', liveCategoryValue: '포 더 킹 2' };
const OPEN = { status: 'OPEN', openDate: '2026-10-02 20:00:00', closeDate: null, liveTitle: '저챗', liveCategoryValue: 'talk' };
// 10분 단위가 아닌 시각 (다시보기 보충 안 함)
const NOW = Date.parse('2026-10-02T03:01:00Z');
const BACKFILL_NOW = Date.parse('2026-10-02T03:10:00Z');

const chzzk = (live, { videos = { code: 200, content: { data: [] } }, videosStatus = 200 } = {}) =>
  vi.fn(async (url) => (url.includes('/videos') ? jsonResponse(videos, videosStatus) : jsonResponse({ code: 200, content: live })));

describe('loadDoc / saveDoc', () => {
  it('문서가 없으면 null, 있으면 원문과 함께 읽는다', async () => {
    expect(await loadDoc(fakeDb())).toBeNull();
    const d = emptyData('2026-10-01');
    expect(await loadDoc(fakeDb(d))).toEqual({ raw: JSON.stringify(d), data: d });
  });

  it('읽은 뒤 바뀌지 않았을 때만 쓴다', async () => {
    const db = fakeDb(emptyData('2026-10-01'));
    const { raw } = await loadDoc(db);
    expect(await saveDoc(db, emptyData('2026-10-02'), raw)).toBe(true);
    expect(await saveDoc(db, emptyData('2026-10-03'), raw)).toBe(false); // raw가 이미 옛 값
    expect((await loadDoc(db)).data.since).toBe('2026-10-02');
  });

  it('형식이 깨진 문서는 throw한다 (덮어쓰지 않도록)', async () => {
    await expect(loadDoc(fakeDb({ streams: 'x' }))).rejects.toThrow('형식');
  });
});

describe('collect', () => {
  it('바뀌었으면 쓰고, 같은 결과면 다시 쓰지 않는다', async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    const log = vi.fn();
    const first = await collect(env, { fetchImpl: chzzk(CLOSED), now: NOW, log });
    expect(first.changed).toBe(true);
    expect(first.data).toMatchObject({ since: '2026-10-01', checkedDays: ['2026-10-02'], live: false });
    expect(JSON.parse(log.mock.lastCall[0])).toEqual({ message: '갱신됨', status: 'CLOSE', openDate: CLOSED.openDate, live: false });
    const second = await collect(env, { fetchImpl: chzzk(CLOSED), now: NOW + 60000, log });
    expect(second.changed).toBe(false);
    expect(env.DB.writes).toBe(1);
    expect(JSON.parse(log.mock.lastCall[0]).message).toBe('변경 없음');
  });

  it('D1에 기록이 없으면 빈 기록을 만들지 않고 실패한다 (지난 기록 보호)', async () => {
    const env = { DB: fakeDb() };
    await expect(collect(env, { fetchImpl: chzzk(CLOSED), now: NOW })).rejects.toThrow('시드');
    expect(env.DB.rows.size).toBe(0);
  });

  it('읽은 뒤 다른 실행이 먼저 썼으면 이번 결과로 덮어쓰지 않는다', async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    const newer = JSON.stringify({ ...emptyData('2026-10-01'), checkedDays: ['2026-10-02'], live: true });
    env.DB.beforeWrite = () => env.DB.rows.set('streams', newer);
    const warn = vi.fn();
    const r = await collect(env, { fetchImpl: chzzk(CLOSED), now: NOW, log: vi.fn(), warn });
    expect(r.changed).toBe(false);
    expect(env.DB.rows.get('streams')).toBe(newer);
    expect(JSON.parse(warn.mock.lastCall[0]).message).toBe('그 사이 다른 실행이 기록을 바꿔 이번 결과는 저장하지 않습니다');
  });

  it('방송 중이면 매번 확인 시각을 남긴다', async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    const r = await collect(env, { fetchImpl: chzzk(OPEN), now: NOW, log: vi.fn() });
    expect(r.data.liveCheckedAt).toBe(new Date(NOW).toISOString());
    expect(r.data.streams[0].seenAt).toBe('2026-10-02 12:01:00');
  });

  it('조회에 실패하면 기록을 건드리지 않는다', async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    await expect(collect(env, { fetchImpl: vi.fn(async () => new Response('', { status: 503 })), now: NOW })).rejects.toThrow('503');
    expect(env.DB.writes).toBe(0);
  });

  it(`다시보기 보충은 ${BACKFILL_EVERY_MIN}분에 한 번만 하고, 실패해도 경고만 남긴다`, async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    const f = chzzk(CLOSED, { videosStatus: 503 });
    await collect(env, { fetchImpl: f, now: NOW, log: vi.fn() });
    expect(f.mock.calls.some(([u]) => u.includes('/videos'))).toBe(false);
    const warn = vi.fn();
    const r = await collect(env, { fetchImpl: f, now: BACKFILL_NOW, log: vi.fn(), warn });
    expect(JSON.parse(warn.mock.lastCall[0])).toEqual({ message: '다시보기 보충 실패', error: 'videos HTTP 503' });
    expect(r.data.streams).toHaveLength(1);
  });

  it('보충 시각이면 다시보기로 놓친 방송을 더한다', async () => {
    const env = { DB: fakeDb(emptyData('2026-09-24')) };
    const videos = { code: 200, content: { data: [{ videoNo: 1, videoType: 'REPLAY', publishDate: '2026-09-24 16:23:02', duration: 30092, videoTitle: 'v1' }] } };
    const f = vi.fn(async (url) => {
      if (url.includes('/videos?')) return jsonResponse(videos);
      if (url.includes('/v3/videos/1')) return jsonResponse({ code: 200, content: { liveOpenDate: '2026-09-24 07:55:37' } });
      return jsonResponse({ code: 200, content: CLOSED });
    });
    const r = await collect(env, { fetchImpl: f, now: BACKFILL_NOW, serviceBase: 'http://svc', log: vi.fn() });
    expect(r.data.streams.map((s) => s.openDate)).toEqual(['2026-09-24 07:55:37', CLOSED.openDate]);
  });
});

describe('Worker 핸들러', () => {
  it('/data/streams.json은 D1의 최신 기록을 캐시 없이 내보낸다', async () => {
    const data = emptyData('2026-10-01');
    const res = await worker.fetch(new Request('https://x/data/streams.json'), { DB: fakeDb(data) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual(data);
  });

  it('기록이 없으면 404', async () => {
    const res = await worker.fetch(new Request('https://x/data/streams.json'), { DB: fakeDb() });
    expect(res.status).toBe(404);
  });

  it('그 외 경로는 정적 자산으로 넘긴다', async () => {
    const ASSETS = { fetch: vi.fn(async () => new Response('page')) };
    const req = new Request('https://x/');
    const res = await worker.fetch(req, { ASSETS });
    expect(ASSETS.fetch).toHaveBeenCalledWith(req);
    expect(await res.text()).toBe('page');
  });

  it('예약 실행은 그 시각으로 수집해 waitUntil에 맡긴다', async () => {
    const env = { DB: fakeDb(emptyData('2026-10-01')) };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(chzzk(CLOSED));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const waits = [];
    await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(JSON.parse(env.DB.rows.get('streams')).checkedDays).toContain('2026-10-02');
    spy.mockRestore();
  });
});
