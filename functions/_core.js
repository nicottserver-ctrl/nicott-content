// NICOTT 콘텐츠 대시보드 v2 — 서버 공용 모듈 (라우트 아님: onRequest 를 내보내지 않음)
// 저장: Cloudflare D1(바인딩 이름 DB) · 이미지: Cloudflare KV(바인딩 이름 MEDIA)
// 비밀값(세션 키·인스타 토큰·AI 키)은 D1 의 kv 테이블에만 있고 API 로 절대 내려가지 않는다.

export const IG_VERSION = 'v26.0';
export const IG_HOST = 'https://graph.instagram.com';
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

/* ── 인스타그램 (Instagram API with Instagram Login · graph.instagram.com) ── */
export async function igRequest(method, path, params, token) {
  const url = new URL(`${IG_HOST}/${IG_VERSION}/${path}`);
  let init = { method };
  const all = { ...params, access_token: token };
  if (method === 'GET') Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));
  else init.body = new URLSearchParams(all);
  const r = await fetch(url.toString(), init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = new Error(j.error?.message || `Instagram HTTP ${r.status}`);
    e.code = j.error?.code; e.status = r.status;
    throw e;
  }
  return j;
}
export async function igGetSecret(env) { return (await kvGet(env, 'secret:ig'))?.value || null; }
export function igPublicStatus(ig) {
  if (!ig) return { connected: false };
  return {
    connected: !!ig.token, username: ig.username || '', userId: ig.userId ? String(ig.userId).slice(0, 4) + '…' : '',
    connectedAt: ig.connectedAt, connectedBy: ig.connectedBy, refreshedAt: ig.refreshedAt || null,
    expiresAt: ig.expiresAt || null, expiresEstimated: !!ig.expiresEstimated, lastError: ig.lastError || null, lastCheckAt: ig.lastCheckAt || null,
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
  const uid = ig.userId, token = ig.token;
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
export async function igRefresh(env, ig) {
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
