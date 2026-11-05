// NICOTT 콘텐츠 대시보드 v2 — 서버 공용 모듈 (라우트 아님: onRequest 를 내보내지 않음)
// 저장: Cloudflare D1(바인딩 이름 DB) · 이미지: Cloudflare KV(바인딩 이름 MEDIA)
// 비밀값(세션 키·인스타 토큰·AI 키)은 D1 의 kv 테이블에만 있고 API 로 절대 내려가지 않는다.

export const IG_VERSION = 'v26.0';
export const IG_HOST = 'https://graph.instagram.com';
// 2026-10~ Meta 새 앱은 '통합 로그인(Unified login)'만 가능 → 비즈니스 통합 시스템 사용자 토큰(SUAT) · graph.facebook.com
export const FB_HOST = 'https://graph.facebook.com';
export const FB_VERSION = 'v27.0';
export const ROLES = { admin: '관리자', editor: '작성자' };
export const STATUSES = ['planned', 'draft', 'review', 'changes', 'approved', 'scheduled', 'published', 'failed', 'trashed'];
export const WORKSPACE_KEYS = ['settings', 'mySets', 'favTpl', 'favSet', 'archivedTpl', 'customTpl', 'pendingTpl', 'lastTplCheck', 'trend'];
const SECRET_SETTING_KEYS = ['metaToken', 'igUserId', 'ghToken', 'aiKey'];

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
export const err = (status, message, extra = {}) => json({ error: message, ...extra }, status);
export const now = () => new Date().toISOString();

/* ── 스키마 (첫 요청 때 자동 생성 · 여러 번 실행해도 안전) ── */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, version INTEGER DEFAULT 0, updated_at TEXT, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT UNIQUE, name TEXT, role TEXT, salt TEXT, hash TEXT, active INTEGER DEFAULT 1, created_at TEXT, last_login TEXT)`,
  `CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, data TEXT, status TEXT, title TEXT, author_id TEXT, author_name TEXT, updated_by TEXT, updated_by_name TEXT, created_at TEXT, updated_at TEXT, version INTEGER DEFAULT 1, scheduled_at TEXT, prev_status TEXT, attempts INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_contents_status ON contents(status, scheduled_at)`,
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, content_id TEXT, user_id TEXT, user_name TEXT, kind TEXT, body TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_id, id)`,
];
let schemaReady = null;
export function ensureSchema(env) {
  if (!env.DB) throw new Error('NO_DB');
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ── kv 헬퍼 ── */
export async function kvGet(env, key) {
  const r = await env.DB.prepare('SELECT value, version, updated_at, updated_by FROM kv WHERE key=?').bind(key).first();
  if (!r) return null;
  let value = null;
  try { value = JSON.parse(r.value); } catch { value = r.value; }
  return { value, version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by };
}
export async function kvSet(env, key, value, by = 'system') {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=kv.version+1, updated_at=excluded.updated_at, updated_by=excluded.updated_by`
  ).bind(key, JSON.stringify(value), now(), by).run();
}

/* ── 암호 유틸 ── */
const enc = new TextEncoder();
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomId = (n = 18) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: b64u(salt), hash: b64u(bits) };
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/* ── 세션 (HMAC 서명 쿠키) — 서명 키는 D1 에 자동 생성 ── */
let sessionKeyCache = null;
async function sessionKey(env) {
  if (sessionKeyCache) return sessionKeyCache;
  await env.DB.prepare(`INSERT OR IGNORE INTO kv (key, value, version, updated_at, updated_by) VALUES ('secret:session', ?, 1, ?, 'system')`)
    .bind(JSON.stringify(randomId(32)), now()).run();
  const raw = (await kvGet(env, 'secret:session')).value;
  sessionKeyCache = await crypto.subtle.importKey('raw', enc.encode(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return sessionKeyCache;
}
export const COOKIE = 'nsid';
const SESSION_DAYS = 30;
export async function makeSession(env, user) {
  const payload = b64u(enc.encode(JSON.stringify({ u: user.id, n: user.name, r: user.role, l: user.login, pv: user.pv || 0, e: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = b64u(await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload)));
  return `${payload}.${sig}`;
}
export async function readSession(env, request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const good = b64u(await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload)));
  if (!safeEqual(good, sig)) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64u(payload))); } catch { return null; }
  if (!p || p.e < Date.now()) return null;
  if (p.u !== 'master') {
    const row = await env.DB.prepare('SELECT id, name, role, active, login FROM users WHERE id=?').bind(p.u).first();
    if (!row || !row.active) return null;
    return { id: row.id, name: row.name, role: row.role, login: row.login };
  }
  // 공용 계정: 비밀번호를 바꾼 뒤에는 바꾸기 전 로그인(pv 가 다름)을 받지 않는다
  const sec = await masterSecret(env);
  if ((p.pv || 0) !== (sec?.v || 0)) return null;
  return { id: 'master', name: p.n, role: 'admin', login: 'nicott', pv: sec?.v || 0 };
}
export const sessionCookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;

/* ── 공용 계정(nicott) 비밀번호 ──
   설정 화면에서 바꾸면 D1 kv 'secret:master' 에 PBKDF2 해시로 저장된다(원문은 어디에도 남지 않음).
   v 는 바꿀 때마다 1씩 오르고, 세션의 pv 와 다르면 로그아웃된다.
   모두 잊었을 때 복구: Cloudflare → D1 nicott-db 콘솔에서  DELETE FROM kv WHERE key='secret:master';
   → 다시 Pages 환경변수 SITE_PASS 로 로그인된다. */
export async function masterSecret(env) {
  const r = await kvGet(env, 'secret:master');
  return r && r.value && r.value.hash ? r.value : null;
}
export async function setMasterPassword(env, password, by) {
  const prev = await masterSecret(env);
  const h = await hashPassword(String(password));
  const v = (prev?.v || 0) + 1;
  await kvSet(env, 'secret:master', { salt: h.salt, hash: h.hash, v, changedAt: now(), changedBy: by }, by);
  return v;
}

/* ── 로그인 검증 ── */
export async function verifyLogin(env, login, password) {
  login = String(login || '').trim().toLowerCase();
  password = String(password || '');
  if (!login || !password) return null;
  // 공용 관리자 nicott: 설정에서 비밀번호를 바꿨으면 그 비밀번호(D1 해시)만, 아직 안 바꿨으면 Pages 환경변수 SITE_PASS
  if (login === 'nicott') {
    const sec = await masterSecret(env);
    if (sec && sec.hash) {
      const { hash } = await hashPassword(password, sec.salt);
      return safeEqual(hash, sec.hash) ? { id: 'master', name: '니코트 공용', role: 'admin', login: 'nicott', pv: sec.v || 0 } : null;
    }
    if (env.SITE_PASS && safeEqual(password, String(env.SITE_PASS))) return { id: 'master', name: '니코트 공용', role: 'admin', login: 'nicott', pv: 0 };
    return null;
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE login=?').bind(login).first();
  if (!row || !row.active) return null;
  const { hash } = await hashPassword(password, row.salt);
  if (!safeEqual(hash, row.hash)) return null;
  await env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(now(), row.id).run();
  return { id: row.id, name: row.name, role: row.role, login: row.login };
}

/* 로그인 실패 제한 — 같은 IP 15분에 10회 */
export async function loginThrottle(env, ip, failed) {
  const key = 'throttle:' + ip;
  const cur = (await kvGet(env, key))?.value || { n: 0, t: Date.now() };
  if (Date.now() - cur.t > 15 * 60e3) { cur.n = 0; cur.t = Date.now(); }
  if (failed) { cur.n++; await kvSet(env, key, cur); }
  return cur.n >= 10;
}

/* ── 워크스페이스(공용 설정·세트·즐겨찾기 등) ── */
export function cleanSettings(s) {
  const o = { ...(s || {}) };
  SECRET_SETTING_KEYS.forEach((k) => delete o[k]);
  delete o.ghOwner; delete o.ghRepo; delete o.ghBranch; delete o.ghOk; delete o.lastSync;
  return o;
}

/* ── 콘텐츠 직렬화 ── */
export function rowToContent(r) {
  let d = {};
  try { d = JSON.parse(r.data || '{}'); } catch {}
  return Object.assign(d, {
    id: r.id, status: r.status, title: r.title || d.title || '', version: r.version,
    authorId: r.author_id, authorName: r.author_name, updatedBy: r.updated_by, updatedByName: r.updated_by_name,
    createdAt: r.created_at, updatedAt: r.updated_at, scheduledAt: r.scheduled_at || null, prevStatus: r.prev_status || null,
    attempts: r.attempts || 0, commentCount: r.comment_count || 0,
  });
}
// 클라이언트가 보낸 데이터 중 서버가 관리하는 칸은 버린다
export function stripServerFields(d) {
  const o = { ...(d || {}) };
  ['status', 'version', 'authorId', 'authorName', 'updatedBy', 'updatedByName', 'updatedAt', 'prevStatus', 'attempts', 'commentCount',
    'mediaUrls', 'mediaId', 'mediaIds', 'permalink', 'publishedAt', 'lastError', 'errorAt', 'publishedBy', 'approvedBy', 'approvedAt'].forEach((k) => delete o[k]);
  return o;
}
export const contentFingerprint = (d) => JSON.stringify([d.pages || [], d.caption || '', d.channel || '', d.skin || '']);

export async function addComment(env, contentId, user, kind, body) {
  await env.DB.prepare('INSERT INTO comments (content_id, user_id, user_name, kind, body, created_at) VALUES (?,?,?,?,?,?)')
    .bind(contentId, user?.id || 'system', user?.name || '시스템', kind, String(body || '').slice(0, 2000), now()).run();
}

/* ── 인스타그램 ──
   두 가지 토큰을 모두 받는다.
   · kind 'ig'   : Instagram 로그인 토큰(IG…) — graph.instagram.com, 60일, ig_refresh_token 으로 연장 (예전 앱)
   · kind 'suat' : 통합 로그인 토큰(EA…, 비즈니스 통합 시스템 사용자) — graph.facebook.com, 만료는 구성에 따라(없음 가능)
     /me 는 시스템 사용자라서 인스타 계정 ID 는 igFindAccounts 로 얻는다 (비즈니스 계정 → 페이지 연결 계정 순) */
export const igAuth = (ig) => ({ token: ig.token, kind: ig.kind || 'ig' });
const igBase = (auth) => (auth && typeof auth === 'object' && auth.kind === 'suat') ? `${FB_HOST}/${FB_VERSION}` : `${IG_HOST}/${IG_VERSION}`;
export async function igRequest(method, path, params, auth) {
  const token = typeof auth === 'string' ? auth : auth.token;
  const url = new URL(`${igBase(auth)}/${path}`);
  let init = { method };
  const all = { ...params, access_token: token };
  if (method === 'GET') Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));
  else init.body = new URLSearchParams(all);
  const r = await fetch(url.toString(), init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = new Error(String(j.error?.message || `Instagram HTTP ${r.status}`).split(token).join('…'));   // 오류 문구에 토큰이 섞여 나오지 않게
    e.code = j.error?.code; e.status = r.status;
    throw e;
  }
  return j;
}
export async function igGetSecret(env) { return (await kvGet(env, 'secret:ig'))?.value || null; }
export function igPublicStatus(ig) {
  if (!ig) return { connected: false };
  return {
    connected: !!ig.token, kind: ig.kind || 'ig', username: ig.username || '', userId: ig.userId ? String(ig.userId).slice(0, 4) + '…' : '',
    accounts: (ig.accounts || []).map((a) => a.username).filter(Boolean),
    connectedAt: ig.connectedAt, connectedBy: ig.connectedBy, refreshedAt: ig.refreshedAt || null,
    expiresAt: ig.expiresAt || null, expiresNever: !!ig.expiresNever, expiresEstimated: !!ig.expiresEstimated, lastError: ig.lastError || null, lastCheckAt: ig.lastCheckAt || null,
  };
}
async function waitContainer(id, token) {
  for (let i = 0; i < 20; i++) {
    const j = await igRequest('GET', id, { fields: 'status_code' }, token);
    if (j.status_code === 'FINISHED' || j.status_code === 'PUBLISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error('인스타 처리 실패 (' + j.status_code + ')');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('인스타 처리 시간이 초과됐습니다');
}
// 게시: 피드 1장=단일, 2~20장=캐러셀, 스토리=장마다 1개씩 · 게시물 ID 를 못 받으면 실패(S-10)
export async function igPublish(ig, content) {
  const urls = content.mediaUrls || [];
  if (!urls.length) throw new Error('게시할 이미지가 없습니다 (예약 시 이미지가 만들어지지 않았습니다)');
  if (content.channel === 'reels') throw new Error('릴스는 영상이 필요해 자동 게시를 지원하지 않습니다');
  const uid = ig.userId, token = igAuth(ig);
  if (content.channel === 'story') {
    const ids = [];
    for (const u of urls) {
      const c = await igRequest('POST', `${uid}/media`, { image_url: u, media_type: 'STORIES' }, token);
      await waitContainer(c.id, token);
      const p = await igRequest('POST', `${uid}/media_publish`, { creation_id: c.id }, token);
      if (!p.id) throw new Error('게시물 ID를 받지 못했습니다');
      ids.push(p.id);
    }
    return { mediaId: ids[0], mediaIds: ids, permalink: null };
  }
  if (urls.length > 20) throw new Error('캐러셀은 최대 20장입니다');
  let creation;
  if (urls.length === 1) {
    creation = (await igRequest('POST', `${uid}/media`, { image_url: urls[0], caption: content.caption || '' }, token)).id;
  } else {
    const kids = [];
    for (const u of urls) kids.push((await igRequest('POST', `${uid}/media`, { image_url: u, is_carousel_item: 'true' }, token)).id);
    for (const k of kids) await waitContainer(k, token);
    creation = (await igRequest('POST', `${uid}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption: content.caption || '' }, token)).id;
  }
  await waitContainer(creation, token);
  const pub = await igRequest('POST', `${uid}/media_publish`, { creation_id: creation }, token);
  if (!pub.id) throw new Error('게시물 ID를 받지 못했습니다');
  let permalink = null;
  try { permalink = (await igRequest('GET', pub.id, { fields: 'permalink' }, token)).permalink || null; } catch {}
  return { mediaId: pub.id, mediaIds: [pub.id], permalink };
}
// 토큰 만료 시각 (통합 로그인 토큰) — 0 이면 만료 없음
async function suatExpiry(token) {
  try {
    const u = new URL(`${FB_HOST}/${FB_VERSION}/debug_token`);
    u.searchParams.set('input_token', token); u.searchParams.set('access_token', token);
    const j = await (await fetch(u.toString())).json();
    const ex = Number(j?.data?.expires_at ?? j?.data?.data_access_expires_at ?? NaN);
    if (ex === 0) return { expiresAt: null, never: true };
    if (ex > 0) return { expiresAt: new Date(ex * 1000).toISOString(), never: false };
  } catch {}
  return { expiresAt: null, never: false, unknown: true };
}
/* 통합 로그인 토큰으로 접근 가능한 인스타 계정 찾기 (v2.1.2)
   ① 비즈니스가 소유·공유받은 인스타 계정: /me/assigned_instagram_accounts
   ② 페이지에 연결된 인스타 계정: /me/accounts → instagram_business_account
      (니코트처럼 인스타가 다른 사람이 관리하는 FB 페이지에 묶여 있고, 페이지만 파트너로 공유받은 경우)
   ③ 같은 정보를 시스템 사용자 경로로: /me/assigned_pages
   찾은 계정마다 via·pageId 를 남겨 둔다. 어디서도 못 찾으면 시도한 경로별 결과를 오류 문구에 담는다 (토큰은 안 담김). */
export async function igFindAccounts(auth) {
  const found = new Map(); const notes = [];
  const add = (a, via, pageId) => { if (a && a.id && !found.has(String(a.id))) found.set(String(a.id), { id: String(a.id), username: a.username || '', via, pageId: pageId || null }); };
  try {
    const j = await igRequest('GET', 'me/assigned_instagram_accounts', { fields: 'id,username', limit: '50' }, auth);
    (j.data || []).forEach((a) => add(a, 'assigned'));
    notes.push(`비즈니스 인스타 ${(j.data || []).length}개`);
  } catch (e) { notes.push('비즈니스 인스타 조회 실패: ' + e.message); }
  for (const path of ['me/accounts', 'me/assigned_pages']) {
    try {
      const j = await igRequest('GET', path, { fields: 'id,name,instagram_business_account{id,username}', limit: '50' }, auth);
      const pages = j.data || [];
      pages.forEach((pg) => add(pg.instagram_business_account, 'page', pg.id));
      notes.push(`${path === 'me/accounts' ? '페이지' : '할당 페이지'} ${pages.length}개(인스타 연결 ${pages.filter((pg) => pg.instagram_business_account).length})`);
    } catch (e) { notes.push(`${path} 조회 실패: ${e.message}`); }
  }
  const accounts = [...found.values()];
  // 페이지 경로로 찾은 계정은 username 이 비어 올 수 있어 한 번 더 읽는다
  for (const a of accounts) if (!a.username) { try { a.username = (await igRequest('GET', a.id, { fields: 'username' }, auth)).username || ''; } catch {} }
  return { accounts, notes };
}

// 붙여넣은 토큰으로 연결 정보 만들기 — 토큰 모양(EA…/IG…)으로 먼저 시도할 방식을 정하고, 안 되면 다른 방식도 시도
export async function igConnectToken(token, prefer) {
  const want = String(prefer || '').replace(/^@/, '').toLowerCase();
  const trySuat = async () => {
    const auth = { token, kind: 'suat' };
    const { accounts, notes } = await igFindAccounts(auth);
    if (!accounts.length) throw new Error('이 토큰으로 찾은 인스타 계정이 없습니다 — 토큰을 만들 때 니코트 페이지(또는 nicott_kitchen)를 선택했는지 확인해 주세요. [확인 결과: ' + notes.join(' · ') + ']');
    const pick = accounts.find((a) => a.username.toLowerCase() === want) || accounts[0];
    let businessId = null;
    try { businessId = (await igRequest('GET', 'me', { fields: 'client_business_id' }, auth)).client_business_id || null; } catch {}
    const ex = await suatExpiry(token);
    return { token, kind: 'suat', userId: pick.id, username: pick.username, accounts, businessId,
      expiresAt: ex.expiresAt, expiresNever: !!ex.never, expiresEstimated: !!ex.unknown };
  };
  const tryIg = async () => {
    const me = await igRequest('GET', 'me', { fields: 'user_id,username' }, token);
    return { token, kind: 'ig', userId: me.user_id || me.id, username: me.username || '',
      expiresAt: new Date(Date.now() + 60 * 864e5).toISOString(), expiresEstimated: true };
  };
  const order = /^IG/.test(token) ? [tryIg, trySuat] : [trySuat, tryIg];
  const errs = [];
  for (const f of order) { try { return await f(); } catch (e) { errs.push(e.message); } }
  throw new Error(errs[0] || '토큰을 확인하지 못했습니다');
}
export async function igRefresh(env, ig) {
  if ((ig.kind || 'ig') === 'suat') {
    // 통합 로그인 토큰: ig_refresh_token 이 없다 → 살아 있는지·만료 시각만 다시 확인
    const { accounts } = await igFindAccounts(igAuth(ig));
    if (!accounts.some((a) => a.id === String(ig.userId))) throw new Error('연결했던 인스타 계정이 더 이상 이 토큰으로 보이지 않습니다 — 다시 연결해 주세요');
    const ex = await suatExpiry(ig.token);
    ig.expiresAt = ex.expiresAt; ig.expiresNever = !!ex.never; ig.expiresEstimated = !!ex.unknown;
    ig.refreshedAt = now(); ig.lastError = null;
    if (ig.expiresAt && new Date(ig.expiresAt).getTime() - Date.now() < 10 * 864e5) ig.lastError = '토큰 만료가 10일 안으로 다가왔습니다 — [설정]에서 다시 연결해 주세요';
    await kvSet(env, 'secret:ig', ig, 'system');
    return ig;
  }
  const url = `${IG_HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(ig.token)}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) throw new Error(j.error?.message || `토큰 갱신 실패 (HTTP ${r.status})`);
  ig.token = j.access_token;
  ig.refreshedAt = now();
  ig.expiresAt = new Date(Date.now() + (Number(j.expires_in) || 60 * 86400) * 1000).toISOString();
  ig.expiresEstimated = false;
  ig.lastError = null;
  await kvSet(env, 'secret:ig', ig, 'system');
  return ig;
}
