/* 템플릿 작성 형식 — AI 자동 생성이 이 구조를 그대로 따릅니다.
   실제 대시보드(index.html)의 T 배열에 들어가는 형태입니다. */

/* ── CSS 규칙 ── */
/*
.T4 .im{position:absolute;top:0;left:0;right:0;height:940px;border-radius:0}
.T4 .bx{position:absolute;left:0;right:0;bottom:0;height:410px;background:var(--panel);padding:52px 84px}
.T4 .bx .kk{font-family:var(--en);font-size:calc(19px*var(--ts));letter-spacing:.34em;color:var(--acc)}
.T4 .bx h4{margin-top:18px;font-size:calc(40px*var(--ts)*var(--f,1));font-weight:var(--hw);line-height:1.4}
.T4 .bx p{margin-top:18px;font-size:calc(26px*var(--ts)*var(--f2,1));color:var(--sub);line-height:1.7}
.T4 .wm{position:absolute;right:84px;bottom:52px;font-size:calc(19px*var(--ts));color:var(--sub)}
*/

/* ── 템플릿 정의 ── */
{
  id: 'T4',                     // 트렌드 배치는 T + 번호
  nm: '공예 클로즈업',            // 화면에 보이는 이름
  role: 'page',                 // cover | page | end | single | story | reels
  fmt: 'F3',                    // F1~F7
  sp: 'NICOTT',                 // NICOTT | NINA
  bk: 'story',                  // product | lifestyle | story | event
  trend: '2026-08',             // 트렌드 배치 표시 (일반 템플릿은 생략)
  ev: '일본 공예 계정 공통 — 초근접 텍스처 + 소재 서술',   // 근거 (필수)
  // w, h 생략 시 1080×1350. 스토리·릴스는 w:1080, h:1920 명시
  f: [                          // 입력 슬롯
    { k:'img1',  t:'image', l:'클로즈업 사진' },
    { k:'kick',  t:'text',  l:'키커(영문)', v:'MATERIAL', max:16 },
    { k:'title', t:'area',  l:'제목', v:'손이 남긴 자국', max:18, fs:1 },   // fs:1 → --f 로 크기 조절 가능
    { k:'body',  t:'area',  l:'설명', v:'같은 모양이 하나도 없습니다.\n그래서 오래 봐도 질리지 않아요.', max:52, fs:2 }
  ],
  // v = 입력값, z = 글자크기 스타일 생성기 (z('키') 또는 z('키',2))
  r: (v,z) => `<div class="im" style="${bg(v.img1)}"></div>
    <div class="bx"><div class="kk">${esc(v.kick)}</div>
    <h4 style="${z('title')}">${nl(v.title)}</h4>
    <p style="${z('body',2)}">${nl(v.body)}</p></div>
    <div class="wm">Nicott</div>`
}

/* ── 사용 가능한 헬퍼 ──
   esc(s)  : HTML 이스케이프 (한 줄 텍스트)
   nl(s)   : 이스케이프 + 줄바꿈을 <br> 로
   bg(url) : background-image 스타일 문자열
   z(k[,n]): 글자 크기 조절 변수 (--f / --f2)

   ── 슬롯 타입 ──
   image  : 사진 (키는 img1, img2… 로 시작해야 자동 채우기가 인식)
   text   : 한 줄 입력   (max = 글자 수 제한)
   area   : 여러 줄 입력
   select : o:['보기1','보기2'] 필요
   color  : 색상 선택
*/
