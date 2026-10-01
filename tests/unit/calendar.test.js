import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, computeStats, currentStreak, dayOfWeek, dayStatus, esc, firstMonth, groupByDay, hm, isFinal, makeContext, monthDays, monthLabel, todayKst,
} from '../../src/calendar.js';

const s = (openDate, closeDate = null) => ({ openDate, closeDate, title: 't', category: null });
// checkedDays가 비어 있으면 모든 지난 날을 사용자가 확인한 기록(확정)으로 본다
const ctxOf = (streams, since, today, checkedDays = []) => makeContext({ streams, since, checkedDays }, today);

describe('날짜 유틸', () => {
  it('todayKst는 KST 자정 경계를 따른다', () => {
    expect(todayKst(Date.parse('2026-09-30T14:59:59Z'))).toBe('2026-09-30');
    expect(todayKst(Date.parse('2026-09-30T15:00:00Z'))).toBe('2026-10-01');
    expect(todayKst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('addDays는 월·연·윤년 경계를 넘는다', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('addMonths는 연도를 넘는다', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('dayOfWeek', () => {
    expect(dayOfWeek('2026-10-01')).toBe(4); // 목
  });

  it('monthDays는 그 달의 모든 날짜를 준다', () => {
    expect(monthDays('2026-02')).toHaveLength(28);
    expect(monthDays('2028-02')).toHaveLength(29);
    expect(monthDays('2026-10')[30]).toBe('2026-10-31');
  });

  it('hm은 시:분만, 없으면 빈 문자열', () => {
    expect(hm('2026-10-01 08:49:35')).toBe('08:49');
    expect(hm(null)).toBe('');
  });

  it('esc는 HTML 특수문자를 이스케이프하고 null을 빈 문자열로', () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    expect(esc(null)).toBe('');
    expect(esc(3)).toBe('3');
  });
});

describe('groupByDay', () => {
  it('시작일 기준으로 묶고, 자정을 넘긴 방송은 시작일에 속한다', () => {
    const map = groupByDay([s('2026-10-01 10:00:00'), s('2026-10-01 23:00:00', '2026-10-02 03:00:00'), s('2026-10-03 09:00:00')]);
    expect(map.get('2026-10-01')).toHaveLength(2);
    expect(map.has('2026-10-02')).toBe(false);
    expect(map.get('2026-10-03')).toHaveLength(1);
  });
});

describe('dayStatus', () => {
  const ctx = ctxOf([s('2026-09-25 08:49:35', '2026-09-25 15:24:35'), s('2026-10-03 20:00:00')], '2026-10-01', '2026-10-03');

  it.each([
    ['2026-09-25', 'on', '기록 시작 전이라도 방송 기록이 있으면 방송'],
    ['2026-09-30', 'nodata', '기록 시작 전'],
    ['2026-10-01', 'off', '10/1은 휴방'],
    ['2026-10-02', 'off', '지난 날 기록 없음 = 휴방'],
    ['2026-10-03', 'on', '오늘 방송'],
    ['2026-10-04', 'future', '미래'],
  ])('%s → %s (%s)', (d, expected) => {
    expect(dayStatus(d, ctx)).toBe(expected);
  });

  it('오늘 방송이 없으면 pending', () => {
    expect(dayStatus('2026-10-02', ctxOf([], '2026-10-01', '2026-10-02'))).toBe('pending');
  });
});

describe('computeStats (월별) / currentStreak', () => {
  it('이번 달 1일부터 오늘까지만 세고, 미정인 오늘은 제외한다', () => {
    const ctx = ctxOf([s('2026-09-25 10:00:00'), s('2026-10-02 10:00:00')], '2026-09-25', '2026-10-03');
    expect(computeStats(ctx)).toEqual({ on: 1, off: 1, offRate: 50, streak: 1, streakKind: 'on' });
  });

  it('오늘 방송했으면 오늘도 방송한 날에 들어간다', () => {
    const ctx = ctxOf([s('2026-10-01 10:00:00'), s('2026-10-02 10:00:00')], '2026-09-30', '2026-10-02');
    expect(computeStats(ctx)).toEqual({ on: 2, off: 0, offRate: 0, streak: 2, streakKind: 'on' });
  });

  it('휴방률은 반올림한다', () => {
    const ctx = ctxOf([s('2026-10-01 10:00:00')], '2026-10-01', '2026-10-04');
    expect(computeStats(ctx)).toMatchObject({ on: 1, off: 2, offRate: 67 });
  });

  it('연속 휴방은 달을 넘어서 센다', () => {
    const ctx = ctxOf([], '2026-09-28', '2026-10-02');
    expect(computeStats(ctx)).toEqual({ on: 0, off: 1, offRate: 100, streak: 4, streakKind: 'off' });
  });

  it('1일이고 아직 미정이면 이번 달 판정이 없어 휴방률은 null', () => {
    const ctx = ctxOf([], '2026-09-25', '2026-10-01');
    expect(computeStats(ctx)).toEqual({ on: 0, off: 0, offRate: null, streak: 6, streakKind: 'off' });
  });

  it('기록 시작이 이번 달 중간이면 그 전 날짜는 방송 기록이 있어도 세지 않는다', () => {
    const ctx = ctxOf([s('2026-10-01 10:00:00')], '2026-10-05', '2026-10-07');
    expect(computeStats(ctx)).toMatchObject({ on: 0, off: 2, offRate: 100 });
  });

  it('지난 달을 지정하면 그 달 말일까지 센다 (9/25 방송, 9/26~30 휴방)', () => {
    const ctx = ctxOf([s('2026-09-25 10:00:00')], '2026-09-25', '2026-10-02');
    expect(computeStats(ctx, '2026-09')).toEqual({ on: 1, off: 5, offRate: 83, streak: 6, streakKind: 'off' });
  });

  it('기록 시작 전의 달은 판정이 없어 휴방률 null', () => {
    const ctx = ctxOf([s('2026-08-10 10:00:00')], '2026-09-25', '2026-10-02');
    expect(computeStats(ctx, '2026-08')).toMatchObject({ on: 0, off: 0, offRate: null });
  });

  it('기록 첫날이 오늘이고 미정이면 0일·null', () => {
    const ctx = ctxOf([], '2026-10-02', '2026-10-02');
    expect(computeStats(ctx)).toEqual({ on: 0, off: 0, offRate: null, streak: 0, streakKind: null });
  });

  it('연속 기록은 기록 시작 전(nodata)에서 멈춘다', () => {
    const ctx = ctxOf([], '2026-10-01', '2026-10-03');
    expect(currentStreak(ctx)).toEqual({ streak: 2, streakKind: 'off' });
  });
});

describe('monthLabel', () => {
  it('올해면 월만, 다른 해면 연도까지', () => {
    expect(monthLabel('2026-09', '2026-10-02')).toBe('9월');
    expect(monthLabel('2025-12', '2026-01-03')).toBe('2025년 12월');
  });
});

describe('확정 판정 (checkedDays)', () => {
  // 수집기는 10/2부터 가동. 9/24~10/1은 사용자가 확인한 기록이다
  const streams = [s('2026-09-25 08:49:35', '2026-09-25 15:24:35')];

  it('수집기 가동 전 날짜는 확정이다', () => {
    const ctx = ctxOf(streams, '2026-09-24', '2026-10-02', ['2026-10-02']);
    expect(dayStatus('2026-09-30', ctx)).toBe('off');
    expect(dayStatus('2026-10-01', ctx)).toBe('off');
  });

  it('자정 직후 첫 수집 전에는 어제가 미확인, 수집 후 휴방으로 확정된다', () => {
    const before = ctxOf(streams, '2026-09-24', '2026-10-03', ['2026-10-02']);
    expect(dayStatus('2026-10-02', before)).toBe('unknown');
    const after = ctxOf(streams, '2026-09-24', '2026-10-03', ['2026-10-02', '2026-10-03']);
    expect(dayStatus('2026-10-02', after)).toBe('off');
  });

  it('수집이 3일 멈췄다 재개되면, 멈춘 동안의 날은 다음 날 수집이 없어 미확인으로 남는다', () => {
    // 10/2 수집 → 10/3~10/5 장애 → 10/6 재개
    const ctx = ctxOf(streams, '2026-09-24', '2026-10-06', ['2026-10-02', '2026-10-06']);
    expect(dayStatus('2026-10-02', ctx)).toBe('unknown'); // 10/3 수집 없음
    expect(dayStatus('2026-10-03', ctx)).toBe('unknown');
    expect(dayStatus('2026-10-04', ctx)).toBe('unknown');
    expect(dayStatus('2026-10-05', ctx)).toBe('off'); // 10/6 수집으로 확정
    expect(computeStats(ctx, '2026-10')).toMatchObject({ on: 0, off: 2, offRate: 100 }); // 10/1, 10/5
  });

  it('방송 기록이 있으면 확인 여부와 관계없이 방송이다', () => {
    const ctx = ctxOf([s('2026-10-03 10:00:00')], '2026-09-24', '2026-10-06', ['2026-10-02']);
    expect(dayStatus('2026-10-03', ctx)).toBe('on');
  });

  it('isFinal / makeContext 기본값', () => {
    const ctx = makeContext({ streams: [], since: '2026-10-01' }, '2026-10-05');
    expect(ctx.firstChecked).toBe('9999-12-31');
    expect(isFinal('2026-10-03', ctx)).toBe(true);
  });

  it('연속 일수는 오늘 미정·어제 미확인을 건너뛰고 가장 최근 판정된 날부터 센다', () => {
    const ctx = ctxOf(streams, '2026-09-24', '2026-10-03', ['2026-10-02']);
    expect(currentStreak(ctx)).toEqual({ streak: 6, streakKind: 'off' }); // 9/26~10/1
  });
});

describe('firstMonth', () => {
  it('기록 시작일보다 이른 방송이 있으면 그 달', () => {
    expect(firstMonth({ since: '2026-10-01', streams: [s('2026-09-25 08:00:00')] })).toBe('2026-09');
  });
  it('방송이 없거나 더 늦으면 기록 시작 달', () => {
    expect(firstMonth({ since: '2026-10-01', streams: [] })).toBe('2026-10');
    expect(firstMonth({ since: '2026-10-01', streams: [s('2026-10-05 08:00:00')] })).toBe('2026-10');
  });
});
