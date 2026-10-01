// 정적 서버로 실제 페이지를 띄우고, 데이터는 route로, 시각은 page.clock으로 고정한다
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const REAL_DATA = JSON.parse(readFileSync(join(import.meta.dirname, '../../data/streams.json'), 'utf8'));
const KST = (s) => new Date(s.replace(' ', 'T') + '+09:00');
const at = (s) => KST(s).toISOString(); // liveCheckedAt
const st = (openDate, closeDate, title = '방송', category = null) => ({ openDate, closeDate, title, category });

const BASE = {
  channelId: 'x',
  since: '2026-10-01',
  checkedDays: ['2026-10-02'],
  live: false,
  streams: [st('2026-09-25 08:49:35', '2026-09-25 15:24:35', '포더킹2', '포 더 킹 2')],
};

async function open(page, { data = BASE, now = '2026-10-02 12:00:00', status = 200, raw } = {}) {
  await page.clock.setFixedTime(KST(now));
  await page.route('**/data/streams.json', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: raw ?? JSON.stringify(data) }),
  );
  await page.goto('/');
}

const day = (page, d) => page.locator(`[data-d="${d}"]`);

test('실제 저장된 데이터: 9/24·9/25 방송, 9/26~10/1 휴방', async ({ page }) => {
  expect(REAL_DATA.since <= '2026-09-24').toBe(true);
  await page.clock.setFixedTime(KST('2026-10-02 12:00:00'));
  await page.goto('/'); // route 없이 저장소의 data/streams.json을 그대로 사용
  await expect(day(page, '2026-10-01')).toHaveClass(/\boff\b/);
  await expect(day(page, '2026-10-01')).toContainText('휴방');
  await page.locator('#prev').click();
  await expect(day(page, '2026-09-24')).toHaveClass(/\bon\b/);
  await expect(day(page, '2026-09-25')).toHaveClass(/\bon\b/);
  await expect(page.locator('.stat').first()).toHaveText('2일9월 방송한 날');
  for (const d of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
    await expect(day(page, d)).toHaveClass(/\boff\b/);
  }
});

test('오늘 아직 방송 전이면 미정, 어제 휴방 안내와 통계', async ({ page }) => {
  await open(page);
  await expect(page).toHaveTitle('삼덕이 휴방 체크');
  await expect(page.locator('#today .verdict')).toHaveText('아직 안 켬');
  await expect(page.locator('#today .detail')).toHaveText('어제는 휴방이었어요.');
  await expect(page.locator('.stat')).toHaveText(['0일10월 방송한 날', '1일10월 휴방한 날', '100%10월 휴방률', '1일현재 연속 휴방']);
  await expect(day(page, '2026-10-02')).toHaveClass(/pending/);
  await expect(day(page, '2026-10-03')).toBeDisabled();
  await expect(page.locator('#footer')).toContainText('2026-10-01부터 기록');
});

test('방송 중이면 라이브 표시', async ({ page }) => {
  await open(page, { data: { ...BASE, live: true, liveCheckedAt: at('2026-10-02 20:59:00'), streams: [st('2026-10-02 20:00:00', null, '저챗')] }, now: '2026-10-02 21:00:00' });
  await expect(page.locator('#today .verdict')).toHaveText('방송 중');
  await expect(page.locator('#today .live-dot')).toBeVisible();
  await expect(page.locator('#today .detail')).toHaveText('20:00 시작 · 저챗');
  await expect(day(page, '2026-10-02')).toHaveClass(/\bon\b/);
});

test('KST 자정 직후 첫 수집 전에는 어제를 휴방으로 단정하지 않는다', async ({ page }) => {
  await open(page, { now: '2026-10-03 00:00:30' });
  await expect(page.locator('#today .label')).toHaveText('오늘 (2026-10-03)');
  await expect(day(page, '2026-10-02')).toHaveClass(/\bunknown\b/);
  await expect(page.locator('#today .detail')).toHaveText('어제 방송 여부는 아직 확인 중이에요.');
});

test('자정 이후 첫 수집이 끝나면 어제가 휴방으로 확정된다', async ({ page }) => {
  await open(page, { data: { ...BASE, checkedDays: ['2026-10-02', '2026-10-03'] }, now: '2026-10-03 00:30:00' });
  await expect(day(page, '2026-10-02')).toHaveClass(/\boff\b/);
  await expect(page.locator('#today .detail')).toHaveText('어제는 휴방이었어요.');
});

test('자정을 넘겨 이어지는 방송은 오늘 카드에 방송 중으로 보인다', async ({ page }) => {
  const data = { ...BASE, live: true, liveCheckedAt: at('2026-10-03 00:59:00'), checkedDays: ['2026-10-02', '2026-10-03'], streams: [...BASE.streams, st('2026-10-02 23:00:00', null, '심야')] };
  await open(page, { data, now: '2026-10-03 01:00:00' });
  await expect(page.locator('#today .verdict')).toHaveText('방송 중');
  await expect(page.locator('#today .detail')).toHaveText('어제 23:00 시작 · 심야');
});

// 칸 전체가 하루(24시간)이고 방송 시간만큼 아래부터 채운다. 폰과 데스크톱에서 같게 보인다
for (const width of [360, 1024]) {
  test(`${width}px에서 방송한 날 칸이 방송 시간만큼 아래부터 채워진다`, async ({ page }) => {
    const data = { ...BASE, streams: [...BASE.streams, st('2026-10-01 08:00:00', '2026-10-01 20:00:00')] };
    await page.setViewportSize({ width, height: 900 });
    await open(page, { data });
    const cell = day(page, '2026-10-01');
    await expect(cell).toHaveClass(/\bfilled\b/);
    const style = await cell.evaluate((el) => ({ fill: el.style.getPropertyValue('--fill'), bg: getComputedStyle(el).backgroundImage }));
    expect(style.fill).toBe('50%');
    expect(style.bg).toContain('linear-gradient');
  });
}

test('기본은 시스템 테마, 버튼을 누를 때마다 라이트 → 다크 → 시스템, 고른 테마는 새로고침해도 유지', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const btn = page.locator('#theme');
  expect(await bg()).toBe('rgb(20, 20, 19)'); // 기기 설정(다크)
  await expect(btn).toHaveAttribute('aria-label', '테마: 시스템');
  await btn.click();
  expect(await bg()).toBe('rgb(246, 245, 241)');
  await page.reload();
  expect(await bg()).toBe('rgb(246, 245, 241)');
  await expect(btn).toHaveAttribute('aria-label', '테마: 라이트');
  await btn.click();
  expect(await bg()).toBe('rgb(20, 20, 19)');
  await expect(btn).toHaveAttribute('aria-label', '테마: 다크');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', '테마: 시스템');
  await page.emulateMedia({ colorScheme: 'light' }); // 시스템이면 기기 설정 변경을 따라간다
  expect(await bg()).toBe('rgb(246, 245, 241)');
  await page.reload();
  await expect(btn).toHaveAttribute('aria-label', '테마: 시스템');
});

test('수집이 멈추면 지연 안내와 미확인 표시', async ({ page }) => {
  await open(page, { now: '2026-10-06 12:00:00' });
  await expect(page.locator('#today .stale')).toContainText('마지막 자동 확인이 2026-10-02');
  await expect(day(page, '2026-10-04')).toHaveClass(/\bunknown\b/);
  await expect(day(page, '2026-10-04')).toHaveAttribute('aria-label', '10월 4일 확인 전');
});

test('데이터를 불러오는 동안 월 이동 버튼은 비활성이다', async ({ page }) => {
  await page.clock.setFixedTime(KST('2026-10-02 12:00:00'));
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/data/streams.json', async (route) => {
    await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(BASE) });
  });
  await page.goto('/');
  await expect(page.locator('#prev')).toBeDisabled();
  release();
  await expect(page.locator('#prev')).toBeEnabled();
});

test('날짜를 누르면 상세가 나오고, 선택이 바뀐다', async ({ page }) => {
  await open(page);
  await day(page, '2026-10-01').click();
  await expect(page.locator('#info')).toHaveText('2026-10-01 (목)휴방');
  await expect(day(page, '2026-10-01')).toHaveClass(/selected/);

  await page.locator('#prev').click();
  await day(page, '2026-09-25').click();
  await expect(page.locator('#info li')).toHaveText('08:49 ~ 15:24 · 6시간 35분포더킹2 (포 더 킹 2)');
  await expect(page.locator('#info')).toBeInViewport();
  await expect(day(page, '2026-09-25')).toHaveClass(/selected/);

  await day(page, '2026-09-24').click();
  await expect(page.locator('#info')).toContainText('기록을 시작하기 전');
});

test('월 이동 버튼은 기록 범위 안에서만 동작한다', async ({ page }) => {
  await open(page, { data: { ...BASE, since: '2026-09-25' } });
  await expect(page.locator('#month')).toHaveText('2026년 10월');
  await expect(page.locator('#next')).toBeDisabled();
  await page.locator('#prev').click();
  await expect(page.locator('#month')).toHaveText('2026년 9월');
  await expect(page.locator('.stat').first()).toHaveText('1일9월 방송한 날');
  await expect(page.locator('.stat').nth(2)).toHaveText('83%9월 휴방률');
  await expect(page.locator('.stat').nth(3)).toHaveText('6일현재 연속 휴방');
  await expect(page.locator('#prev')).toBeDisabled();
  await page.locator('#next').click();
  await expect(page.locator('#month')).toHaveText('2026년 10월');
});

test('제목에 담긴 스크립트는 실행되지 않는다', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await open(page, { data: { ...BASE, live: true, liveCheckedAt: at('2026-10-02 20:59:00'), streams: [st('2026-10-02 20:00:00', null, evil)] }, now: '2026-10-02 21:00:00' });
  await expect(page.locator('#today .detail')).toContainText(evil);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

for (const [name, opts] of [
  ['404', { status: 404, raw: 'not found' }],
  ['깨진 JSON', { raw: '{ broken' }],
  ['형식 오류', { raw: '{"streams":"nope"}' }],
]) {
  test(`데이터가 ${name}이면 오류 메시지를 보여준다`, async ({ page }) => {
    await open(page, opts);
    await expect(page.locator('#today')).toHaveText('데이터를 불러오지 못했어요.');
  });
}

test('모바일 폭에서 가로 스크롤이 없다', async ({ page }) => {
  await open(page);
  await expect(page.locator('#grid .day').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('320px에서 공백 없는 긴 영문 제목이어도 가로 스크롤이 없다', async ({ page }) => {
  const long = 'a'.repeat(60);
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page, { data: { ...BASE, streams: [st('2026-10-02 09:00:00', '2026-10-02 10:30:00', long)] } });
  await expect(page.locator('#today .detail')).toContainText(long);
  await day(page, '2026-10-02').click();
  await expect(page.locator('#info')).toContainText(long);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('320px에서도 미확인 표시가 한 줄로 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page, { now: '2026-10-06 12:00:00' });
  const mark = day(page, '2026-10-04').locator('.mark');
  await expect(mark).toHaveText('미확인');
  const lines = await mark.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(Math.round(lines)).toBe(1);
  // 한 줄이어도 칸 밖으로 넘치면 안 된다
  const overflow = await mark.evaluate((el) => el.getBoundingClientRect().left + el.scrollWidth - el.parentElement.getBoundingClientRect().right);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('오늘(점선) 칸에 키보드로 포커스하면 포커스 링이 보인다', async ({ page }) => {
  await open(page);
  await day(page, '2026-10-01').focus();
  await page.keyboard.press('Tab');
  await expect(day(page, '2026-10-02')).toBeFocused();
  const shadow = await day(page, '2026-10-02').evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
});

test('키보드로 날짜를 고르면 포커스가 같은 날짜에 남고 Tab이 다음 날로 간다', async ({ page }) => {
  await open(page);
  await day(page, '2026-10-01').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#info')).toContainText('2026-10-01 (목)');
  await expect(day(page, '2026-10-01')).toBeFocused();
  // 포커스만 있고 링이 안 보이면 키보드 사용자는 위치를 잃는다
  expect(await day(page, '2026-10-01').evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(day(page, '2026-10-02')).toBeFocused();
});

test('마우스로 날짜를 누르면 포커스 링이 생기지 않는다', async ({ page }) => {
  await open(page);
  await day(page, '2026-10-01').click();
  await expect(page.locator('#info')).toContainText('2026-10-01 (목)');
  expect(await day(page, '2026-10-01').evaluate((el) => el.matches(':focus-visible'))).toBe(false);
});

test('이전 달 버튼이 비활성화되면 키보드 포커스가 다음 달 버튼으로 옮겨진다', async ({ page }) => {
  await open(page);
  await page.locator('#prev').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#prev')).toBeDisabled();
  await expect(page.locator('#next')).toBeFocused();
  expect(await page.locator('#next').evaluate((el) => el.matches(':focus-visible'))).toBe(true);
});

test('고대비(forced-colors) 모드에서도 선택된 칸의 키보드 포커스가 선택 표시와 구분된다', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page);
  await day(page, '2026-10-01').focus();
  await page.keyboard.press('Enter');
  await expect(day(page, '2026-10-01')).toBeFocused();
  // 고대비에선 box-shadow 링이 그려지지 않으므로 칸 바깥 outline으로 보여야 한다 (선택 표시는 안쪽 -2px)
  expect(await day(page, '2026-10-01').evaluate((el) => getComputedStyle(el).outlineOffset)).toBe('2px');
});

test('달력 칸이 달력 영역 밖으로 넘치지 않는다', async ({ page }) => {
  await open(page);
  const grid = await page.locator('#grid').boundingBox();
  for (const d of ['2026-10-03', '2026-10-31']) {
    const box = await day(page, d).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(grid.x + grid.width + 0.5);
  }
});

test('콘솔 오류 없이 로드된다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await open(page);
  await expect(page.locator('#today .verdict')).toBeVisible();
  expect(errors).toEqual([]);
});
