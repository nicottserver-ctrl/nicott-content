// NICOTT 대시보드 접근 잠금 — 내부자 전용
// 브라우저가 아이디/비밀번호를 물어봅니다. 아이디: nicott / 비밀번호: Cloudflare Pages 설정의 SITE_PASS 값
// 비밀번호 변경: Cloudflare → Workers & Pages → nicott-content → Settings → Variables → SITE_PASS 수정 후 재배포
export async function onRequest(context){
  const {request,env,next}=context;
  const expected='Basic '+btoa('nicott:'+(env.SITE_PASS||''));
  const auth=request.headers.get('Authorization')||'';
  if(env.SITE_PASS&&auth===expected)return next();
  return new Response('NICOTT 내부 페이지입니다. 로그인이 필요합니다.',{status:401,
    headers:{'WWW-Authenticate':'Basic realm="NICOTT", charset="UTF-8"','content-type':'text/plain;charset=utf-8'}});
}
