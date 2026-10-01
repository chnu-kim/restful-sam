import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ID, DEFAULT_API_URL, DEFAULT_SERVICE_BASE, MAX_DETAIL_CALLS, applyLiveStatus, backfillFromReplays, emptyData,
  fetchLiveStatus, formatKst, loadData, parseKst, run, todayKst,
} from '../../scripts/lib.mjs';

const CLOSED = {
  status: 'CLOSE',
  openDate: '2026-09-25 08:49:35',
  closeDate: '2026-09-25 15:24:35',
  liveTitle: '포더킹2',
  liveCategoryValue: '포 더 킹 2',
};
const OPEN = { status: 'OPEN', openDate: '2026-10-02 20:00:00', closeDate: null, liveTitle: '저챗', liveCategoryValue: 'talk' };

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const okFetch = (content) => vi.fn(async () => jsonResponse({ code: 200, message: null, content }));

describe('todayKst', () => {
  it('UTC 14:59:59는 같은 날, 15:00:00부터 KST 다음 날이다', () => {
    expect(todayKst(Date.parse('2026-10-01T14:59:59Z'))).toBe('2026-10-01');
    expect(todayKst(Date.parse('2026-10-01T15:00:00Z'))).toBe('2026-10-02');
  });

  it('연말 경계도 넘어간다', () => {
    expect(todayKst(Date.parse('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
  });

  it('인자가 없으면 현재 시각을 쓴다', () => {
    expect(todayKst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('fetchLiveStatus', () => {
  it('content를 반환하고 User-Agent를 붙여 기본 URL로 호출한다', async () => {
    const f = okFetch(CLOSED);
    await expect(fetchLiveStatus(f)).resolves.toEqual(CLOSED);
    expect(f).toHaveBeenCalledWith(DEFAULT_API_URL, { headers: { 'User-Agent': expect.stringContaining('Mozilla') } });
    expect(DEFAULT_API_URL).toContain(CHANNEL_ID);
  });

  it('HTTP 오류면 상태 코드와 함께 실패한다', async () => {
    const f = vi.fn(async () => new Response('err', { status: 500 }));
    await expect(fetchLiveStatus(f, 'http://x')).rejects.toThrow('live-status HTTP 500');
  });

  it('code가 200이 아니면 실패한다', async () => {
    const f = vi.fn(async () => jsonResponse({ code: 404, message: 'not found', content: null }));
    await expect(fetchLiveStatus(f)).rejects.toThrow('응답 이상');
  });

  it('content가 null이면 실패한다', async () => {
    const f = vi.fn(async () => jsonResponse({ code: 200, content: null }));
    await expect(fetchLiveStatus(f)).rejects.toThrow('응답 이상');
  });

  it('본문이 null이면 실패한다', async () => {
    const f = vi.fn(async () => jsonResponse(null));
    await expect(fetchLiveStatus(f)).rejects.toThrow('응답 이상');
  });

  it('JSON이 아니면 실패한다', async () => {
    const f = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(fetchLiveStatus(f)).rejects.toThrow(SyntaxError);
  });

  it('네트워크 오류를 그대로 전파한다', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchLiveStatus(f)).rejects.toThrow('fetch failed');
  });
});

describe('loadData', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sam-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('파일이 없으면 오늘부터 기록하는 빈 데이터를 만든다', async () => {
    await expect(loadData(join(dir, 'none.json'), '2026-10-02')).resolves.toEqual(emptyData('2026-10-02'));
    expect(emptyData('2026-10-02')).toMatchObject({ channelId: CHANNEL_ID, since: '2026-10-02', streams: [] });
  });

  it('기존 파일을 읽는다', async () => {
    const p = join(dir, 's.json');
    const data = { ...emptyData('2026-10-01'), streams: [{ openDate: '2026-10-01 10:00:00' }] };
    await writeFile(p, JSON.stringify(data));
    await expect(loadData(p, '2026-10-02')).resolves.toEqual(data);
  });

  it('깨진 JSON이면 throw한다', async () => {
    const p = join(dir, 's.json');
    await writeFile(p, '{ broken');
    await expect(loadData(p, '2026-10-02')).rejects.toThrow(SyntaxError);
  });

  it.each([
    ['null', 'null'],
    ['streams 누락', '{"since":"2026-10-01"}'],
    ['since 누락', '{"streams":[]}'],
  ])('형식이 잘못되면 throw한다 (%s)', async (_, text) => {
    const p = join(dir, 's.json');
    await writeFile(p, text);
    await expect(loadData(p, '2026-10-02')).rejects.toThrow('형식');
  });

  it('ENOENT 외의 읽기 오류는 전파한다', async () => {
    const p = join(dir, 'adir');
    await mkdir(p);
    await expect(loadData(p, '2026-10-02')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('applyLiveStatus', () => {
  const base = emptyData('2026-10-01');

  it('종료된 방송을 추가하고 원본은 바꾸지 않는다', () => {
    const next = applyLiveStatus(base, CLOSED, '2026-10-02');
    expect(next.streams).toEqual([
      { openDate: CLOSED.openDate, closeDate: CLOSED.closeDate, title: '포더킹2', category: '포 더 킹 2' },
    ]);
    expect(next).toMatchObject({ live: false, checkedDays: ['2026-10-02'], since: '2026-10-01' });
    expect(base.streams).toEqual([]);
  });

  it('방송 중이면 closeDate를 null로 두고 live=true', () => {
    const next = applyLiveStatus(base, { ...OPEN, closeDate: '2026-09-25 15:24:35' }, '2026-10-02');
    expect(next.live).toBe(true);
    expect(next.streams[0].closeDate).toBeNull();
  });

  it('같은 openDate의 방송이 끝나면 그 자리에서 갱신한다', () => {
    const live = applyLiveStatus(base, OPEN, '2026-10-02');
    const done = applyLiveStatus(live, { ...OPEN, status: 'CLOSE', closeDate: '2026-10-02 23:00:00', liveTitle: '바뀐 제목' }, '2026-10-02');
    expect(done.streams).toHaveLength(1);
    expect(done.streams[0]).toMatchObject({ closeDate: '2026-10-02 23:00:00', title: '바뀐 제목' });
    expect(done.live).toBe(false);
  });

  it('새 방송은 추가되고 시작 시각 순으로 정렬된다', () => {
    const withNew = applyLiveStatus(base, OPEN, '2026-10-02');
    const withOld = applyLiveStatus(withNew, CLOSED, '2026-10-02');
    expect(withOld.streams.map((s) => s.openDate)).toEqual([CLOSED.openDate, OPEN.openDate]);
  });

  it('openDate가 없으면(방송 이력 없음) 기록하지 않는다', () => {
    const next = applyLiveStatus(base, { status: 'CLOSE', openDate: null }, '2026-10-02');
    expect(next.streams).toEqual([]);
  });

  it('누락된 필드는 기본값으로 채운다', () => {
    const next = applyLiveStatus(base, { status: 'CLOSE', openDate: '2026-10-01 10:00:00' }, '2026-10-02');
    expect(next.streams[0]).toEqual({ openDate: '2026-10-01 10:00:00', closeDate: null, title: '', category: null });
  });

  it('같은 입력을 두 번 적용해도 결과가 같다', () => {
    const once = applyLiveStatus(base, CLOSED, '2026-10-02');
    expect(applyLiveStatus(once, CLOSED, '2026-10-02')).toEqual(once);
  });

  it('날짜가 바뀌면 checkedDays에 그날이 추가되고 다른 값은 그대로다', () => {
    const once = applyLiveStatus(base, CLOSED, '2026-10-02');
    const next = applyLiveStatus(once, CLOSED, '2026-10-03');
    expect(next).toEqual({ ...once, checkedDays: ['2026-10-02', '2026-10-03'] });
    expect(once.checkedDays).toEqual(['2026-10-02']);
  });

  it('예전 형식(lastCheckedDate)은 checkedDays로 옮긴다', () => {
    const legacy = { channelId: 'x', since: '2026-09-24', lastCheckedDate: '2026-10-02', live: false, streams: [] };
    const next = applyLiveStatus(legacy, CLOSED, '2026-10-03');
    expect(next).not.toHaveProperty('lastCheckedDate');
    expect(next.checkedDays).toEqual(['2026-10-02', '2026-10-03']);
    const empty = applyLiveStatus({ ...legacy, lastCheckedDate: null }, CLOSED, '2026-10-03');
    expect(empty.checkedDays).toEqual(['2026-10-03']);
  });
});

describe('KST 변환', () => {
  it('parseKst / formatKst 왕복', () => {
    expect(parseKst('2026-09-24 07:55:37')).toBe(Date.parse('2026-09-23T22:55:37Z'));
    expect(formatKst(parseKst('2026-09-24 07:55:37') + 30092 * 1000)).toBe('2026-09-24 16:17:09');
  });
});

// 다시보기 API 스텁. URL로 목록/상세를 구분한다
const BASE = 'http://svc';
const replay = (videoNo, publishDate, duration, extra = {}) => ({
  videoNo, videoType: 'REPLAY', publishDate, duration, videoTitle: `v${videoNo}`, videoCategoryValue: 'cat', ...extra,
});
function replayFetch(list, details = {}, { listStatus = 200 } = {}) {
  return vi.fn(async (url) => {
    if (url.includes('/videos?')) {
      return listStatus === 200 ? jsonResponse({ code: 200, content: { data: list } }) : new Response('', { status: listStatus });
    }
    const no = url.split('/').pop();
    if (url.includes('/v3/videos/') && details[no]) return jsonResponse({ code: 200, content: details[no] });
    return new Response('', { status: 404 });
  });
}

describe('backfillFromReplays', () => {
  // 9/25는 이미 알고 있음, 9/24는 놓친 방송
  const known = { ...emptyData('2026-09-24'), streams: [{ openDate: '2026-09-25 08:49:35', closeDate: '2026-09-25 15:24:35', title: 'a', category: null }] };
  const LIST = [replay(2, '2026-09-25 15:28:37', 23687), replay(1, '2026-09-24 16:23:02', 30092)];

  it('놓친 방송만 상세 조회해 시작 시각·추정 종료 시각으로 추가하고 정렬한다', async () => {
    const f = replayFetch(LIST, { 1: { liveOpenDate: '2026-09-24 07:55:37' } });
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams.map((x) => x.openDate)).toEqual(['2026-09-24 07:55:37', '2026-09-25 08:49:35']);
    expect(next.streams[0]).toEqual({ openDate: '2026-09-24 07:55:37', closeDate: '2026-09-24 16:17:09', title: 'v1', category: 'cat' });
    expect(f).toHaveBeenCalledTimes(2); // 목록 1 + 상세 1 (9/25는 ±30분 일치로 건너뜀)
    expect(f.mock.calls[0][0]).toBe(`${BASE}/v1/channels/${CHANNEL_ID}/videos?sortType=LATEST&pagingType=PAGE&page=0&size=10`);
    expect(f.mock.calls[1][0]).toBe(`${BASE}/v3/videos/1`);
  });

  it('기존 항목을 덮어쓰지 않고, 새로 넣을 게 없으면 원본을 그대로 돌려준다', async () => {
    const f = replayFetch([replay(2, '2026-09-25 15:28:37', 23687)]);
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
  });

  it('추정이 30분 넘게 어긋나도 상세의 시작 시각이 같으면 추가하지 않는다', async () => {
    const f = replayFetch([replay(2, '2026-09-25 16:30:00', 23687)], { 2: { liveOpenDate: '2026-09-25 08:49:35' } });
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams).toHaveLength(1);
  });

  it('REPLAY가 아니거나 정보가 빠진 영상, liveOpenDate가 없는 상세는 건너뛴다', async () => {
    const f = replayFetch(
      [replay(3, '2026-09-20 10:00:00', 100, { videoType: 'UPLOAD' }), replay(4, null, 100), replay(5, '2026-09-20 10:00:00', 0), replay(6, '2026-09-19 10:00:00', 100)],
      { 6: { liveOpenDate: null } },
    );
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it(`상세 조회는 실행당 ${MAX_DETAIL_CALLS}번까지만 한다`, async () => {
    const list = [10, 11, 12, 13, 14].map((n) => replay(n, `2026-09-${n} 12:00:00`, 3600));
    const details = Object.fromEntries(list.map((v) => [v.videoNo, { liveOpenDate: `2026-09-${v.videoNo} 11:00:00` }]));
    const f = replayFetch(list, details);
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams).toHaveLength(1 + MAX_DETAIL_CALLS);
    expect(f).toHaveBeenCalledTimes(1 + MAX_DETAIL_CALLS);
  });

  it('제목·카테고리가 없으면 기본값', async () => {
    const f = replayFetch([replay(7, '2026-09-20 12:00:00', 3600, { videoTitle: undefined, videoCategoryValue: '' })], { 7: { liveOpenDate: '2026-09-20 11:00:00' } });
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams[0]).toMatchObject({ title: '', category: null });
  });

  it('목록에 data가 없으면 아무것도 하지 않는다', async () => {
    const f = vi.fn(async () => jsonResponse({ code: 200, content: {} }));
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
  });

  it('목록·상세 조회 실패는 throw한다 (run에서 경고로 처리)', async () => {
    await expect(backfillFromReplays(known, { fetchImpl: replayFetch([], {}, { listStatus: 500 }), serviceBase: BASE })).rejects.toThrow('videos HTTP 500');
    await expect(backfillFromReplays(known, { fetchImpl: replayFetch([replay(8, '2026-09-20 12:00:00', 60)]), serviceBase: BASE })).rejects.toThrow('video HTTP 404');
  });

  it('기본 serviceBase는 치지직 API', async () => {
    const f = replayFetch([]);
    await backfillFromReplays(known, { fetchImpl: f });
    expect(f.mock.calls[0][0].startsWith(DEFAULT_SERVICE_BASE)).toBe(true);
  });
});

describe('run', () => {
  let dir, path;
  const now = Date.parse('2026-10-02T03:00:00Z');
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sam-'));
    path = join(dir, 'streams.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('파일이 없으면 만들고, 다시 실행하면 변경 없음', async () => {
    const log = vi.fn();
    const first = await run({ fetchImpl: okFetch(CLOSED), dataPath: path, now, log });
    expect(first.changed).toBe(true);
    expect(log).toHaveBeenLastCalledWith(`갱신됨: status=CLOSE, openDate=${CLOSED.openDate}`);
    const saved = await readFile(path, 'utf8');
    expect(saved.endsWith('\n')).toBe(true);
    expect(JSON.parse(saved)).toEqual(first.data);
    expect(first.data.since).toBe('2026-10-02');

    const second = await run({ fetchImpl: okFetch(CLOSED), dataPath: path, now, log });
    expect(second.changed).toBe(false);
    expect(log).toHaveBeenLastCalledWith(`변경 없음: status=CLOSE, openDate=${CLOSED.openDate}`);
    expect(await readFile(path, 'utf8')).toBe(saved);
  });

  it('조회에 실패하면 파일을 건드리지 않는다', async () => {
    await writeFile(path, 'original');
    const f = vi.fn(async () => new Response('', { status: 503 }));
    await expect(run({ fetchImpl: f, dataPath: path, now, log: vi.fn() })).rejects.toThrow('503');
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('데이터 파일이 깨져 있으면 덮어쓰지 않는다', async () => {
    await writeFile(path, '{ broken');
    await expect(run({ fetchImpl: okFetch(CLOSED), dataPath: path, now, log: vi.fn() })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{ broken');
  });

  it('다시보기 보충이 실패해도 경고만 남기고 live-status 결과는 저장한다', async () => {
    const warn = vi.fn();
    const f = vi.fn(async (url) => (url.includes('/videos') ? new Response('', { status: 503 }) : jsonResponse({ code: 200, content: CLOSED })));
    const r = await run({ fetchImpl: f, serviceBase: BASE, dataPath: path, now, log: vi.fn(), warn });
    expect(r.changed).toBe(true);
    expect(warn).toHaveBeenCalledWith('다시보기 보충 실패: videos HTTP 503');
    expect(JSON.parse(await readFile(path, 'utf8')).streams).toHaveLength(1);
  });

  it('다시보기로 놓친 방송을 보충해 저장한다', async () => {
    const f = vi.fn(async (url) => {
      if (url.includes('/videos?')) return jsonResponse({ code: 200, content: { data: [replay(1, '2026-09-24 16:23:02', 30092)] } });
      if (url.includes('/v3/videos/1')) return jsonResponse({ code: 200, content: { liveOpenDate: '2026-09-24 07:55:37' } });
      return jsonResponse({ code: 200, content: CLOSED });
    });
    const r = await run({ fetchImpl: f, serviceBase: BASE, dataPath: path, now, log: vi.fn() });
    expect(r.data.streams.map((x) => x.openDate)).toEqual(['2026-09-24 07:55:37', CLOSED.openDate]);
  });

  it('기본값으로 전역 fetch와 console.log·console.warn을 쓴다', async () => {
    const spyFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      url === DEFAULT_API_URL ? jsonResponse({ code: 200, content: CLOSED }) : new Response('', { status: 500 }),
    );
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run({ dataPath: path });
    expect(spyFetch).toHaveBeenCalledWith(DEFAULT_API_URL, expect.anything());
    expect(spyFetch.mock.calls[1][0].startsWith(DEFAULT_SERVICE_BASE)).toBe(true);
    expect(spyWarn).toHaveBeenCalledWith('다시보기 보충 실패: videos HTTP 500');
    expect(spyLog).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
