-- 방송 기록 문서(data/streams.json과 같은 형식)를 키 하나에 통째로 저장한다
CREATE TABLE IF NOT EXISTS docs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
