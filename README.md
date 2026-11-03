# nicott-content — NICOTT 콘텐츠 대시보드

주소: https://nicott-content.pages.dev (웹·모바일 공용 · 개인 계정 로그인)

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
| `assets/` | 니코트 로고·아이콘 |
| `.github/workflows/publish.yml` | 예약 점검 보조 호출(30분) — 주 점검은 Cloudflare Worker `nicott-cron`(10분) |

## Cloudflare 설정 (한 번)
- Pages 프로젝트 `nicott-content` → Settings → Bindings: **D1 `DB` = nicott-db**, **KV `MEDIA` = nicott-media**
- 환경변수 `SITE_PASS` (공용 계정 비밀번호 · 기존 값 유지)
- Worker `nicott-cron` — Cron `*/10 * * * *` 로 `/api/cron/tick` 호출
- 표(스키마)는 첫 접속 때 자동으로 만들어집니다. 비밀값(세션 키·토큰)은 D1 `kv` 표에만 있고 화면·API 로 내려가지 않습니다.

이전 문서: `SETUP.md`(v1 설치) · `HANDOVER.md`(인계 체크리스트) · `MANUAL.md`(v1 운영 매뉴얼)
