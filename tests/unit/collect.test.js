import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ID, DEFAULT_API_URL, DEFAULT_SERVICE_BASE, FETCH_TIMEOUT_MS, MAX_DETAIL_CALLS, applyLiveStatus, backfillFromReplays, emptyData,
  fetchLiveStatus, formatKst, parseKst, todayKst, validateData,
} from '../../worker/collect.js';

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
    expect(f).toHaveBeenCalledWith(DEFAULT_API_URL, { headers: { 'User-Agent': expect.stringContaining('Mozilla') }, signal: expect.any(AbortSignal) });
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

  it(`응답이 ${FETCH_TIMEOUT_MS / 1000}초 안에 없으면 끊는다`, async () => {
    // AbortSignal.timeout은 가짜 타이머로 앞당길 수 없어, 시간이 다 된 신호를 돌려주게 해 연결만 확인한다
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    try {
      const hang = vi.fn((_, { signal }) => (signal.aborted ? Promise.reject(signal.reason) : new Promise(() => {})));
      await expect(fetchLiveStatus(hang)).rejects.toThrow('timed out');
      expect(spy).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it('네트워크 오류를 그대로 전파한다', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchLiveStatus(f)).rejects.toThrow('fetch failed');
  });
});

describe('validateData', () => {
  it('형식이 맞으면 그대로 돌려준다', () => {
    const d = emptyData('2026-10-01');
    expect(validateData(d)).toBe(d);
  });

  it.each([null, {}, { streams: [] }, { streams: 'x', since: '2026-10-01' }])('형식이 아니면 throw한다: %j', (d) => {
    expect(() => validateData(d)).toThrow('형식');
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

  it('방송 중이면 closeDate를 null로 두고 live=true, 확인 시각을 남긴다', () => {
    const next = applyLiveStatus(base, { ...OPEN, closeDate: '2026-09-25 15:24:35' }, '2026-10-02', '2026-10-02T11:07:00.000Z');
    expect(next.live).toBe(true);
    expect(next.liveCheckedAt).toBe('2026-10-02T11:07:00.000Z');
    expect(next.streams[0].closeDate).toBeNull();
  });

  it('방송이 끝나면 확인 시각을 지운다', () => {
    const live = applyLiveStatus(base, OPEN, '2026-10-02', '2026-10-02T11:07:00.000Z');
    const closed = applyLiveStatus(live, { ...OPEN, status: 'CLOSE' }, '2026-10-02', '2026-10-02T12:07:00.000Z');
    expect(closed).not.toHaveProperty('liveCheckedAt');
    expect(applyLiveStatus(base, OPEN, '2026-10-02')).not.toHaveProperty('liveCheckedAt');
  });

  it('같은 openDate의 방송이 끝나면 그 자리에서 갱신한다', () => {
    const live = applyLiveStatus(base, OPEN, '2026-10-02');
    const done = applyLiveStatus(live, { ...OPEN, status: 'CLOSE', closeDate: '2026-10-02 23:00:00', liveTitle: '바뀐 제목' }, '2026-10-02');
    expect(done.streams).toHaveLength(1);
    expect(done.streams[0]).toMatchObject({ closeDate: '2026-10-02 23:00:00', title: '바뀐 제목' });
    expect(done.live).toBe(false);
  });

  it('두 확인 사이에 방송이 끊기고 새 방송이 잡히면, 열려 있던 이전 방송은 끝났다고 표시한다', () => {
    const a = applyLiveStatus(base, OPEN, '2026-10-02'); // 20:07 확인: A 방송 중
    const b = applyLiveStatus(a, { ...OPEN, openDate: '2026-10-02 20:15:00', liveTitle: 'B' }, '2026-10-02'); // 21:07: B만 보임
    expect(b.streams).toEqual([
      { openDate: OPEN.openDate, closeDate: null, title: '저챗', category: 'talk', ended: true },
      { openDate: '2026-10-02 20:15:00', closeDate: null, title: 'B', category: 'talk' },
    ]);
    expect(a.streams[0]).not.toHaveProperty('ended'); // 원본은 그대로
    expect(applyLiveStatus(b, { ...OPEN, openDate: '2026-10-02 20:15:00', liveTitle: 'B' }, '2026-10-02')).toEqual(b);
  });

  it('방송 중이면 마지막으로 본 시각(seenAt)을 남기고, 다음 방송에 밀리면 그 시각을 종료 시각으로 추정한다', () => {
    const a = applyLiveStatus(base, OPEN, '2026-10-02', '2026-10-02T11:09:00.000Z'); // 20:09 KST에 A 방송 중
    expect(a.streams[0].seenAt).toBe('2026-10-02 20:09:00');
    const b = applyLiveStatus(a, { ...OPEN, openDate: '2026-10-02 20:15:00', liveTitle: 'B' }, '2026-10-02', '2026-10-02T11:16:00.000Z');
    expect(b.streams[0]).toEqual({ openDate: OPEN.openDate, closeDate: '2026-10-02 20:09:00', title: '저챗', category: 'talk', closeApprox: true });
    expect(b.streams[1].seenAt).toBe('2026-10-02 20:16:00');
    // 방송이 정상 종료로 잡히면 seenAt 없이 정확한 종료 시각으로 바뀐다
    const c = applyLiveStatus(b, { ...OPEN, status: 'CLOSE', openDate: '2026-10-02 20:15:00', closeDate: '2026-10-02 23:00:00', liveTitle: 'B' }, '2026-10-02', '2026-10-02T14:01:00.000Z');
    expect(c.streams[1]).toEqual({ openDate: '2026-10-02 20:15:00', closeDate: '2026-10-02 23:00:00', title: 'B', category: 'talk' });
  });

  describe('방송 중 카테고리 변경', () => {
    const at = (kst) => new Date(parseKst(kst)).toISOString();
    const live = (category, extra = {}) => ({ ...OPEN, liveCategoryValue: category, ...extra });

    it('바뀐 적이 없으면 기록하지 않는다', () => {
      const a = applyLiveStatus(base, live('talk'), '2026-10-02', at('2026-10-02 20:01:00'));
      const b = applyLiveStatus(a, live('talk'), '2026-10-02', at('2026-10-02 20:02:00'));
      expect(b.streams[0]).not.toHaveProperty('categories');
    });

    it('바뀌면 시작부터의 구간과 바뀐 걸 확인한 시각부터의 구간을 남기고, 계속 쌓는다', () => {
      let d = applyLiveStatus(base, live('talk'), '2026-10-02', at('2026-10-02 20:01:00'));
      d = applyLiveStatus(d, live('ELDEN RING'), '2026-10-02', at('2026-10-02 21:10:00'));
      expect(d.streams[0].categories).toEqual([
        { from: '2026-10-02 20:00:00', category: 'talk' },
        { from: '2026-10-02 21:10:00', category: 'ELDEN RING' },
      ]);
      expect(d.streams[0].category).toBe('ELDEN RING');
      d = applyLiveStatus(d, live('ELDEN RING'), '2026-10-02', at('2026-10-02 21:11:00'));
      expect(d.streams[0].categories).toHaveLength(2);
      d = applyLiveStatus(d, live(''), '2026-10-02', at('2026-10-02 22:00:00'));
      expect(d.streams[0].categories.at(-1)).toEqual({ from: '2026-10-02 22:00:00', category: null });
    });

    it('종료로 잡힐 때 기록은 유지되고, 마지막 확인 뒤에 바뀌었으면 종료 시각부터로 남긴다', () => {
      let d = applyLiveStatus(base, live('talk'), '2026-10-02', at('2026-10-02 20:01:00'));
      d = applyLiveStatus(d, live('ELDEN RING'), '2026-10-02', at('2026-10-02 21:10:00'));
      const closed = applyLiveStatus(d, live('ELDEN RING', { status: 'CLOSE', closeDate: '2026-10-02 23:00:00' }), '2026-10-02', at('2026-10-02 23:01:00'));
      expect(closed.streams[0].categories).toHaveLength(2);
      const changed = applyLiveStatus(d, live('포 더 킹 2', { status: 'CLOSE', closeDate: '2026-10-02 23:00:00' }), '2026-10-02', at('2026-10-02 23:01:00'));
      expect(changed.streams[0].categories.at(-1)).toEqual({ from: '2026-10-02 23:00:00', category: '포 더 킹 2' });
    });
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

  // 비공식 API라 형식이 바뀌면 정렬·비교가 조용히 어긋나므로, 조회 실패처럼 throw해 저장하지 않는다
  it.each([
    ['openDate', { ...CLOSED, openDate: '2026-09-25T08:49:35Z' }],
    ['openDate', { ...CLOSED, openDate: 1758757775000 }],
    ['openDate', { ...CLOSED, openDate: '2026-13-45 99:99:99' }],
    ['openDate', { ...CLOSED, openDate: '2026-02-30 10:00:00' }],
    ['openDate', { ...CLOSED, openDate: '2026-09-25 24:00:00' }],
    ['openDate', { ...CLOSED, openDate: '2026-09-25 08:49:35.000' }],
    ['closeDate', { ...CLOSED, closeDate: '2026-09-25' }],
  ])('%s 형식이 YYYY-MM-DD HH:MM:SS가 아니면 throw한다 (%#)', (field, live) => {
    expect(() => applyLiveStatus(base, live, '2026-10-02')).toThrow(`live-status ${field} 형식 이상`);
  });

  // 방송 중에는 closeDate를 저장하지 않으므로, 형식이 달라도 수집을 멈추지 않는다
  it.each(['', 'x', '2026-10-02T20:00:00Z'])('방송 중이면 closeDate 형식은 보지 않는다: %j', (closeDate) => {
    const next = applyLiveStatus(base, { ...OPEN, closeDate }, '2026-10-02', '2026-10-02T12:00:00.000Z');
    expect(next.live).toBe(true);
    expect(next.streams).toHaveLength(1);
    expect(next.streams[0]).toMatchObject({ openDate: OPEN.openDate, closeDate: null });
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

  it('상세의 시작 시각이 아는 방송과 몇 초 차이면 같은 방송으로 보고 추가하지 않는다', async () => {
    const f = replayFetch([replay(2, '2026-09-25 16:30:00', 23687)], { 2: { liveOpenDate: '2026-09-25 08:49:37' } });
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
  });

  it('아는 방송과 시작이 30분 이내라도 길이가 다르면 다른 방송이라 상세로 확인해 추가한다', async () => {
    // 9/25 08:49~15:24 방송(6시간 35분) 직전에 10분짜리 방송이 있었던 경우
    const f = replayFetch([replay(3, '2026-09-25 08:40:00', 600)], { 3: { liveOpenDate: '2026-09-25 08:30:00' } });
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams.map((x) => x.openDate)).toEqual(['2026-09-25 08:30:00', '2026-09-25 08:49:35']);
  });

  it('아직 방송 중인 방송 근처의 다시보기는 그 방송일 수 없어 상세로 확인한다', async () => {
    const live = { ...known, streams: [{ openDate: '2026-10-02 20:15:00', closeDate: null, title: 'B', category: null }] };
    const f = replayFetch([replay(1, '2026-10-02 20:10:30', 600)], { 1: { liveOpenDate: '2026-10-02 20:00:00' } });
    const next = await backfillFromReplays(live, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams.map((x) => x.openDate)).toEqual(['2026-10-02 20:00:00', '2026-10-02 20:15:00']);
  });

  it('추정이 30분 넘게 어긋나도 상세의 시작 시각이 같으면 추가하지 않는다', async () => {
    const f = replayFetch([replay(2, '2026-09-25 16:30:00', 23687)], { 2: { liveOpenDate: '2026-09-25 08:49:35' } });
    const next = await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE });
    expect(next.streams).toHaveLength(1);
  });

  describe('끝났는데 종료 시각을 모르는 방송(ended)', () => {
    // A(20:00) 방송 중에 끊기고 20:15에 B로 다시 켬. A 다시보기는 10분
    const data = {
      ...emptyData('2026-10-01'),
      streams: [
        { openDate: '2026-10-02 20:00:00', closeDate: null, title: 'A', category: null, ended: true },
        { openDate: '2026-10-02 20:15:00', closeDate: null, title: 'B', category: null },
      ],
    };

    it('다시보기의 정확한 시작 시각으로 맞춰 종료 시각을 채우고 ended를 지운다', async () => {
      const f = replayFetch([replay(1, '2026-10-02 20:10:30', 600)], { 1: { liveOpenDate: '2026-10-02 20:00:00' } });
      const next = await backfillFromReplays(data, { fetchImpl: f, serviceBase: BASE });
      expect(next.streams).toEqual([
        { openDate: '2026-10-02 20:00:00', closeDate: '2026-10-02 20:10:00', title: 'A', category: null },
        data.streams[1],
      ]);
      expect(data.streams[0].ended).toBe(true); // 원본은 그대로
    });

    it('상세의 시작 시각이 몇 초 달라도 같은 방송으로 보고 채운다 (중복 추가 없음)', async () => {
      const f = replayFetch([replay(1, '2026-10-02 20:10:30', 600)], { 1: { liveOpenDate: '2026-10-02 20:00:01' } });
      const next = await backfillFromReplays(data, { fetchImpl: f, serviceBase: BASE });
      expect(next.streams).toHaveLength(2);
      expect(next.streams[0]).toEqual({ openDate: '2026-10-02 20:00:00', closeDate: '2026-10-02 20:10:01', title: 'A', category: null });
    });

    it('근처의 다른 방송 다시보기면 건드리지 않는다', async () => {
      const f = replayFetch([replay(2, '2026-10-02 23:00:00', 9900)], { 2: { liveOpenDate: '2026-10-02 20:15:00' } });
      expect(await backfillFromReplays(data, { fetchImpl: f, serviceBase: BASE })).toBe(data);
      expect(f).toHaveBeenCalledTimes(2); // A 근처라 상세는 확인한다
    });

    it('추정 종료 시각(closeApprox)도 다시보기가 있으면 정확한 값으로 고친다', async () => {
      const approx = { ...data, streams: [{ ...data.streams[0], ended: undefined, closeDate: '2026-10-02 20:09:00', closeApprox: true }, data.streams[1]] };
      delete approx.streams[0].ended;
      const f = replayFetch([replay(1, '2026-10-02 20:10:30', 600)], { 1: { liveOpenDate: '2026-10-02 20:00:00' } });
      const next = await backfillFromReplays(approx, { fetchImpl: f, serviceBase: BASE });
      expect(next.streams[0]).toEqual({ openDate: '2026-10-02 20:00:00', closeDate: '2026-10-02 20:10:00', title: 'A', category: null });
    });

    it('다시보기가 아직 없으면 그대로 둔다', async () => {
      const f = replayFetch([]);
      expect(await backfillFromReplays(data, { fetchImpl: f, serviceBase: BASE })).toBe(data);
    });
  });

  it('REPLAY가 아니거나 정보가 빠진 영상, liveOpenDate가 없는 상세는 건너뛴다', async () => {
    const f = replayFetch(
      [replay(3, '2026-09-20 10:00:00', 100, { videoType: 'UPLOAD' }), replay(4, null, 100), replay(5, '2026-09-20 10:00:00', 0), replay(6, '2026-09-19 10:00:00', 100)],
      { 6: { liveOpenDate: null } },
    );
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('publishDate·duration 형식이 이상한 영상은 상세 조회 없이 건너뛴다', async () => {
    const f = replayFetch(
      [
        replay(20, '2026-09-20T10:00:00', 100),
        replay(21, '2026-09-20 10:00:00', '100'),
        replay(22, '2026-09-20 10:00:00', -100),
        replay(23, '2026-09-20 10:00:00', Infinity),
      ],
      Object.fromEntries([20, 21, 22, 23].map((n) => [n, { liveOpenDate: '2026-09-20 09:00:00' }])),
    );
    expect(await backfillFromReplays(known, { fetchImpl: f, serviceBase: BASE })).toBe(known);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('상세의 liveOpenDate 형식이 이상하면 건너뛴다', async () => {
    const f = replayFetch([replay(24, '2026-09-20 12:00:00', 3600)], { 24: { liveOpenDate: '2026-09-20 11:00' } });
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
