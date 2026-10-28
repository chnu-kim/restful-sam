import { describe, expect, it, vi } from 'vitest';
import { computeStats, countDays, makeContext } from '../../public/src/calendar.js';
import {
  FONT_TIMEOUT_MS, SUMMARY_WIDTH, drawSummary, loadFonts, readPalette, summaryFileName, summaryHeight, summaryLabel, summaryText, summaryView,
} from '../../public/src/summary.js';

const KST = (s) => Date.parse(s.replace(' ', 'T') + '+09:00');
const st = (openDate, closeDate) => ({ openDate, closeDate, title: '방송', category: null });

// 9/25(기록 시작 전) 방송, 10/1~10/2 기록. 10/2는 6시간 방송, 10/3은 오늘 방송 중
const DATA = {
  channelId: 'x',
  since: '2026-10-01',
  checkedDays: ['2026-10-02', '2026-10-03'],
  live: false,
  streams: [st('2026-09-25 08:00:00', '2026-09-25 14:00:00'), st('2026-10-02 10:00:00', '2026-10-02 16:00:00'), st('2026-10-03 09:00:00', null)],
};

// 호출만 기록하는 2D 컨텍스트
function recorder() {
  const calls = [];
  const g = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s) => ({ width: s.length * 10 }) : (...a) => calls.push([k, ...a])),
    set: (t, k, v) => ((t[k] = v), true),
  });
  return { g, calls, texts: () => calls.filter(([k]) => k === 'fillText').map(([, s]) => s) };
}

describe('countDays', () => {
  it('기록 시작 전과 오늘 이후는 세지 않는다', () => {
    const ctx = makeContext(DATA, '2026-10-03');
    expect(countDays(ctx, ['2026-09-25', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])).toEqual({ on: 2, off: 1, offRate: 33 });
  });

  it('판정된 날이 없으면 휴방률은 null', () => {
    expect(countDays(makeContext(DATA, '2026-10-03'), [])).toEqual({ on: 0, off: 0, offRate: null });
  });
});

describe('summaryView 전체', () => {
  const v = summaryView(DATA, KST('2026-10-03 12:00:00'), 'all');

  it('기록 시작일부터 오늘까지 일수를 센다', () => {
    expect(v).toMatchObject({ today: '2026-10-03', range: '2026.10.01 ~ 2026.10.03', days: 3, on: 2, off: 1, offRate: 33 });
  });

  it('달력은 기록 시작 전 방송이 있는 달부터 이번 달까지', () => {
    expect(v.months.map((m) => m.label)).toEqual(['2026년 9월', '2026년 10월']);
    // 2026-09-01은 화요일이라 앞 빈칸 2개
    expect(v.months[0].cells.slice(0, 3).map((c) => c.status)).toEqual(['blank', 'blank', 'nodata']);
  });

  it('지난 방송일만 방송 시간만큼 채우고, 오늘은 채우지 않는다', () => {
    const oct = v.months[1].cells.filter((c) => c.status !== 'blank');
    expect(oct.slice(0, 4)).toEqual([
      { status: 'off', day: 1, fill: null },
      { status: 'on', day: 2, fill: 25 },
      { status: 'on', day: 3, fill: null },
      { status: 'future', day: 4, fill: null },
    ]);
  });

  it('라벨과 파일 이름', () => {
    expect(summaryLabel(v)).toBe('전체 기록 요약: 2026.10.01 ~ 2026.10.03, 방송 2일, 휴방 1일, 휴방률 33%');
    expect(summaryLabel({ ...v, offRate: null })).toContain('휴방률 -%');
    expect(summaryFileName(v)).toBe('삼덕이-휴방-요약-전체-2026-10-03.png');
  });
});

describe('summaryView 이번 달', () => {
  // 기록이 지난달부터 있으면 이번 달 요약은 이번 달 1일부터 센다. 9/30은 휴방, 10/2 방송
  const LONG = { ...DATA, since: '2026-09-29', checkedDays: ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'] };
  const now = KST('2026-10-03 12:00:00');
  const v = summaryView(LONG, now);

  it('기본 범위이고, 이번 달만 그린다', () => {
    expect(v).toMatchObject({ scope: 'month', title: '10월 기록', range: '2026.10.01 ~ 2026.10.03', days: 3 });
    expect(v.months.map((m) => m.label)).toEqual(['2026년 10월']);
    expect(summaryView(LONG, now, 'all')).toMatchObject({ title: '전체 기록', range: '2026.09.29 ~ 2026.10.03', days: 5 });
  });

  it('일수는 페이지의 월 통계와 같다', () => {
    const { on, off, offRate } = computeStats(makeContext(LONG, '2026-10-03'));
    expect(v).toMatchObject({ on, off, offRate });
    expect(summaryView(LONG, now, 'all').off).toBeGreaterThan(v.off);
  });

  it('기록 시작일이 이번 달이면 그날부터 센다', () => {
    expect(summaryView(DATA, now)).toMatchObject({ range: '2026.10.01 ~ 2026.10.03', days: 3 });
  });

  it('라벨과 파일 이름', () => {
    expect(summaryLabel(v)).toBe(`이번 달 요약: 2026.10.01 ~ 2026.10.03, 방송 ${v.on}일, 휴방 ${v.off}일, 휴방률 ${v.offRate}%`);
    expect(summaryFileName(v)).toBe('삼덕이-휴방-요약-2026-10.png');
  });

  it('한 달을 크게 그려 전체보다 길고, 날짜 글자도 키운다', () => {
    expect(summaryHeight(v)).toBeGreaterThan(summaryHeight(summaryView(LONG, now, 'all')));
    const { g, texts } = recorder();
    const fonts = [];
    const spy = new Proxy(g, { set: (t, k, val) => (k === 'font' && fonts.push(val), (t[k] = val), true), get: (t, k) => t[k] });
    drawSummary(spy, v, readPalette({ getPropertyValue: () => '#000' }), 'x');
    expect(texts()).toContain('10월 기록');
    expect(fonts.some((f) => /^400 3\dpx/.test(f))).toBe(true);
  });
});

describe('그리기', () => {
  const v = summaryView(DATA, KST('2026-10-03 12:00:00'), 'all');
  const palette = readPalette({ getPropertyValue: (n) => ` ${n}-값 ` });

  it('CSS 변수에서 색을 읽는다', () => {
    expect(palette.onFill).toBe('--on-fill-값');
    expect(palette.bg).toBe('--bg-값');
  });

  it('제목·일수·달·범례·주소를 그린다', () => {
    const { g, calls, texts } = recorder();
    drawSummary(g, v, palette, 'example.com');
    expect(texts()).toEqual(expect.arrayContaining(['삼덕이 휴방 체크', '전체 기록', '2026.10.01 ~ 2026.10.03 (3일)', '2일', '1일', '33%', '2026년 9월', '2026년 10월', '휴방', '확인 전', 'example.com']));
    // 배경은 캔버스 전체
    expect(calls.find(([k]) => k === 'fillRect')).toEqual(['fillRect', 0, 0, SUMMARY_WIDTH, summaryHeight(v)]);
    // 오늘(아직 모름) 칸은 점선
    const pending = recorder();
    drawSummary(pending.g, summaryView(DATA, KST('2026-10-04 12:00:00'), 'all'), palette, 'x');
    expect(pending.calls.some(([k, a]) => k === 'setLineDash' && a.length)).toBe(true);
  });

  it('휴방률이 없으면 -로, 달이 하나면 한 줄로 그린다', () => {
    const one = { ...v, offRate: null, months: v.months.slice(1) };
    const { g, texts } = recorder();
    drawSummary(g, one, palette, 'x');
    expect(texts()).toContain('-');
    expect(summaryHeight(one)).toBe(summaryHeight(v));
  });

  it('달이 셋이면 두 줄로 늘어난다', () => {
    expect(summaryHeight({ ...v, months: [...v.months, v.months[1]] })).toBeGreaterThan(summaryHeight(v));
  });

  it('그릴 글자를 모두 담는다', () => {
    const text = summaryText(v, 'example.com');
    for (const s of ['전체 기록', '휴방률', '2026년 10월', 'example.com', '토']) expect(text).toContain(s);
  });
});

describe('loadFonts', () => {
  it('굵기별로 그릴 글자를 받는다', async () => {
    const fonts = { load: vi.fn(async () => []) };
    await loadFonts(fonts, '가나');
    expect(fonts.load).toHaveBeenCalledTimes(3);
    expect(fonts.load).toHaveBeenCalledWith(expect.stringContaining('700 20px'), '가나');
  });

  it('폰트 요청이 끝나지 않으면 기다리다 넘어간다', async () => {
    vi.useFakeTimers();
    const done = loadFonts({ load: () => new Promise(() => {}) }, 'x');
    await vi.advanceTimersByTimeAsync(FONT_TIMEOUT_MS);
    await expect(done).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('폰트 API가 없거나 실패해도 넘어간다', async () => {
    await expect(loadFonts(undefined, 'x')).resolves.toBeUndefined();
    await expect(loadFonts({ load: async () => { throw new Error('offline'); } }, 'x')).resolves.toBeUndefined();
  });
});
