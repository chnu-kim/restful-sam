# 삼덕이 오늘 방송함?

치지직 스트리머 **삼덕이**가 오늘 방송했는지, 지난 날은 방송했는지 휴방했는지 달력으로 보여 주는 페이지입니다.

**https://restful-sam.chanwoos-account.workers.dev**

- 오늘 방송 여부 (방송 중이면 1~2분 안에 표시)
- 달력: 방송한 날·휴방한 날, 방송한 날은 칸을 방송 시간만큼 아래부터 채워 표시 (칸 전체 = 24시간)
- 날짜를 누르거나 마우스를 올리면 시작~종료 시각, 방송 시간, 제목, 카테고리 (방송 중 바꿨으면 구간별로)
- 보고 있는 달의 방송·휴방 일수와 휴방률, 현재 연속 방송·휴방 일수
- 라이트/다크/시스템 테마

## 동작 방식

```
            1분마다 (cron)
치지직 live-status ──────────▶ Cloudflare Worker ──▶ D1 (방송 기록 문서)
치지직 다시보기 (10분마다, 보조) ─┘        │
                                          ├─ /data/streams.json  ◀── 페이지가 읽음 (D1 최신 기록, 캐시 없음)
                                          └─ 정적 페이지 (public/)

GitHub Actions (매일 00:17 KST): D1 기록 ──▶ data/streams.json 커밋 (백업)
```

### 수집 (`worker/collect.js`, `worker/run.js`)

치지직 API에는 지난 방송 이력이나 방송 시작·종료 이벤트가 없습니다. 쓸 수 있는 건 **마지막 방송 하나**의 상태를 알려 주는 live-status뿐이라, 이것을 1분마다 확인해 기록을 쌓습니다.

- 방송을 시작 시각 기준으로 기록합니다. 자정을 넘긴 방송은 시작한 날에 속합니다.
- 방송 중이면 마지막으로 방송 중인 걸 본 시각(`seenAt`)을 남깁니다. 끊겼다가 1분 안에 다시 켜서 앞 방송의 종료를 놓치면, 그 시각을 종료 시각으로 추정하고(`closeApprox`) 화면에 "약"을 붙입니다.
- 다시보기는 남지 않을 수도 있어 **보조 수단**으로만 씁니다. 10분마다 최근 다시보기를 보고, 기록에 없는 방송을 추가하거나 추정한 종료 시각을 정확한 값으로 고칩니다.
- D1에는 바뀐 게 있을 때만, 읽은 뒤 다른 실행이 바꾸지 않았을 때만 씁니다.
- D1에 기록이 없으면 빈 기록을 새로 만들지 않고 실패합니다. 지난 기록이 사라지고 그게 백업까지 번지는 것을 막기 위해서입니다.

### 날짜 판정 (`public/src/calendar.js`)

| 상태 | 뜻 |
| --- | --- |
| 방송 | 그날 시작한 방송이 있음 |
| 휴방 | 방송이 없고, **다음 날 수집이 한 번이라도 성공함** (밤늦게 시작한 방송은 다음 날에야 잡히기 때문) |
| 확인 전 | 방송이 없지만 아직 다음 날 수집이 없음 |
| 오늘 (아직 모름) | 오늘인데 아직 방송이 없음 |
| 기록 없음 | 기록 시작일(`since`) 전 |

"방송 중"은 마지막 확인이 10분 이내일 때만 믿습니다. 그보다 오래되면 최신 정보가 아닐 수 있다고 안내합니다.

### 기록 형식 (`data/streams.json`)

```jsonc
{
  "channelId": "86d3d8d5997609df783949d107fbde24",
  "since": "2026-09-24",              // 기록 시작일
  "checkedDays": ["2026-10-02"],      // 수집이 한 번이라도 성공한 날 (휴방 확정에 사용)
  "live": false,
  "liveCheckedAt": "...",             // 방송 중일 때만, 마지막 확인 시각 (ISO)
  "streams": [
    {
      "openDate": "2026-09-24 07:55:37",  // KST
      "closeDate": "2026-09-24 16:17:09", // 방송 중이면 null
      "title": "...",
      "category": "...",
      "seenAt": "...",                    // 방송 중일 때 마지막으로 본 시각
      "closeApprox": true,                // 종료 시각이 추정값일 때
      "categories": [                     // 방송 중 카테고리를 바꿨을 때만, 구간별 시작 시각
        { "from": "2026-09-24 07:55:37", "category": "저스트 채팅" },
        { "from": "2026-09-24 09:10:00", "category": "..." }
      ],
      "ended": true                       // 끝났지만 종료 시각을 모를 때 (예전 기록)
    }
  ]
}
```

## 개발

Node 22 이상이 필요합니다.

```sh
npm ci
npm test            # 단위 테스트 + 커버리지 (기준 95%)
npm run test:e2e    # Playwright (데스크톱·모바일), 처음엔 npx playwright install chromium
```

### 화면만 고칠 때

```sh
npm run serve       # http://127.0.0.1:4173, 데이터는 저장소의 data/streams.json(백업)
```

### Worker까지 로컬에서 돌릴 때

로컬 D1은 비어 있으므로 백업 파일로 한 번 채웁니다.

```sh
npx wrangler d1 migrations apply DB --local
npm run -s seed:sql > seed.sql && npx wrangler d1 execute DB --local --file seed.sql
npm run dev         # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # 수집 한 번 실행
```

## 배포

배포는 수동입니다. CI에는 Cloudflare 토큰을 두지 않습니다.

```sh
npx wrangler login
npm run deploy      # 테스트 → D1 마이그레이션 → Worker·정적 페이지 배포
```

### D1을 새로 만들었거나 기록이 비었을 때

수집은 기록이 없으면 일부러 실패합니다. 백업 파일로 먼저 채운 뒤 배포합니다.

```sh
npx wrangler d1 migrations apply DB --remote
npm run -s seed:sql > seed.sql && npx wrangler d1 execute DB --remote --file seed.sql
```

시드 SQL은 이미 기록이 있으면 덮어쓰지 않습니다.

## 구조

```
public/            정적 페이지 (Worker의 assets)
  index.html
  src/app.js       화면 렌더링
  src/calendar.js  날짜별 상태·통계 계산 (순수 함수)
worker/
  index.js         Worker 진입 파일 (fetch·scheduled 핸들러만 export)
  run.js           D1 읽기·쓰기, 한 번의 수집
  collect.js       치지직 응답을 기록에 반영하는 로직 (순수 함수)
migrations/        D1 스키마
data/streams.json  D1 기록의 매일 백업
scripts/seed-sql.mjs  백업 파일로 D1을 채우는 SQL 생성
tests/             unit(vitest) · e2e(Playwright)
.github/workflows/ test.yml(테스트) · backup.yml(매일 백업) · pages-redirect.yml(옛 주소 리다이렉트, 한 번 실행)
```

## 한계

- 1분 사이에 방송이 시작하고 끝난 뒤 다음 방송까지 시작하면, 다시보기가 없는 한 앞 방송은 기록되지 않습니다.
- 수집이 오래 멈추면 그사이의 방송은 다시보기가 남아 있을 때만 보충됩니다.
- 치지직의 비공식 API(`api.chzzk.naver.com/polling`, `/service`)를 쓰므로 응답 형식이 바뀌면 수집이 실패할 수 있습니다.
