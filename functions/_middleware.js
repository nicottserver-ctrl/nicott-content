// NICOTT 대시보드 접근 잠금 v2 — 개인 계정 로그인(세션 쿠키)
// · 공용 관리자: 아이디 nicott + Cloudflare Pages 환경변수 SITE_PASS (기존 비밀번호 그대로)
// · 개인 계정: 대시보드 설정 → 사용자 관리에서 관리자가 만든다 (누가 무엇을 했는지 기록됨)
// · 공개 경로: /media/* (인스타가 이미지를 가져가는 주소), /assets/* (로그인 화면 로고), /api/cron/tick (예약 발행 점검)
import { ensureSchema, readSession, verifyLogin, makeSession, sessionCookie, loginThrottle, err } from './_core.js';

const PUBLIC = [/^\/media\//, /^\/assets\//, /^\/api\/cron\/tick$/];
const HIDDEN = /^\/(functions|\.github|\.wrangler|scripts|node_modules)(\/|$)|\.md$/i; // 서버 코드·운영 문서는 주소로 열리지 않게

function loginPage(msg = '', next = '/') {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NICOTT 콘텐츠 대시보드 — 로그인</title><link rel="icon" href="/assets/nicott-icon.png">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;background:#F4F1EC;font-family:'Noto Sans KR',sans-serif;color:#1F1C19;padding:20px}
.card{width:100%;max-width:380px;background:#fff;border:1px solid #DDD6CB;border-radius:18px;padding:34px 28px 28px;box-shadow:0 18px 50px rgba(31,28,25,.08)}
.logo{display:block;height:24px;margin:0 auto 10px}h1{font-size:15px;font-weight:500;text-align:center;margin-bottom:26px;color:#3D3731}
label{display:block;font-size:13px;font-weight:500;margin:0 0 6px;color:#1F1C19}
input{width:100%;font:inherit;font-size:16px;padding:12px 14px;border:1.5px solid #CFC6B8;border-radius:10px;margin-bottom:16px;color:#1F1C19;background:#fff}
input:focus{outline:none;border-color:#2F4433;box-shadow:0 0 0 3px rgba(47,68,51,.15)}
button{width:100%;font:inherit;font-size:16px;font-weight:700;padding:13px;border:0;border-radius:10px;background:#2F4433;color:#fff;cursor:pointer}
button:hover{background:#243628}.msg{background:#FBE9E5;color:#8E2E1F;font-size:13.5px;font-weight:500;padding:10px 12px;border-radius:9px;margin-bottom:16px}
.foot{margin-top:18px;font-size:12.5px;color:#4A443C;text-align:center;line-height:1.7}
</style></head><body><form class="card" method="post" action="/login">
<img class="logo" src="/assets/nicott-logo.png" alt="NICOTT"><h1>콘텐츠 대시보드</h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<input type="hidden" name="next" value="${esc(next)}">
<label for="u">아이디</label><input id="u" name="login" autocomplete="username" autocapitalize="off" required>
<label for="p">비밀번호</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">로그인</button>
<div class="foot">계정이 없으면 관리자에게 요청해 주세요.</div></form></body></html>`;
}
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (HIDDEN.test(path)) return new Response('not found', { status: 404 });
  if (PUBLIC.some((re) => re.test(path))) return next();

  if (!env.DB) {
    return html('<p style="font:16px sans-serif;padding:40px">저장소(D1) 연결 전입니다. Cloudflare Pages 설정에서 DB 바인딩을 추가해 주세요.</p>', 503);
  }
  await ensureSchema(env);

  if (path === '/logout') {
    return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': sessionCookie('', 0) } });
  }

  if (path === '/login') {
    if (request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      if (await loginThrottle(env, ip, false)) return html(loginPage('로그인 시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.'), 429);
      const ct = request.headers.get('content-type') || '';
      const f = ct.includes('json') ? await request.json().catch(() => ({})) : Object.fromEntries(await request.formData());
      const user = await verifyLogin(env, f.login, f.password);
      if (!user) {
        await loginThrottle(env, ip, true);
        await new Promise((r) => setTimeout(r, 500));
        return html(loginPage('아이디 또는 비밀번호가 맞지 않습니다.', safeNext(f.next)), 401);
      }
      const token = await makeSession(env, user);
      return new Response(null, { status: 303, headers: { location: safeNext(f.next), 'set-cookie': sessionCookie(token, 30 * 86400) } });
    }
    const already = await readSession(env, request);
    if (already) return Response.redirect(url.origin + '/', 302);
    return html(loginPage('', safeNext(url.searchParams.get('next'))));
  }

  const user = await readSession(env, request);
  if (!user) {
    if (path.startsWith('/api/')) return err(401, '로그인이 필요합니다', { code: 'AUTH' });
    return Response.redirect(url.origin + '/login?next=' + encodeURIComponent(path + url.search), 302);
  }
  data.user = user;
  return next();
}
