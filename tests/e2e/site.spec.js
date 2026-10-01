// 정적 서버로 실제 페이지를 띄우고, 데이터는 route로, 시각은 page.clock으로 고정한다
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const REAL_DATA = JSON.parse(readFileSync(join(import.meta.dirname, '../../data/streams.json'), 'utf8'));
const KST = (s) => new Date(s.replace(' ', 'T') + '+09:00');
const st = (openDate, closeDate, title = '방송', category = null) => ({ openDate, closeDate, title, category });

const BASE = {
  channelId: 'x',
  since: '2026-10-01',
  lastCheckedDate: '2026-10-02',
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

test('실제 저장된 데이터: 9/25 방송, 9/26~10/1 휴방', async ({ page }) => {
  expect(REAL_DATA.since <= '2026-09-26').toBe(true);
  await page.clock.setFixedTime(KST('2026-10-02 12:00:00'));
  await page.goto('/'); // route 없이 저장소의 data/streams.json을 그대로 사용
  await expect(day(page, '2026-10-01')).toHaveClass(/\boff\b/);
  await expect(day(page, '2026-10-01')).toContainText('휴방');
  await page.locator('#prev').click();
  await expect(day(page, '2026-09-25')).toHaveClass(/\bon\b/);
  for (const d of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
    await expect(day(page, d)).toHaveClass(/\boff\b/);
  }
});

test('오늘 아직 방송 전이면 미정, 어제 휴방 안내와 통계', async ({ page }) => {
  await open(page);
  await expect(page).toHaveTitle('삼덕이 휴방 체크');
  await expect(page.locator('#today .verdict')).toHaveText('아직 안 켬');
  await expect(page.locator('#today .detail')).toHaveText('어제는 휴방이었어요.');
  await expect(page.locator('.stat')).toHaveText(['0일방송한 날', '1일휴방한 날', '0%방송률', '1일연속 휴방']);
  await expect(day(page, '2026-10-02')).toHaveClass(/pending/);
  await expect(day(page, '2026-10-03')).toBeDisabled();
  await expect(page.locator('#footer')).toContainText('2026-10-01부터 기록');
});

test('방송 중이면 라이브 표시', async ({ page }) => {
  await open(page, { data: { ...BASE, live: true, streams: [st('2026-10-02 20:00:00', null, '저챗')] }, now: '2026-10-02 21:00:00' });
  await expect(page.locator('#today .verdict')).toHaveText('방송 중');
  await expect(page.locator('#today .live-dot')).toBeVisible();
  await expect(page.locator('#today .detail')).toHaveText('20:00 시작 · 저챗');
  await expect(day(page, '2026-10-02')).toHaveClass(/\bon\b/);
});

test('KST 자정 직후에는 날짜가 바뀐다 (UTC 15:00)', async ({ page }) => {
  await open(page, { now: '2026-10-03 00:00:30' });
  await expect(page.locator('#today .label')).toHaveText('오늘 (2026-10-03)');
  await expect(day(page, '2026-10-02')).toHaveClass(/\boff\b/);
});

test('날짜를 누르면 상세가 나오고, 선택이 바뀐다', async ({ page }) => {
  await open(page);
  await day(page, '2026-10-01').click();
  await expect(page.locator('#info')).toHaveText('2026-10-01 (목)휴방');
  await expect(day(page, '2026-10-01')).toHaveClass(/selected/);

  await page.locator('#prev').click();
  await day(page, '2026-09-25').click();
  await expect(page.locator('#info')).toContainText('08:49~15:24 · 포더킹2 (포 더 킹 2)');
  await expect(day(page, '2026-09-25')).toHaveClass(/selected/);

  await day(page, '2026-09-24').click();
  await expect(page.locator('#info')).toContainText('기록을 시작하기 전');
});

test('월 이동 버튼은 기록 범위 안에서만 동작한다', async ({ page }) => {
  await open(page);
  await expect(page.locator('#month')).toHaveText('2026년 10월');
  await expect(page.locator('#next')).toBeDisabled();
  await page.locator('#prev').click();
  await expect(page.locator('#month')).toHaveText('2026년 9월');
  await expect(page.locator('#prev')).toBeDisabled();
  await page.locator('#next').click();
  await expect(page.locator('#month')).toHaveText('2026년 10월');
});

test('제목에 담긴 스크립트는 실행되지 않는다', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await open(page, { data: { ...BASE, live: true, streams: [st('2026-10-02 20:00:00', null, evil)] }, now: '2026-10-02 21:00:00' });
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

test('콘솔 오류 없이 로드된다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await open(page);
  await expect(page.locator('#today .verdict')).toBeVisible();
  expect(errors).toEqual([]);
});
