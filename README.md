# nicott-content — NICOTT 콘텐츠 대시보드

주소: https://nicott-content.pages.dev (웹·모바일 공용 · 개인 계정 로그인)

## v2.1 (2026-11-05) — 새 브랜드 가이드(26ver)·4K 화질·비밀번호 변경
- **새 로고**: 집 심볼 + 새 워드마크. `nicott graphic guide 26ver` PDF 안의 벡터를 그대로 옮겼습니다(원본 대조 IoU 0.99+). 폰트로 흉내 내지 않습니다.
  - 템플릿 안의 로고는 전용 글꼴 `NICOTT Logo`(N·I·C·O·T + 심볼 U+E000, index.html 에 내장)로 그립니다. 글자 간격·비율이 원본 그대로라 `letter-spacing` 을 주지 않습니다.
  - 작은 로고 = 볼드형(가이드 규정), 표지·마무리(P6·DT1·DT5) = 심볼+워드마크 조합(가이드 비율). 로고 색은 밝은 바탕 검정 `#231F20`, 짙은 바탕·사진 위 오트.
  - `assets/` 에 SVG 원본: `nicott-symbol` · `nicott-wordmark`(기본형) · `nicott-wordmark-bold` · `nicott-lockup-v` · `nicott-lockup-h` (각 `-oat` 색 버전), 아이콘 `nicott-favicon.svg` · `nicott-touch-icon.png` · `nicott-app-192/512.png`
- **공식 색값**: 오트 `#E8E4DD`(바탕) · 베이지 `#D8BFAF` · 오렌지 `#F1613E` · 그린 `#294735` · 검정 `#231F20`. 콘텐츠 기본 바탕과 대시보드 화면 바탕 = 오트 (카페24 상세페이지 DT1~5는 흰 바탕 유지).
- **4K 출력**: 모든 콘텐츠를 긴 변 3,840px(최소 2배)로 그립니다 — 피드 3072×3840, 스토리 2160×3840. 내려받기·앱에서 직접 올리기는 4K 원본, 인스타 자동 게시는 4K 원본을 반씩 단계 축소해 **가로 1440px**(Meta 공식 최대 · 8MB 이하)로 보냅니다. 올리는 사진은 긴 변 4096px까지 원본 화질을 지킵니다.
- **비밀번호 변경**: 설정 → 내 계정 → 비밀번호 바꾸기(지금 비밀번호 확인). 공용 계정 `nicott` 도 바꿀 수 있고, 바꾸면 D1 `kv` 의 `secret:master` 에 PBKDF2 해시로만 저장되며 그때부터 `SITE_PASS` 대신 이것을 씁니다. 다른 기기의 nicott 로그인은 자동으로 풀립니다. 개인 관리자 계정은 사용자 관리에서 nicott 비밀번호를 재설정할 수 있습니다.
  - 모두 잊었을 때: Cloudflare → D1 `nicott-db` 콘솔에서 `DELETE FROM kv WHERE key='secret:master';` → 다시 `SITE_PASS` 로 로그인됩니다.

## v2.0 (2026-11-04) — 공용 저장소·협업판
- **모든 데이터가 공용 저장소(Cloudflare D1)에 저장** — 어느 기기·어느 계정으로 들어와도 같은 초안·예약·설정이 보입니다. 브라우저에 갇히지 않습니다.
- **개인 계정 + 역할**: 작성자(만들기·검토 요청) / 관리자(승인·예약·연결·사용자 관리). 공용 계정 `nicott` + Pages 환경변수 `SITE_PASS` 도 관리자로 그대로 쓸 수 있습니다.
- **컨펌 흐름**: 계획 → 임시 저장 → 검토 대기 → (수정 요청) → 승인 → 예약 → 게시 완료. 콘텐츠마다 댓글·기록이 남습니다. 승인 뒤 내용이 바뀌면 자동으로 다시 검토 대기로 돌아갑니다.
- **인스타 자동 게시는 서버가 합니다**: 예약할 때 게시용 JPEG(1080px)를 만들어 `/media/…` 공개 주소에 올리고, 예약 시각이 되면 서버가 Instagram API 로 게시합니다(피드·캐러셀 최대 20장·스토리). 컴퓨터를 꺼 둬도 됩니다.
- **인스타 토큰은 서버에만 보관**하고 7일마다 자동 연장합니다(Meta `refresh_access_token`). 60일마다 다시 발급할 필요가 없습니다. 이미지 저장에 GitHub 연결이 더는 필요 없습니다.
- **AI 키도 서버에만 보관** — 브라우저에서 Anthropic API 를 직접 부르지 않습니다.
- 지운 콘텐츠는 휴지통에 남고 되살릴 수 있습니다. 영구 삭제는 관리자만.

## 구성
| 위치 | 역할 |
|---|---|
| `index.html` | 대시보드 화면 (템플릿 엔진·만들기·콘텐츠·캘린더·제품 원고·설정) |
| `functions/_middleware.js` | 로그인(세션 쿠키) · 공개 경로 예외(`/media/`, `/assets/`, `/api/cron/tick`) |
| `functions/api/[[path]].js` | 공용 저장소 API — 상태·콘텐츠·컨펌·댓글·이미지·사용자·연결·AI·예약 점검 |
| `functions/_core.js` | 공용 모듈 — 스키마 자동 생성, 세션 서명, 인스타 게시·토큰 갱신 |
| `functions/media/[key].js` | 게시용 이미지 공개 주소 (인스타가 가져감) |
| `assets/` | 니코트 공식 로고 SVG(가이드 26ver 벡터 원본)·아이콘 |
| `.github/workflows/publish.yml` | 예약 점검 보조 호출(30분) — 주 점검은 Cloudflare Worker `nicott-cron`(10분) |

## Cloudflare 설정 (한 번)
- Pages 프로젝트 `nicott-content` → Settings → Bindings: **D1 `DB` = nicott-db**, **KV `MEDIA` = nicott-media**
- 환경변수 `SITE_PASS` (공용 계정 비밀번호 · 기존 값 유지)
- Worker `nicott-cron` — Cron `*/10 * * * *` 로 `/api/cron/tick` 호출
- 표(스키마)는 첫 접속 때 자동으로 만들어집니다. 비밀값(세션 키·토큰)은 D1 `kv` 표에만 있고 화면·API 로 내려가지 않습니다.

이전 문서: `SETUP.md`(v1 설치) · `HANDOVER.md`(인계 체크리스트) · `MANUAL.md`(v1 운영 매뉴얼)
