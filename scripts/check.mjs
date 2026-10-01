// 치지직 live-status를 조회해 data/streams.json에 방송 기록을 누적한다.
// CHZZK_API_URL, DATA_PATH 환경변수로 대상을 바꿀 수 있다 (테스트용).
import { run, DEFAULT_API_URL, DEFAULT_DATA_PATH } from './lib.mjs';

try {
  await run({
    apiUrl: process.env.CHZZK_API_URL || DEFAULT_API_URL,
    dataPath: process.env.DATA_PATH || DEFAULT_DATA_PATH,
  });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
