// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindHover, bindTheme, createState, init, renderAll, renderError, select, shiftMonth } from '../../src/app.js';

// 실제 index.html의 마크업을 그대로 써서 id가 어긋나면 테스트가 깨지게 한다
const MAIN = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8').match(/<main>[\s\S]*<\/main>/)[0];

const KST = (s) => Date.parse(s.replace(' ', 'T') + '+09:00');
const at = (s) => new Date(KST(s)).toISOString(); // liveCheckedAt
const st = (openDate, closeDate, title = '방송', category = null) => ({ openDate, closeDate, title, category });

const DATA = {
  channelId: 'x',
  since: '2026-10-01',
  checkedDays: ['2026-10-02'],
  live: false,
  streams: [st('2026-09-25 08:49:35', '2026-09-25 15:24:35', '포더킹2', '포 더 킹 2')],
};

const $ = (sel) => document.querySelector(sel);
const day = (d) => $(`[data-d="${d}"]`);
const respond = (body, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

beforeEach(() => {
  document.body.innerHTML = MAIN;
});

function mount(data, now) {
  const state = createState(data, now);
  renderAll(document, state);
  return state;
}

describe('오늘 카드', () => {
  it('오늘 방송이 없고 어제가 휴방이면 그렇게 알려준다', () => {
    mount(DATA, KST('2026-10-02 12:00:00'));
    expect($('#today .label').textContent).toBe('오늘 (2026-10-02)');
    expect($('#today .verdict').textContent).toBe('아직 안 켬');
    expect($('#today .verdict').className).toContain('pending');
    expect($('#today .detail').textContent).toBe('어제는 휴방이었어요.');
  });

  it('어제 방송했으면 그렇게 알려준다', () => {
    mount({ ...DATA, streams: [...DATA.streams, st('2026-10-01 10:00:00', '2026-10-01 12:00:00')] }, KST('2026-10-02 12:00:00'));
    expect($('#today .detail').textContent).toBe('어제는 방송했어요.');
  });

  it('어제가 기록 시작 전이면 아무 말도 하지 않는다', () => {
    mount({ ...DATA, since: '2026-10-02' }, KST('2026-10-02 12:00:00'));
    expect($('#today .detail').textContent).toBe('');
  });

  it('방송 중이면 라이브 표시와 시작 시각', () => {
    const data = { ...DATA, live: true, liveCheckedAt: at('2026-10-02 20:07:00'), streams: [st('2026-10-02 20:00:00', null, '저챗')] };
    mount(data, KST('2026-10-02 21:00:00'));
    expect($('#today .verdict').textContent).toBe('방송 중');
    expect($('#today .live-dot')).not.toBeNull();
    expect($('#today .detail').textContent).toBe('20:00 시작 · 저챗');
  });

  it('오늘 방송이 끝났으면 방송함 + 여러 방송을 모두 보여준다', () => {
    const data = { ...DATA, streams: [st('2026-10-02 09:00:00', '2026-10-02 11:00:00', 'A'), st('2026-10-02 20:00:00', '2026-10-02 23:00:00', 'B')] };
    mount(data, KST('2026-10-02 23:30:00'));
    expect($('#today .verdict').textContent).toBe('방송함');
    expect($('#today .detail').innerHTML).toBe('09:00~11:00 · A<br>20:00~23:00 · B');
  });

  it('live 플래그가 남아 있어도 열린 방송이 없으면 방송함으로 본다', () => {
    const data = { ...DATA, live: true, liveCheckedAt: at('2026-10-02 11:30:00'), streams: [st('2026-10-02 09:00:00', '2026-10-02 11:00:00')] };
    mount(data, KST('2026-10-02 12:00:00'));
    expect($('#today .verdict').textContent).toBe('방송함');
    expect($('#today .stale')).toBeNull();
  });

  it('제목의 HTML을 이스케이프한다 (XSS)', () => {
    const data = { ...DATA, live: true, liveCheckedAt: at('2026-10-02 20:07:00'), streams: [st('2026-10-02 20:00:00', null, '<img src=x onerror="window.pwned=1">')] };
    mount(data, KST('2026-10-02 21:00:00'));
    expect($('#today img')).toBeNull();
    expect($('#today .detail').textContent).toContain('<img src=x');
  });
});

describe('오늘 카드: 자정을 넘긴 방송·수집 지연', () => {
  const overnight = { ...DATA, live: true, streams: [...DATA.streams, st('2026-10-02 23:00:00', null, '심야')] };

  it('어제 시작해 자정을 넘긴 방송도 방송 중으로 보인다 (오늘 첫 수집 후)', () => {
    mount({ ...overnight, liveCheckedAt: at('2026-10-03 00:07:00'), checkedDays: ['2026-10-02', '2026-10-03'] }, KST('2026-10-03 01:00:00'));
    expect($('#today .verdict').textContent).toBe('방송 중');
    expect($('#today .detail').textContent).toBe('어제 23:00 시작 · 심야');
    expect($('#today .stale')).toBeNull();
    expect(day('2026-10-02').className).toContain('on'); // 달력은 시작일 기준 그대로
  });

  it('자정 직후 첫 수집 전에도 2시간 안에 확인됐으면 방송 중으로 믿는다', () => {
    mount({ ...overnight, liveCheckedAt: at('2026-10-02 23:07:00') }, KST('2026-10-03 00:03:00'));
    expect($('#today .verdict').textContent).toBe('방송 중');
  });

  it('이틀 이상 이어진 방송은 날짜를 함께 보여준다', () => {
    mount({ ...overnight, liveCheckedAt: at('2026-10-04 09:07:00'), checkedDays: ['2026-10-02', '2026-10-03', '2026-10-04'] }, KST('2026-10-04 10:00:00'));
    expect($('#today .detail').textContent).toBe('10/2 23:00 시작 · 심야');
  });

  it('라이브 확인 후 정확히 2시간까지는 믿고, 그 뒤로는 방송 중으로 보이지 않고 안내한다', () => {
    const data = { ...overnight, liveCheckedAt: at('2026-10-03 00:07:00'), checkedDays: ['2026-10-02', '2026-10-03'] };
    mount(data, KST('2026-10-03 02:07:00'));
    expect($('#today .verdict').textContent).toBe('방송 중');
    mount(data, KST('2026-10-03 02:07:01'));
    expect($('#today .verdict').textContent).toBe('아직 안 켬');
    expect($('#today .stale').textContent).toBe('방송 중이었지만 최근 2시간 동안 상태를 확인하지 못해 최신 정보가 아닐 수 있어요.');
  });

  it('liveCheckedAt이 없는 예전 데이터의 live는 믿지 않는다', () => {
    mount({ ...overnight, checkedDays: ['2026-10-02', '2026-10-03'] }, KST('2026-10-03 01:00:00'));
    expect($('#today .verdict').textContent).toBe('아직 안 켬');
  });

  it('수집이 며칠 멈추면 미확인 표시와 마지막 확인일 안내', () => {
    mount({ ...DATA }, KST('2026-10-05 12:00:00'));
    expect($('#today .verdict').textContent).toBe('아직 안 켬');
    expect($('#today .stale').textContent).toBe('마지막 자동 확인이 2026-10-02이라 최신 정보가 아닐 수 있어요.');
    expect($('#today .detail').textContent).toBe('어제 방송 여부는 아직 확인 중이에요.');
    expect(day('2026-10-03').className).toBe('day unknown');
    expect(day('2026-10-03').textContent).toBe('3미확인');
  });

  it('자동 확인 기록이 아예 없으면 그렇게 안내한다', () => {
    mount({ ...DATA, checkedDays: [], streams: [st('2026-10-02 20:00:00', '2026-10-02 20:30:00')] }, KST('2026-10-02 21:00:00'));
    expect($('#today .verdict').textContent).toBe('방송함');
    expect($('#today .stale').textContent).toBe('자동 확인 기록이 없어 최신 정보가 아닐 수 있어요.');
  });

  it('미확인 날짜 상세', () => {
    const state = mount(DATA, KST('2026-10-04 12:00:00'));
    select(document, state, '2026-10-03');
    expect($('#info').textContent).toBe('2026-10-03 (토)아직 확인되지 않았어요. 다음 자동 확인 후 반영돼요.');
  });
});

describe('접근성', () => {
  it('날짜 버튼에 날짜와 상태를 읽어 주는 aria-label, 선택 상태 aria-pressed', () => {
    const state = mount(DATA, KST('2026-10-03 12:00:00'));
    expect(day('2026-10-01').getAttribute('aria-label')).toBe('10월 1일 휴방');
    expect(day('2026-10-02').getAttribute('aria-label')).toBe('10월 2일 확인 전');
    expect(day('2026-10-03').getAttribute('aria-label')).toBe('10월 3일 아직 방송 전');
    expect(day('2026-10-04').getAttribute('aria-label')).toBe('10월 4일');
    expect(day('2026-10-01').getAttribute('aria-pressed')).toBe('false');
    select(document, state, '2026-10-01');
    expect(day('2026-10-01').getAttribute('aria-pressed')).toBe('true');
  });

  it('지난 방송일 칸에는 방송 시간을 막대로 보여 주고 aria-label에 시간과 시각을 읽어 준다', () => {
    const data = { ...DATA, streams: [...DATA.streams, st('2026-10-01 20:00:00', '2026-10-02 01:30:00'), st('2026-10-03 10:00:00', '2026-10-03 12:00:00')] };
    mount(data, KST('2026-10-03 13:00:00'));
    expect(day('2026-10-01').querySelector('.bar i').style.width).toBe('46%');
    expect(day('2026-10-01').textContent).toBe('1');
    expect(day('2026-10-01').getAttribute('aria-label')).toBe('10월 1일 방송 5시간 30분, 20:00~01:30');
    // 오늘은 오늘 카드가 맡으므로 칸에는 '방송'만
    expect(day('2026-10-03').querySelector('.bar')).toBeNull();
    expect(day('2026-10-03').textContent).toBe('3방송');
    expect(day('2026-10-03').getAttribute('aria-label')).toBe('10월 3일 방송');
  });

  it('끝나지 않은 방송이 남은 지난 날은 시간을 지어내지 않고 \'방송\'으로 둔다', () => {
    mount({ ...DATA, streams: [st('2026-10-01 20:00:00', null)] }, KST('2026-10-03 13:00:00'));
    expect(day('2026-10-01').textContent).toBe('1방송');
    expect(day('2026-10-01').getAttribute('aria-label')).toBe('10월 1일 방송');
  });

  it('데이터를 불러오기 전에는 월 이동 버튼이 비활성이다', () => {
    expect($('#prev').disabled).toBe(true);
    expect($('#next').disabled).toBe(true);
  });
});

describe('통계', () => {
  const texts = () => [...document.querySelectorAll('.stat')].map((e) => e.textContent);

  it('보고 있는 달(10월) 기준: 10/1 휴방, 9월 방송은 세지 않는다', () => {
    mount(DATA, KST('2026-10-02 12:00:00'));
    expect(texts()).toEqual(['0일10월 방송한 날', '1일10월 휴방한 날', '100%10월 휴방률', '1일현재 연속 휴방']);
  });

  it('달력을 넘기면 월 통계가 그 달로 바뀌고 연속 일수는 그대로다', () => {
    const data = { ...DATA, since: '2026-09-25' };
    const state = mount(data, KST('2026-10-02 12:00:00'));
    shiftMonth(document, state, -1);
    expect(texts()).toEqual(['1일9월 방송한 날', '5일9월 휴방한 날', '83%9월 휴방률', '6일현재 연속 휴방']);
    shiftMonth(document, state, 1);
    expect(texts()[0]).toBe('0일10월 방송한 날');
  });

  it('다른 해의 달은 연도를 붙인다', () => {
    const data = { ...DATA, since: '2025-12-30', streams: [] };
    const state = mount(data, KST('2026-01-02 12:00:00'));
    shiftMonth(document, state, -1);
    expect(texts().slice(0, 3)).toEqual(['0일2025년 12월 방송한 날', '2일2025년 12월 휴방한 날', '100%2025년 12월 휴방률']);
  });

  it('그 달에 판정된 날이 없으면 휴방률은 -', () => {
    mount(DATA, KST('2026-10-01 12:00:00'));
    expect(texts().slice(0, 3)).toEqual(['0일10월 방송한 날', '0일10월 휴방한 날', '-10월 휴방률']);
  });

  it('연속 방송 라벨', () => {
    mount({ ...DATA, streams: [st('2026-10-02 09:00:00', '2026-10-02 11:00:00')] }, KST('2026-10-02 12:00:00'));
    expect(texts()[2]).toBe('50%10월 휴방률');
    expect(texts()[3]).toBe('1일현재 연속 방송');
  });
});

describe('달력', () => {
  it('10월 달력: 10/1 휴방, 오늘은 ?, 이후는 비활성', () => {
    mount(DATA, KST('2026-10-02 12:00:00'));
    expect($('#month').textContent).toBe('2026년 10월');
    expect(document.querySelectorAll('.day.blank')).toHaveLength(4); // 10/1은 목요일
    expect(day('2026-10-01').className).toBe('day off');
    expect(day('2026-10-01').textContent).toBe('1휴방');
    expect(day('2026-10-02').className).toBe('day pending');
    expect(day('2026-10-03').disabled).toBe(true);
    expect(day('2026-10-31')).not.toBeNull();
  });

  it('이전 달로 가면 9/25 방송, 그 외는 기록 없음. 경계에서 버튼이 비활성화된다', () => {
    const state = mount(DATA, KST('2026-10-02 12:00:00'));
    expect($('#prev').disabled).toBe(false);
    expect($('#next').disabled).toBe(true);
    shiftMonth(document, state, -1);
    expect($('#month').textContent).toBe('2026년 9월');
    expect(day('2026-09-25').className).toBe('day on');
    expect(day('2026-09-24').className).toBe('day nodata');
    expect($('#prev').disabled).toBe(true);
    expect($('#next').disabled).toBe(false);
  });

  it('날짜를 누르면 선택 표시와 상세가 나온다', () => {
    const state = mount(DATA, KST('2026-10-02 12:00:00'));
    day('2026-10-01').click();
    expect(state.selected).toBe('2026-10-01');
    expect(day('2026-10-01').classList.contains('selected')).toBe(true);
    expect($('#info').textContent).toBe('2026-10-01 (목)휴방');
  });

  it.each([
    ['2026-10-02', '2026-10-02 (금)아직 방송 기록이 없어요.'],
    ['2026-09-24', '2026-09-24 (목)기록을 시작하기 전이라 알 수 없어요.'],
    ['2026-09-25', '2026-09-25 (금)08:49 ~ 15:24 · 6시간 35분포더킹2 (포 더 킹 2)'],
  ])('%s 상세', (d, text) => {
    const state = mount(DATA, KST('2026-10-02 12:00:00'));
    select(document, state, d);
    expect($('#info').textContent).toBe(text);
  });

  it('방송 중인 날의 상세, 카테고리 없음, XSS 이스케이프', () => {
    const data = { ...DATA, live: true, streams: [st('2026-10-02 20:00:00', null, '<b>x</b>')] };
    const state = mount(data, KST('2026-10-02 21:00:00'));
    select(document, state, '2026-10-02');
    expect($('#info li').textContent).toBe('20:00 ~ 방송 중<b>x</b>');
    expect(document.querySelectorAll('#info li b')).toHaveLength(1);
  });

  it('하루 여러 방송이면 각각의 시간과 합계', () => {
    const data = { ...DATA, streams: [st('2026-10-01 10:00:00', '2026-10-01 12:00:00', '아침'), st('2026-10-01 23:00:00', '2026-10-02 02:10:00', '심야')] };
    const state = mount(data, KST('2026-10-02 12:00:00'));
    select(document, state, '2026-10-01');
    expect([...document.querySelectorAll('#info li')].map((e) => e.textContent)).toEqual(['10:00 ~ 12:00 · 2시간아침', '23:00 ~ 02:10 · 3시간 10분심야']);
    expect($('#info > .muted').textContent).toBe('총 5시간 10분');
  });

  it('누르면 상세 칸을 화면 안으로 끌어온다', () => {
    const state = mount(DATA, KST('2026-10-02 12:00:00'));
    const spy = vi.fn();
    $('#info').scrollIntoView = spy;
    select(document, state, '2026-10-01');
    expect(spy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });
});

describe('마우스 툴팁', () => {
  const hover = (el, pointerType = 'mouse') => {
    const e = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    el.dispatchEvent(e);
  };
  const setup = () => {
    const state = mount(DATA, KST('2026-10-02 12:00:00'));
    bindHover(document, state);
    shiftMonth(document, state, -1);
    return state;
  };

  it('마우스를 방송한 날에 올리면 상세를 보여 주고, 벗어나면 숨긴다', () => {
    setup();
    hover(day('2026-09-25').firstChild);
    expect($('#tip').hidden).toBe(false);
    expect($('#tip').textContent).toBe('2026-09-25 (금)08:49 ~ 15:24 · 6시간 35분포더킹2 (포 더 킹 2)');
    expect($('#tip').style.left).toBe('8px');
    hover(day('2026-09-25')); // 같은 칸 안에서 움직이면 그대로
    expect($('#tip').hidden).toBe(false);
    hover(day('2026-09-24'));
    expect($('#tip').hidden).toBe(true);
    hover(day('2026-09-25'));
    $('#grid').dispatchEvent(new MouseEvent('pointerleave'));
    expect($('#tip').hidden).toBe(true);
  });

  it('터치는 툴팁 없이 누르기로만 본다', () => {
    setup();
    hover(day('2026-09-25'), 'touch');
    expect($('#tip').hidden).toBe(true);
  });

  it('누르면 툴팁을 닫고, 선택한 날에는 다시 띄우지 않는다', () => {
    setup();
    hover(day('2026-09-25'));
    day('2026-09-25').click();
    expect($('#tip').hidden).toBe(true);
    hover(day('2026-09-25'));
    expect($('#tip').hidden).toBe(true);
  });
});

describe('푸터와 오류', () => {
  it('기록 시작일과 마지막 확인일을 보여준다', () => {
    mount(DATA, KST('2026-10-02 12:00:00'));
    expect($('#footer').textContent).toBe('2026-10-01부터 기록 · 매시간 자동 확인 · 마지막 확인일 2026-10-02');
  });

  it('마지막 확인일이 없으면 -', () => {
    mount({ ...DATA, checkedDays: [] }, KST('2026-10-02 12:00:00'));
    expect($('#footer').textContent).toContain('마지막 확인일 -');
  });

  it('renderError', () => {
    renderError(document);
    expect($('#today').textContent).toBe('데이터를 불러오지 못했어요.');
  });
});

describe('init', () => {
  it('데이터를 no-store로 받아 그리고, 이전/다음 버튼이 동작한다', async () => {
    const f = respond(DATA);
    const state = await init(document, f, KST('2026-10-02 12:00:00'));
    expect(f).toHaveBeenCalledWith('data/streams.json', { cache: 'no-store' });
    expect(state.view).toBe('2026-10');
    $('#prev').click();
    expect($('#month').textContent).toBe('2026년 9월');
    $('#next').click();
    expect($('#month').textContent).toBe('2026년 10월');
  });

  it.each([
    ['404', () => respond('not found', 404)],
    ['깨진 JSON', () => respond('{ broken')],
    ['형식 오류', () => respond({ streams: 'nope' })],
    ['null 본문', () => respond('null')],
    ['네트워크 오류', () => vi.fn(async () => { throw new TypeError('fail'); })],
  ])('%s면 오류 메시지를 보여주고 null을 반환한다', async (_, make) => {
    await expect(init(document, make(), KST('2026-10-02 12:00:00'))).resolves.toBeNull();
    expect($('#today').textContent).toBe('데이터를 불러오지 못했어요.');
  });

  it('기본 인자로 전역 document·fetch·현재 시각을 쓴다', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(respond(DATA));
    const state = await init();
    expect(spy).toHaveBeenCalled();
    expect(state.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    vi.restoreAllMocks();
  });
});

describe('테마 버튼', () => {
  const fakeWindow = (storage = new Map()) => ({
    localStorage: { setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    storage,
  });
  const html = () => document.documentElement;
  const label = () => $('#theme').getAttribute('aria-label');

  beforeEach(() => {
    delete html().dataset.theme;
  });

  it('기본은 시스템이고, 누를 때마다 라이트 → 다크 → 시스템으로 바뀌며 저장한다', () => {
    const win = fakeWindow();
    bindTheme(document, win);
    expect(label()).toBe('테마: 시스템');
    expect($('#theme').title).toBe('테마: 시스템');

    $('#theme').click();
    expect(html().dataset.theme).toBe('light');
    expect(win.storage.get('theme')).toBe('light');
    expect(label()).toBe('테마: 라이트');

    $('#theme').click();
    expect(html().dataset.theme).toBe('dark');
    expect(win.storage.get('theme')).toBe('dark');
    expect(label()).toBe('테마: 다크');

    $('#theme').click();
    expect(html().dataset.theme).toBeUndefined();
    expect(win.storage.has('theme')).toBe(false);
    expect(label()).toBe('테마: 시스템');
  });

  it('저장된 테마로 시작하면 거기서부터 이어진다', () => {
    html().dataset.theme = 'dark';
    bindTheme(document, fakeWindow());
    expect(label()).toBe('테마: 다크');
    $('#theme').click();
    expect(label()).toBe('테마: 시스템');
  });

  it('저장이 막혀도 화면 테마는 바뀐다', () => {
    const blocked = { localStorage: { setItem: () => { throw new Error('blocked'); } } };
    bindTheme(document, blocked);
    $('#theme').click();
    expect(html().dataset.theme).toBe('light');
  });
});
