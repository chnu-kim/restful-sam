-- 삼덕이 Steam 프로필의 게임별 누적 플레이 시간을 KST 날짜마다 한 번 찍어 둔다 (games: {게임 이름: 시간} JSON)
CREATE TABLE IF NOT EXISTS steam_snapshots (
  date TEXT PRIMARY KEY,
  taken_at TEXT NOT NULL,
  games TEXT NOT NULL
);
