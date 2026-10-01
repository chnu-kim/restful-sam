// data/streams.json(백업)을 D1 docs 테이블에 넣는 SQL을 출력한다.
// 사용: npm run -s seed:sql > seed.sql && npx wrangler d1 execute DB --local --file seed.sql  (원격은 --remote)
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data/streams.json', import.meta.url), 'utf8'));
if (!Array.isArray(data.streams) || typeof data.since !== 'string') throw new Error('data/streams.json 형식이 올바르지 않습니다');
const value = JSON.stringify(data).replaceAll("'", "''");
// 이미 기록이 있으면 덮어쓰지 않는다
console.log(`INSERT INTO docs (key, value) VALUES ('streams', '${value}') ON CONFLICT(key) DO NOTHING;`);
