// NICOTT 콘텐츠 대시보드 v2 — 공용 저장소 API
// 모든 경로는 _middleware.js 가 로그인 확인 후 context.data.user 를 넣어 준다 (/api/cron/tick 만 예외)
import {
  ensureSchema, json, err, now, kvGet, kvSet, randomId, hashPassword, ROLES, STATUSES, WORKSPACE_KEYS, cleanSettings,
  verifyLogin, loginThrottle, makeSession, sessionCookie, masterSecret, setMasterPassword,
  rowToContent, stripServerFields, contentFingerprint, addComment, igRequest, igGetSecret, igPublicStatus, igPublish, igRefresh, igAuth, igConnectToken, igFindAccounts, collectInsights, FB_HOST, FB_VERSION,
} from '../_core.js';

const isAdmin = (u) => u && u.role === 'admin';
const body = async (request) => { try { return await request.json(); } catch { return {}; } };
const SERVER_KEEP = ['mediaUrls', 'mediaId', 'mediaIds', 'permalink', 'publishedAt', 'lastError', 'errorAt', 'publishedBy', 'approvedBy', 'approvedAt'];

async function contentRow(env, id) {
  return env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM comments m WHERE m.content_id=c.id AND m.kind='comment') AS comment_count FROM contents c WHERE c.id=?`).bind(id).first();
}
async function saveRow(env, id, row) {
  await env.DB.prepare(`UPDATE contents SET data=?, status=?, title=?, updated_by=?, updated_by_name=?, updated_at=?, version=version+1, scheduled_at=?, prev_status=?, attempts=? WHERE id=?`)
    .bind(row.data, row.status, row.title, row.updated_by, row.updated_by_name, now(), row.scheduled_at, row.prev_status, row.attempts || 0, id).run();
}
async function stateRev(env) {
  const a = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM contents').first();
  const b = await env.DB.prepare('SELECT MAX(id) AS c FROM comments').first();
  const w = await env.DB.prepare(`SELECT version FROM kv WHERE key='workspace'`).first();
  const i = await env.DB.prepare(`SELECT version FROM kv WHERE key='secret:ig'`).first();
  return [a?.n || 0, a?.m || '', b?.c || 0, w?.version || 0, i?.version || 0].join('|');
}
async function integrations(env) {
  const ig = await igGetSecret(env);
  const ai = (await kvGet(env, 'secret:ai'))?.value;
  const cron = (await kvGet(env, 'cron:last'))?.value || null;
  return { instagram: igPublicStatus(ig), ai: { connected: !!ai?.key, model: ai?.model || null, connectedAt: ai?.connectedAt || null }, cron: cron ? { lastRunAt: cron.at, summary: cron.summary || null } : null };
}

/* ══ 상태 전환 규칙 ══ */
const ACTIONS = {
  request_review: { from: ['draft', 'changes', 'planned'], to: 'review', admin: false, log: '검토를 요청했습니다' },
  to_draft: { from: ['review', 'changes', 'approved', 'failed', 'planned'], to: 'draft', admin: false, log: '임시 저장 상태로 되돌렸습니다' },
  request_changes: { from: ['review', 'approved', 'scheduled', 'failed'], to: 'changes', admin: true, note: true, log: '수정을 요청했습니다' },
  approve: { from: ['review', 'draft', 'changes', 'planned'], to: 'approved', admin: true, log: '승인했습니다' },
  schedule: { from: ['approved', 'review', 'draft', 'changes', 'failed', 'scheduled'], to: 'scheduled', admin: true, log: '예약했습니다' },
  unschedule: { from: ['scheduled', 'failed'], to: 'approved', admin: true, log: '예약을 취소했습니다 (승인 상태 유지)' },
  publish_now: { from: ['approved', 'scheduled', 'failed', 'review', 'draft', 'changes'], to: 'published', admin: true, log: '바로 게시했습니다' },
  mark_published: { from: ['approved', 'scheduled', 'failed', 'review', 'draft', 'changes'], to: 'published', admin: true, log: '수동 게시 완료로 기록했습니다' },
  trash: { from: STATUSES.filter((s) => s !== 'trashed'), to: 'trashed', admin: false, log: '휴지통으로 옮겼습니다' },
  restore: { from: ['trashed'], to: null, admin: false, log: '휴지통에서 되살렸습니다' },
  purge: { from: ['trashed'], to: null, admin: true, log: '' },
};

function validMediaUrls(list, origin) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return false;
  return list.every((u) => typeof u === 'string' && u.startsWith(origin + '/media/'));
}

/* v2.2 게시 전 승인(컨펌) 규칙 — 설정의 requireApproval(기본 켜짐) · approvers(승인자 사용자 ID 목록)
   · 승인자가 지정돼 있으면 그 사람만 승인·수정 요청을 할 수 있다 (없으면 관리자 누구나)
   · 승인 필수면 '승인됨' 이 아닌 콘텐츠는 승인자만 예약·바로 게시·게시 기록을 할 수 있다 (= 승인과 동시에) */
async function approvalPolicy(env) {
  const ws = (await kvGet(env, 'workspace'))?.value || {};
  const st = ws.settings || {};
  return { required: st.requireApproval !== false, approvers: Array.isArray(st.approvers) ? st.approvers.map(String) : [] };
}
const canApprove = (pol, u) => !!u && (pol.approvers.length ? pol.approvers.includes(String(u.id)) : isAdmin(u));

async function doAction(env, user, id, b, origin) {
  const spec = ACTIONS[b.action];
  if (!spec) return err(400, '알 수 없는 동작입니다');
  const pol = await approvalPolicy(env);
  const approverAct = ['approve', 'request_changes'].includes(b.action);
  if (approverAct) { if (!canApprove(pol, user)) return err(403, pol.approvers.length ? '승인 권한이 없습니다 — 승인자로 지정된 분(대표·MD)만 승인하거나 수정 요청을 할 수 있습니다' : '관리자만 할 수 있습니다'); }
  else if (spec.admin && !isAdmin(user)) return err(403, '관리자만 할 수 있습니다');
  const row = await contentRow(env, id);
  if (!row) return err(404, '콘텐츠를 찾을 수 없습니다');
  if (b.baseVersion && Number(b.baseVersion) !== row.version) return err(409, '다른 사람이 먼저 수정했습니다. 최신 내용을 불러옵니다.', { current: rowToContent(row) });
  if (!spec.from.includes(row.status)) return err(409, `지금 상태(${row.status})에서는 할 수 없습니다`, { current: rowToContent(row) });
  if (pol.required && ['schedule', 'publish_now', 'mark_published'].includes(b.action) && !['approved', 'scheduled', 'failed'].includes(row.status) && !canApprove(pol, user))
    return err(409, '게시 전 승인이 필요합니다 — 먼저 [검토 요청]을 보내 대표·MD 승인을 받아 주세요', { current: rowToContent(row) });
  const note = String(b.note || '').trim();
  if (spec.note && !note) return err(400, '수정 요청 내용을 적어 주세요');

  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch {}
  const next = { ...row, updated_by: user.id, updated_by_name: user.name, attempts: row.attempts || 0 };

  if (b.action === 'purge') {
    await env.DB.prepare('DELETE FROM contents WHERE id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM comments WHERE content_id=?').bind(id).run();
    return json({ ok: true, purged: id });
  }
  if (b.action === 'trash') next.prev_status = row.status;
  if (b.action === 'restore') { next.status = row.prev_status && row.prev_status !== 'trashed' ? row.prev_status : 'draft'; next.prev_status = null; }
  else next.status = spec.to;

  if (b.action === 'schedule' || b.action === 'publish_now') {
    const urls = b.mediaUrls || data.mediaUrls;
    if (!validMediaUrls(urls, origin)) return err(400, '게시용 이미지가 없습니다. 이미지를 만든 뒤 다시 시도해 주세요.');
    if (data.channel === 'reels') return err(400, '릴스는 영상이 필요해 자동 게시를 지원하지 않습니다. 이미지를 내려받아 앱에서 올린 뒤 [게시 완료로 기록]을 눌러 주세요.');
    data.mediaUrls = urls;
    if (row.status === 'review' || row.status === 'draft' || row.status === 'changes') { data.approvedBy = user.name; data.approvedAt = now(); }
  }
  if (b.action === 'approve') { data.approvedBy = user.name; data.approvedAt = now(); }
  if (b.action === 'schedule') {
    const t = new Date(b.scheduledAt || '');
    if (isNaN(t.getTime())) return err(400, '예약 날짜와 시각을 확인해 주세요');
    next.scheduled_at = t.toISOString();
    next.attempts = 0;
    delete data.lastError;
  }
  if (b.action === 'publish_now') {
    const ig = await igGetSecret(env);
    if (!ig?.token) return err(400, '인스타그램이 연결되지 않았습니다. 설정 → 연결에서 먼저 연결해 주세요.');
    try {
      const res = await igPublish(ig, data);
      Object.assign(data, res, { publishedAt: now(), publishedBy: user.name });
      delete data.lastError;
    } catch (e) {
      data.lastError = e.message; data.errorAt = now();
      next.status = 'failed';
      next.data = JSON.stringify(data);
      await saveRow(env, id, next);
      await addComment(env, id, user, 'system', '게시 실패 — ' + e.message);
      return err(502, '게시 실패 — ' + e.message, { current: rowToContent(await contentRow(env, id)) });
    }
  }
  if (b.action === 'mark_published') { data.publishedAt = now(); data.publishedBy = user.name; data.manual = true; }
  next.data = JSON.stringify(data);
  await saveRow(env, id, next);
  const logText = spec.log + (b.action === 'schedule' ? ` — ${new Date(next.scheduled_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '');
  await addComment(env, id, user, b.action === 'request_changes' ? 'changes' : b.action === 'approve' || b.action === 'schedule' ? 'approve' : 'system', logText + (note ? '\n' + note : ''));
  return json({ ok: true, content: rowToContent(await contentRow(env, id)) });
}

async function upsertContent(env, user, id, b) {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return err(400, '잘못된 콘텐츠 ID');
  const incoming = stripServerFields(b.data || {});
  const row = await contentRow(env, id);
  const title = String(incoming.title || '').slice(0, 120);
  if (!row) {
    let status = ['planned', 'draft'].includes(b.data?.status) ? b.data.status : 'draft';
    if (b.imported) {
      const hasImg = (incoming.pages || []).some((p) => Object.entries(p.v || {}).some(([k, v]) => k.startsWith('img') && v));
      status = hasImg || incoming.caption ? 'draft' : 'planned';
    }
    const t = now();
    await env.DB.prepare(`INSERT INTO contents (id, data, status, title, author_id, author_name, updated_by, updated_by_name, created_at, updated_at, version, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
      .bind(id, JSON.stringify(incoming), status, title, user.id, user.name, user.id, user.name, incoming.createdAt || t, t, incoming.scheduledAt || null).run();
    if (b.imported) await addComment(env, id, user, 'system', '이전 버전(이 기기 브라우저 저장)에서 공용 저장소로 옮겼습니다');
    return json({ ok: true, content: rowToContent(await contentRow(env, id)) }, 201);
  }
  if (row.status === 'trashed') return err(409, '휴지통에 있는 콘텐츠입니다. 먼저 되살려 주세요.', { current: rowToContent(row) });
  if (b.baseVersion && Number(b.baseVersion) !== row.version) return err(409, '다른 사람이 먼저 수정했습니다', { current: rowToContent(row) });
  let old = {};
  try { old = JSON.parse(row.data || '{}'); } catch {}
  const merged = { ...incoming };
  SERVER_KEEP.forEach((k) => { if (old[k] !== undefined) merged[k] = old[k]; });
  const changed = contentFingerprint(old) !== contentFingerprint(merged);
  let status = row.status, note = '';
  if (changed && ['approved', 'scheduled', 'failed'].includes(row.status)) {
    status = 'draft'; delete merged.mediaUrls; delete merged.approvedBy; delete merged.approvedAt;
    note = '승인 뒤 내용이 바뀌어 다시 검토가 필요합니다 (예약이 풀렸습니다)';
  }
  if (row.status === 'planned' && (b.data?.status === 'draft' || changed)) status = 'draft';
  let scheduledAt = incoming.scheduledAt !== undefined ? incoming.scheduledAt : row.scheduled_at;
  if (row.status === 'scheduled' && status === 'scheduled' && scheduledAt !== row.scheduled_at && !isAdmin(user)) scheduledAt = row.scheduled_at;
  if (status === 'scheduled' && scheduledAt && isNaN(new Date(scheduledAt).getTime())) scheduledAt = row.scheduled_at;
  await saveRow(env, id, { ...row, data: JSON.stringify(merged), status, title: title || row.title, updated_by: user.id, updated_by_name: user.name, scheduled_at: scheduledAt || null });
  if (note) await addComment(env, id, user, 'system', note);
  return json({ ok: true, content: rowToContent(await contentRow(env, id)), reset: !!note });
}

/* ══ 예약 발행 점검 (10분마다 cron Worker 가 호출, GitHub Actions 가 30분마다 보조 호출) ══ */
async function cronTick(env, origin, force) {
  const last = (await kvGet(env, 'cron:last'))?.value;
  if (!force && last && Date.now() - new Date(last.at).getTime() < 45e3) return json({ skipped: true, lastRunAt: last.at });
  const summary = { published: [], failed: [], waiting: [], refreshed: false, insights: false, notes: [] };
  await kvSet(env, 'cron:last', { at: now(), summary: { running: true } });
  const sys = { id: 'system', name: '자동 발행' };
  let ig = await igGetSecret(env);
  const due = (await env.DB.prepare(`SELECT * FROM contents WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 3`).bind(now()).all()).results || [];
  for (const row of due) {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch {}
    if (!ig?.token) {
      if (data.lastError !== '인스타그램 미연결') { data.lastError = '인스타그램 미연결'; await saveRow(env, row.id, { ...row, data: JSON.stringify(data), updated_by: sys.id, updated_by_name: sys.name }); }
      summary.waiting.push(row.id);
      continue;
    }
    try {
      const res = await igPublish(ig, data);
      Object.assign(data, res, { publishedAt: now(), publishedBy: '자동 발행' });
      delete data.lastError;
      await saveRow(env, row.id, { ...row, data: JSON.stringify(data), status: 'published', updated_by: sys.id, updated_by_name: sys.name });
      await addComment(env, row.id, sys, 'system', '예약 시각에 자동 게시했습니다' + (res.permalink ? '\n' + res.permalink : ''));
      summary.published.push(row.id);
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      data.lastError = e.message; data.errorAt = now();
      const status = attempts >= 3 ? 'failed' : 'scheduled';
      await saveRow(env, row.id, { ...row, data: JSON.stringify(data), status, attempts, updated_by: sys.id, updated_by_name: sys.name });
      await addComment(env, row.id, sys, 'system', `게시 실패 (${attempts}/3) — ${e.message}${status === 'failed' ? '\n세 번 실패해 멈췄습니다. 확인 후 다시 예약해 주세요.' : '\n10분 뒤 다시 시도합니다.'}`);
      summary.failed.push(row.id);
    }
  }
  // 토큰 자동 갱신 — 발급 24시간 이후, 마지막 갱신 7일 경과 또는 만료 10일 전 (Meta: refresh_access_token)
  if (ig?.token) {
    const since = Date.now() - new Date(ig.refreshedAt || ig.connectedAt).getTime();
    const age = Date.now() - new Date(ig.connectedAt).getTime();
    const left = ig.expiresAt ? new Date(ig.expiresAt).getTime() - Date.now() : (ig.kind === 'suat' ? Infinity : 0);
    if (age > 24 * 3600e3 && (since > 7 * 864e5 || left < 10 * 864e5)) {
      try { ig = await igRefresh(env, ig); summary.refreshed = true; }
      catch (e) { ig.lastError = '토큰 자동 갱신 실패 — ' + e.message; ig.lastCheckAt = now(); await kvSet(env, 'secret:ig', ig, 'system'); summary.notes.push(ig.lastError); }
    }
    // 성과 수집 — 하루 1번, 게시가 없던 회차에만 (요청 수 제한 고려 · 1회 ≈ 32건)
    const ins = (await kvGet(env, 'insights'))?.value;
    if (!summary.published.length && (!ins || Date.now() - new Date(ins.at).getTime() > 864e5)) {
      try { await collectInsights(env, ig); summary.insights = true; }
      catch (e) { summary.notes.push('성과 수집 실패 — ' + e.message); }
    }
  }
  await kvSet(env, 'cron:last', { at: now(), summary });
  return json({ ok: true, ...summary });
}

/* ══ 라우터 ══ */
export async function onRequest(context) {
  const { request, env, params, data } = context;
  try {
    await ensureSchema(env);
  } catch (e) {
    return err(503, e.message === 'NO_DB' ? '저장소(D1)가 연결되지 않았습니다' : '저장소 오류: ' + e.message);
  }
  const url = new URL(request.url);
  const origin = url.origin;
  const seg = Array.isArray(params.path) ? params.path : String(params.path || '').split('/').filter(Boolean);
  const [a, b, c] = seg;
  const M = request.method;
  const user = data.user;

  try {
    if (a === 'cron' && b === 'tick') return cronTick(env, origin, false);
    if (!user) return err(401, '로그인이 필요합니다', { code: 'AUTH' });

    /* 내 정보 */
    if (a === 'me' && M === 'GET') {
      const me = { id: user.id, name: user.name, role: user.role, login: user.login };
      if (user.id === 'master') { const sec = await masterSecret(env); me.pwChangedAt = sec?.changedAt || null; me.pwChangedBy = sec?.changedBy || null; }
      return json({ me, roles: ROLES });
    }
    if (a === 'me' && M === 'PATCH') {
      const p = await body(request);
      if (p.name && user.id !== 'master') await env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(String(p.name).slice(0, 30), user.id).run();
      if (p.password !== undefined) {
        // 비밀번호 바꾸기 — 지금 비밀번호를 먼저 확인한다(틀린 시도는 로그인 실패와 같이 15분 10회 제한)
        const ip = request.headers.get('cf-connecting-ip') || 'local';
        if (await loginThrottle(env, ip, false)) return err(429, '시도가 너무 많습니다. 15분 뒤 다시 해 주세요');
        const pw = String(p.password || '');
        if (pw.length < 8) return err(400, '새 비밀번호는 8자 이상이어야 합니다');
        if (pw.length > 128) return err(400, '새 비밀번호가 너무 깁니다 (128자 이하)');
        const ok = await verifyLogin(env, user.login, String(p.current || ''));
        if (!ok) { await loginThrottle(env, ip, true); return err(403, '지금 비밀번호가 맞지 않습니다'); }
        if (pw === String(p.current || '')) return err(400, '지금과 다른 비밀번호를 정해 주세요');
        if (user.id === 'master') {
          const v = await setMasterPassword(env, pw, user.name);
          const token = await makeSession(env, { ...user, pv: v });   // 바꾼 이 기기는 로그인 유지, 다른 기기는 로그아웃
          return json({ ok: true, master: true }, 200, { 'set-cookie': sessionCookie(token, 30 * 86400) });
        }
        const h = await hashPassword(pw);
        await env.DB.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').bind(h.salt, h.hash, user.id).run();
      }
      return json({ ok: true });
    }

    /* 전체 상태 — 변경 없으면 가볍게 응답 */
    if (a === 'state' && M === 'GET') {
      const rev = await stateRev(env);
      if (url.searchParams.get('rev') === rev) return json({ unchanged: true, rev });
      const rows = (await env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM comments m WHERE m.content_id=c.id AND m.kind='comment') AS comment_count FROM contents c ORDER BY c.updated_at DESC`).all()).results || [];
      const ws = await kvGet(env, 'workspace');
      const feed = (await env.DB.prepare(`SELECT m.id, m.content_id, m.user_name, m.kind, m.body, m.created_at, c.title FROM comments m LEFT JOIN contents c ON c.id=m.content_id ORDER BY m.id DESC LIMIT 25`).all()).results || [];
      const ins = (await kvGet(env, 'insights'))?.value || null;
      return json({ rev, me: user, workspace: { ...(ws?.value || {}), version: ws?.version || 0 }, contents: rows.map(rowToContent), feed, integrations: await integrations(env), insights: ins, serverTime: now() });
    }

    /* 워크스페이스 (공용 설정·세트·즐겨찾기·템플릿) */
    if (a === 'workspace' && M === 'PATCH') {
      const p = await body(request);
      const cur = (await kvGet(env, 'workspace'))?.value || {};
      const set = p.set || {};
      for (const k of Object.keys(set)) {
        if (!WORKSPACE_KEYS.includes(k)) continue;
        if (k === 'settings') {
          const next = cleanSettings(set[k]);
          // 승인 규칙(게시 전 승인 필수·승인자)은 관리자만 바꿀 수 있다
          if (!isAdmin(user)) { const prev = cur.settings || {}; ['requireApproval', 'approvers'].forEach((x) => { if (x in prev) next[x] = prev[x]; else delete next[x]; }); }
          cur[k] = next;
        } else cur[k] = set[k];
      }
      if (JSON.stringify(cur).length > 900000) return err(413, '공용 설정 데이터가 너무 큽니다');
      await kvSet(env, 'workspace', cur, user.name);
      const v = await kvGet(env, 'workspace');
      return json({ ok: true, version: v.version });
    }

    /* 콘텐츠 */
    if (a === 'contents' && b && !c) {
      if (M === 'GET') { const r = await contentRow(env, b); return r ? json({ content: rowToContent(r) }) : err(404, '없음'); }
      if (M === 'PUT') return upsertContent(env, user, b, await body(request));
    }
    if (a === 'contents' && b && c === 'action' && M === 'POST') return doAction(env, user, b, await body(request), origin);
    if (a === 'contents' && b && c === 'comments') {
      if (M === 'GET') {
        const r = (await env.DB.prepare('SELECT id, user_id, user_name, kind, body, created_at FROM comments WHERE content_id=? ORDER BY id').bind(b).all()).results || [];
        return json({ comments: r });
      }
      if (M === 'POST') {
        const p = await body(request);
        const text = String(p.body || '').trim();
        if (!text) return err(400, '내용을 적어 주세요');
        if (!(await env.DB.prepare('SELECT id FROM contents WHERE id=?').bind(b).first())) return err(404, '콘텐츠를 찾을 수 없습니다');
        await addComment(env, b, user, 'comment', text);
        await env.DB.prepare('UPDATE contents SET updated_at=? WHERE id=?').bind(now(), b).run();
        return json({ ok: true });
      }
    }

    /* 이미지 업로드 → 공개 주소 */
    if (a === 'media' && M === 'POST') {
      if (!env.MEDIA) return err(503, '이미지 저장소(KV)가 연결되지 않았습니다');
      const ct = (request.headers.get('content-type') || '').split(';')[0].trim();
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[ct];
      if (!ext) return err(415, 'JPEG·PNG·WEBP·GIF 이미지만 올릴 수 있습니다');
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return err(400, '빈 파일입니다');
      if (buf.byteLength > 15 * 1024 * 1024) return err(413, '15MB 이하 이미지만 올릴 수 있습니다');
      const key = randomId(18) + '.' + ext;
      await env.MEDIA.put(key, buf, { metadata: { ct, by: user.id, at: now(), size: buf.byteLength } });
      return json({ ok: true, key, url: `${origin}/media/${key}` }, 201);
    }

    /* 사용자 관리 (관리자) */
    if (a === 'users') {
      if (!isAdmin(user)) return err(403, '관리자만 볼 수 있습니다');
      if (M === 'GET' && !b) {
        const r = (await env.DB.prepare('SELECT id, login, name, role, active, created_at, last_login FROM users ORDER BY created_at').all()).results || [];
        return json({ users: r });
      }
      if (M === 'POST' && !b) {
        const p = await body(request);
        const login = String(p.login || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(login) || login === 'nicott') return err(400, '아이디는 영문 소문자·숫자·._- 3~30자 (nicott 제외)');
        if (!String(p.name || '').trim()) return err(400, '이름을 적어 주세요');
        if (String(p.password || '').length < 8) return err(400, '비밀번호는 8자 이상이어야 합니다');
        const role = p.role === 'admin' ? 'admin' : 'editor';
        if (await env.DB.prepare('SELECT id FROM users WHERE login=?').bind(login).first()) return err(409, '이미 있는 아이디입니다');
        const h = await hashPassword(String(p.password));
        const id = 'U' + randomId(9);
        await env.DB.prepare('INSERT INTO users (id, login, name, role, salt, hash, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
          .bind(id, login, String(p.name).trim().slice(0, 30), role, h.salt, h.hash, now()).run();
        return json({ ok: true, id }, 201);
      }
      if (M === 'PATCH' && b === 'master') {
        // 개인 관리자 계정이 공용 계정(nicott) 비밀번호를 재설정 (대표님이 잊었을 때)
        if (user.id === 'master') return err(400, '공용 계정으로 접속 중일 때는 [내 계정]에서 지금 비밀번호를 확인하고 바꿔 주세요');
        const p = await body(request);
        const pw = String(p.password || '');
        if (pw.length < 8) return err(400, '비밀번호는 8자 이상이어야 합니다');
        if (pw.length > 128) return err(400, '비밀번호가 너무 깁니다 (128자 이하)');
        await setMasterPassword(env, pw, user.name);
        return json({ ok: true });
      }
      if (M === 'PATCH' && b) {
        const p = await body(request);
        const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(b).first();
        if (!row) return err(404, '사용자를 찾을 수 없습니다');
        if (p.name) await env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(String(p.name).trim().slice(0, 30), b).run();
        if (p.role) await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(p.role === 'admin' ? 'admin' : 'editor', b).run();
        if (p.active !== undefined) await env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(p.active ? 1 : 0, b).run();
        if (p.password) {
          if (String(p.password).length < 8) return err(400, '비밀번호는 8자 이상이어야 합니다');
          const h = await hashPassword(String(p.password));
          await env.DB.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').bind(h.salt, h.hash, b).run();
        }
        return json({ ok: true });
      }
    }

    /* 연결 (인스타그램 · AI) — 토큰은 서버에만 저장, 화면에는 상태만 */
    if (a === 'integrations') {
      if (M === 'GET' && !b) return json(await integrations(env));
      if (!isAdmin(user)) return err(403, '관리자만 연결을 바꿀 수 있습니다');
      if (b === 'instagram' && M === 'POST' && !c) {
        const p = await body(request);
        const token = String(p.token || '').trim();
        if (token.length < 20) return err(400, '토큰을 붙여넣어 주세요');
        const ws = (await kvGet(env, 'workspace'))?.value || {};
        let got;
        try { got = await igConnectToken(token, p.username || ws.settings?.handle); }
        catch (e) { return err(400, '인스타 연결 실패 — ' + e.message + ' (토큰을 끝까지 복사했는지, 권한 instagram_basic·instagram_content_publish 가 구성에 들어 있는지 확인해 주세요)'); }
        const ig = { ...got, connectedAt: now(), connectedBy: user.name, refreshedAt: null, lastError: null, lastCheckAt: now() };
        await kvSet(env, 'secret:ig', ig, user.name);
        return json({ ok: true, instagram: igPublicStatus(ig) });
      }
      if (b === 'instagram' && c === 'refresh' && M === 'POST') {
        const ig = await igGetSecret(env);
        if (!ig?.token) return err(400, '연결된 토큰이 없습니다');
        try { return json({ ok: true, instagram: igPublicStatus(await igRefresh(env, ig)) }); }
        catch (e) { return err(400, e.message + (ig.kind === 'suat' ? '' : ' (발급 후 24시간이 지나야 갱신할 수 있습니다)')); }
      }
      if (b === 'instagram' && c === 'check' && M === 'POST') {
        const ig = await igGetSecret(env);
        if (!ig?.token) return err(400, '연결된 토큰이 없습니다');
        try {
          if (ig.kind === 'suat') {
            const { accounts } = await igFindAccounts(igAuth(ig));
            const a = accounts.find((x) => x.id === String(ig.userId));
            if (!a) throw new Error('연결했던 인스타 계정이 더 이상 공유되어 있지 않습니다 — 다시 연결해 주세요');
            ig.username = a.username || ig.username;
          } else { const me = await igRequest('GET', 'me', { fields: 'user_id,username' }, ig.token); ig.username = me.username || ig.username; }
          ig.lastError = null;
        }
        catch (e) { ig.lastError = e.message; }
        ig.lastCheckAt = now();
        await kvSet(env, 'secret:ig', ig, user.name);
        return json({ ok: !ig.lastError, instagram: igPublicStatus(ig) });
      }
      if (b === 'instagram' && M === 'DELETE') { await env.DB.prepare(`DELETE FROM kv WHERE key='secret:ig'`).run(); return json({ ok: true }); }
      if (b === 'ai' && M === 'POST') {
        const p = await body(request);
        const cur = (await kvGet(env, 'secret:ai'))?.value || {};
        const key = String(p.key || '').trim();
        if (key) { if (!key.startsWith('sk-ant-')) return err(400, 'Anthropic API 키 형식이 아닙니다'); cur.key = key; cur.connectedAt = now(); cur.connectedBy = user.name; }
        if (p.model) cur.model = String(p.model);
        if (!cur.key) return err(400, '키를 붙여넣어 주세요');
        await kvSet(env, 'secret:ai', cur, user.name);
        return json({ ok: true });
      }
      if (b === 'ai' && M === 'DELETE') { await env.DB.prepare(`DELETE FROM kv WHERE key='secret:ai'`).run(); return json({ ok: true }); }
    }

    /* AI 원고·캡션 (서버가 키를 대신 붙여 호출 — 키가 브라우저에 노출되지 않음) */
    if (a === 'ai' && M === 'POST') {
      const ai = (await kvGet(env, 'secret:ai'))?.value;
      if (!ai?.key) return err(400, 'AI 키가 등록되지 않았습니다 (설정 → 연결)');
      const p = await body(request);
      const want = String(p.model || ai.model || 'claude-haiku-5-5');
      const FALLBACK = { 'claude-haiku-5-5': 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5': 'claude-sonnet-4-5' };
      const call = (model) => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: Math.min(Number(p.max_tokens) || 1500, 4000), system: p.system || undefined, messages: p.messages || [{ role: 'user', content: String(p.prompt || '') }] }),
      }).then((r) => r.json());
      let j = await call(want);
      if (j?.error?.type === 'not_found_error' && FALLBACK[want]) j = await call(FALLBACK[want]);
      if (j?.error) return err(502, 'AI 오류 — ' + (j.error.message || j.error.type));
      return json({ text: (j.content || []).map((x) => x.text || '').join(''), model: j.model, usage: j.usage });
    }

    if (a === 'insights' && M === 'GET') return json((await kvGet(env, 'insights'))?.value || { items: [] });
    if (a === 'insights' && b === 'refresh' && M === 'POST') {
      if (!isAdmin(user)) return err(403, '관리자만 할 수 있습니다');
      const ig = await igGetSecret(env);
      if (!ig?.token) return err(400, '인스타그램이 연결되지 않았습니다');
      const ins = (await kvGet(env, 'insights'))?.value;
      if (ins?.at && Date.now() - new Date(ins.at).getTime() < 10 * 60e3) return err(429, '방금 모았습니다 — 10분 뒤에 다시 눌러 주세요');
      try { const r = await collectInsights(env, ig); return json({ ok: true, ...r, insights: (await kvGet(env, 'insights'))?.value }); }
      catch (e) { return err(400, '성과를 모으지 못했습니다 — ' + e.message); }
    }
    if (a === 'cron' && b === 'run' && M === 'POST') { if (!isAdmin(user)) return err(403, '관리자만'); return cronTick(env, origin, true); }

    return err(404, '없는 경로입니다');
  } catch (e) {
    return err(500, '서버 오류 — ' + (e.message || e));
  }
}
