-- 링크 카드(og:image)로 마지막에 찍은 이미지 한 장. key는 그린 HTML의 해시라, 바뀌었을 때만 다시 찍는다
CREATE TABLE IF NOT EXISTS og_card (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key TEXT NOT NULL,
  png BLOB NOT NULL,
  rendered_at TEXT NOT NULL
);
