-- 링크 카드(og:image)로 찍은 이미지. key는 그린 HTML의 해시라, 바뀌었을 때만 다시 찍는다.
-- 메신저가 페이지를 읽은 뒤 늦게 이미지를 받아도 페이지와 같은 카드를 주도록 최근 몇 장을 key별로 남긴다
CREATE TABLE IF NOT EXISTS og_cards (
  key TEXT PRIMARY KEY,
  png BLOB NOT NULL,
  rendered_at TEXT NOT NULL
);
