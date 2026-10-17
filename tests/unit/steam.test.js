import { describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index.js';
import { diffGames, parseProfile, streamedHours, watchSteam } from '../../worker/steam.js';
import { parseKst } from '../../worker/collect.js';

const game = (name, hours) =>
  `<mostPlayedGame><gameName><![CDATA[${name}]]></gameName><hoursPlayed>1.0</hoursPlayed><hoursOnRecord>${hours}</hoursOnRecord></mostPlayedGame>`;
const profileXml = (games, privacy = 'public') =>
  `<?xml version="1.0"?><profile><steamID64>76561198283748611</steamID64><onlineState>offline</onlineState>` +
  `<privacyState>${privacy}</privacyState><mostPlayedGames>${games.join('')}</mostPlayedGames></profile>`;

// D1 스텁: steam_snapshots와 docs(streams)만 흉내 낸다
function fakeDb({ snapshots = [], streams } = {}) {
  const rows = new Map(snapshots.map((s) => [s.date, s]));
  return {
    rows,
    prepare: (sql) => ({
      first: async () => {
        expect(sql).toBe('SELECT taken_at, games FROM steam_snapshots ORDER BY date DESC LIMIT 1');
        const last = [...rows.keys()].sort().at(-1);
        return last ? rows.get(last) : null;
      },
      bind: (...args) => ({
        first: async () => {
          if (sql.startsWith('SELECT value FROM docs')) return streams ? { value: JSON.stringify({ since: '2026-09-24', streams }) } : null;
          expect(sql).toBe('SELECT 1 FROM steam_snapshots WHERE date = ?');
          return rows.has(args[0]) ? { 1: 1 } : null;
        },
        run: async () => {
          expect(sql).toBe('INSERT OR IGNORE INTO steam_snapshots (date, taken_at, games) VALUES (?, ?, ?)');
          const [date, taken_at, games] = args;
          if (rows.has(date)) return { meta: { changes: 0 } };
          rows.set(date, { date, taken_at, games });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
}

const xmlResponse = (body, status = 200) => vi.fn(async () => new Response(body, { status }));
// KST 2026-10-17 00:00 (10분 단위)
const NOW = Date.parse('2026-10-16T15:00:00Z');
const PREV = { date: '2026-10-16', taken_at: '2026-10-15T15:00:00.000Z', games: JSON.stringify({ 'TEKKEN 8': 130, 'Project Zomboid': 1840 }) };
const quiet = { log: () => {}, warn: () => {} };

describe('parseProfile', () => {
  it('게임별 누적 시간을 쉼표 없이 숫자로 읽는다', () => {
    const p = parseProfile(profileXml([game('Project Zomboid', '1,847'), game('For The King II', '16.4')]));
    expect(p).toEqual({ privacy: 'public', onlineState: 'offline', games: { 'Project Zomboid': 1847, 'For The King II': 16.4 } });
  });

  it('이름이나 시간이 없는 항목은 건너뛴다', () => {
    const p = parseProfile(profileXml(['<mostPlayedGame><gameName>X</gameName></mostPlayedGame>', game('Y', 'abc')]));
    expect(p.games).toEqual({});
  });

  it('프로필 응답이 아니면 throw', () => {
    expect(() => parseProfile('<html>login</html>')).toThrow('Steam 프로필 응답 이상');
  });
});

describe('diffGames', () => {
  it('늘어난 게임만 모으고, 처음 보이는 게임은 이름만 남긴다', () => {
    expect(diffGames({ A: 10, B: 5, C: 1 }, { A: 12.25, B: 5, D: 3 })).toEqual({ played: { A: 2.3 }, firstSeen: ['D'] });
  });
});

describe('streamedHours', () => {
  const from = parseKst('2026-10-16 00:00:00');
  const to = parseKst('2026-10-17 00:00:00');
  it('구간 밖은 자르고, 진행 중인 방송은 구간 끝까지 센다', () => {
    const streams = [
      { openDate: '2026-10-15 22:00:00', closeDate: '2026-10-16 02:00:00' },
      { openDate: '2026-10-16 10:00:00', closeDate: '2026-10-16 11:30:00' },
      { openDate: '2026-10-16 23:00:00', closeDate: null },
      { openDate: '2026-10-14 10:00:00', closeDate: '2026-10-14 12:00:00' },
    ];
    expect(streamedHours(streams, from, to)).toBe(4.5);
  });
});

describe('watchSteam', () => {
  it('10분 단위가 아니면 아무것도 하지 않는다', async () => {
    const fetchImpl = vi.fn();
    expect(await watchSteam({ DB: fakeDb() }, { fetchImpl, now: NOW + 60000, ...quiet })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('오늘 스냅샷이 이미 있으면 조회하지 않는다', async () => {
    const fetchImpl = vi.fn();
    const DB = fakeDb({ snapshots: [{ ...PREV, date: '2026-10-17' }] });
    expect(await watchSteam({ DB }, { fetchImpl, now: NOW, ...quiet })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('첫 스냅샷은 저장만 한다', async () => {
    const DB = fakeDb();
    const log = vi.fn();
    const r = await watchSteam({ DB }, { fetchImpl: xmlResponse(profileXml([game('TEKKEN 8', '137')])), now: NOW, log });
    expect(r).toEqual({ date: '2026-10-17', games: { 'TEKKEN 8': 137 } });
    expect(DB.rows.get('2026-10-17').taken_at).toBe(new Date(NOW).toISOString());
    expect(JSON.parse(log.mock.calls[0][0]).message).toBe('Steam 첫 스냅샷');
  });

  it('방송 시간보다 1시간 넘게 더 했으면 방송 밖 플레이로 남긴다', async () => {
    const DB = fakeDb({ snapshots: [PREV], streams: [{ openDate: '2026-10-16 10:00:00', closeDate: '2026-10-16 12:00:00' }] });
    const log = vi.fn();
    const xml = profileXml([game('TEKKEN 8', '137'), game('Project Zomboid', '1,840')]);
    const r = await watchSteam({ DB }, { fetchImpl: xmlResponse(xml), now: NOW, log });
    expect(r).toMatchObject({ played: { 'TEKKEN 8': 7 }, firstSeen: [], steamHours: 7, streamedHours: 2, offStream: true });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ message: 'Steam 방송 밖 플레이', onlineState: 'offline' });
  });

  it('방송 중에 한 만큼이면 방송 밖 플레이가 아니다', async () => {
    const DB = fakeDb({ snapshots: [PREV], streams: [{ openDate: '2026-10-16 10:00:00', closeDate: '2026-10-16 16:00:00' }] });
    const xml = profileXml([game('TEKKEN 8', '137'), game('Project Zomboid', '1,840')]);
    const r = await watchSteam({ DB }, { fetchImpl: xmlResponse(xml), now: NOW, ...quiet });
    expect(r).toMatchObject({ steamHours: 7, streamedHours: 6, offStream: false });
  });

  it('방송이 없는데 새 게임이 보이면 방송 밖 플레이다 (방송 기록이 없어도)', async () => {
    const DB = fakeDb({ snapshots: [PREV] });
    const xml = profileXml([game('TEKKEN 8', '130'), game('Project Zomboid', '1,840'), game('For The King II', '16.4')]);
    const r = await watchSteam({ DB }, { fetchImpl: xmlResponse(xml), now: NOW, ...quiet });
    expect(r).toMatchObject({ played: {}, firstSeen: ['For The King II'], streamedHours: 0, offStream: true });
  });

  it('비공개면 찍지 않고 경고만 남긴다', async () => {
    const DB = fakeDb();
    const warn = vi.fn();
    expect(await watchSteam({ DB }, { fetchImpl: xmlResponse(profileXml([], 'private')), now: NOW, warn })).toBeNull();
    expect(DB.rows.size).toBe(0);
    expect(JSON.parse(warn.mock.calls[0][0]).privacy).toBe('private');
  });

  it('HTTP 오류는 throw', async () => {
    await expect(watchSteam({ DB: fakeDb() }, { fetchImpl: xmlResponse('', 429), now: NOW, ...quiet })).rejects.toThrow('Steam 프로필 HTTP 429');
  });

  it('그 사이 다른 실행이 먼저 찍었으면 비교하지 않는다', async () => {
    const DB = fakeDb();
    const fetchImpl = vi.fn(async () => {
      DB.rows.set('2026-10-17', PREV);
      return new Response(profileXml([]));
    });
    expect(await watchSteam({ DB }, { fetchImpl, now: NOW, ...quiet })).toBeNull();
  });
});

describe('Worker 예약 실행', () => {
  it('Steam 감시가 실패해도 경고만 남기고 방송 수집과 따로 끝난다', async () => {
    const DB = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 끊김'); } }) }) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits = [];
    await worker.scheduled({ scheduledTime: NOW }, { DB }, { waitUntil: (p) => waits.push(p) });
    await expect(waits[0]).rejects.toThrow();
    await expect(waits[1]).resolves.toBeUndefined();
    expect(JSON.parse(warn.mock.calls.at(-1)[0])).toEqual({ message: 'Steam 감시 실패', error: 'D1 끊김' });
    fetchSpy.mockRestore();
    warn.mockRestore();
  });
});
