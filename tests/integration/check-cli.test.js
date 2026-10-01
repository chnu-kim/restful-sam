// scripts/check.mjs를 실제 프로세스로 띄워 로컬 스텁 서버와 임시 데이터 파일로 검증한다
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/check.mjs', import.meta.url));

let server, baseUrl, reply, dir, dataPath;

beforeAll(async () => {
  server = createServer((req, res) => {
    const { status = 200, body } = reply(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/live-status`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sam-cli-'));
  dataPath = join(dir, 'streams.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const runCli = (env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { ...process.env, CHZZK_API_URL: baseUrl, DATA_PATH: dataPath, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

const content = { status: 'CLOSE', openDate: '2026-09-25 08:49:35', closeDate: '2026-09-25 15:24:35', liveTitle: '포더킹2', liveCategoryValue: '포 더 킹 2' };

describe('check.mjs CLI', () => {
  it('성공하면 exit 0, 파일을 만들고 User-Agent를 보낸다', async () => {
    let ua;
    reply = (req) => {
      ua = req.headers['user-agent'];
      return { body: { code: 200, content } };
    };
    const r = await runCli();
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('갱신됨: status=CLOSE');
    expect(ua).toContain('Mozilla');
    const data = JSON.parse(await readFile(dataPath, 'utf8'));
    expect(data.streams).toEqual([{ openDate: content.openDate, closeDate: content.closeDate, title: '포더킹2', category: '포 더 킹 2' }]);

    const again = await runCli();
    expect(again.stdout).toContain('변경 없음');
  });

  it('기존 since(10/1 휴방 반영)를 보존한다', async () => {
    await writeFile(dataPath, JSON.stringify({ channelId: 'x', since: '2026-10-01', lastCheckedDate: null, live: false, streams: [] }));
    reply = () => ({ body: { code: 200, content } });
    expect((await runCli()).code).toBe(0);
    expect(JSON.parse(await readFile(dataPath, 'utf8')).since).toBe('2026-10-01');
  });

  it.each([
    ['HTTP 500', () => ({ status: 500, body: 'oops' }), 'HTTP 500'],
    ['code != 200', () => ({ body: { code: 9999, content: null } }), '응답 이상'],
    ['JSON 아님', () => ({ body: '<html>' }), ''],
  ])('%s면 exit 1이고 파일을 건드리지 않는다', async (_, r, msg) => {
    reply = r;
    await writeFile(dataPath, 'untouched');
    const res = await runCli();
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(msg);
    expect(await readFile(dataPath, 'utf8')).toBe('untouched');
  });

  it('서버에 연결할 수 없으면 exit 1', async () => {
    const res = await runCli({ CHZZK_API_URL: 'http://127.0.0.1:1/none' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('fetch failed');
  });

  it('데이터 파일이 깨져 있으면 exit 1이고 덮어쓰지 않는다', async () => {
    reply = () => ({ body: { code: 200, content } });
    await writeFile(dataPath, '{ broken');
    const res = await runCli();
    expect(res.code).toBe(1);
    expect(await readFile(dataPath, 'utf8')).toBe('{ broken');
  });
});
