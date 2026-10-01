import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ID, DEFAULT_API_URL, applyLiveStatus, emptyData, fetchLiveStatus, loadData, run, todayKst,
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
    expect(next).toMatchObject({ live: false, lastCheckedDate: '2026-10-02', since: '2026-10-01' });
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

  it('날짜가 바뀌면 lastCheckedDate만 바뀐다', () => {
    const once = applyLiveStatus(base, CLOSED, '2026-10-02');
    const next = applyLiveStatus(once, CLOSED, '2026-10-03');
    expect(next).toEqual({ ...once, lastCheckedDate: '2026-10-03' });
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

  it('기본값으로 전역 fetch와 console.log를 쓴다', async () => {
    const spyFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(okFetch(CLOSED));
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run({ dataPath: path });
    expect(spyFetch).toHaveBeenCalledWith(DEFAULT_API_URL, expect.anything());
    expect(spyLog).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
