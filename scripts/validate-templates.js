/* 자동 생성 템플릿 검증기
   워크플로가 AI 결과물을 대시보드에 올리기 전에 이 검사를 통과해야 합니다.
   node scripts/validate-templates.js <파일경로>
   통과 → 종료코드 0 / 위반 → 1 (워크플로가 중단되고 이슈로 알립니다) */
const fs = require('fs');

const TOKENS = ['--bg','--bg2','--panel','--fg','--sub','--acc','--edge','--rad','--hw','--sh','--band','--dark','--ts','--en','--kr','--f','--f2','--cw','--ch','--tone','--ontone','--ontone2'];
const BANNED = ['역대급','무조건 소장','안 사면 후회','지금 바로 GET','완전 핫한','최저가','품절임박','서두르세요','대박'];
const FMTS = ['F1','F2','F3','F4','F5','F6','F7'];
const ROLES = ['cover','page','end','single','story','reels'];
const BUCKETS = ['product','lifestyle','story','event'];
const SPEAKERS = ['NICOTT','NINA'];

function validate(tpl, knownIds) {
  const e = [];
  const id = tpl.id || '(id 없음)';

  // 1 필수 항목
  for (const k of ['id','nm','role','fmt','sp','bk','ev','css','html'])
    if (!tpl[k]) e.push(`${id}: 필수 항목 '${k}' 누락`);
  const fields = tpl.f || tpl.fields;
  if (!Array.isArray(fields) || !fields.length) e.push(`${id}: 입력 슬롯(f) 없음`);

  // 2 열거값
  if (tpl.role && !ROLES.includes(tpl.role)) e.push(`${id}: role '${tpl.role}' 은 허용되지 않음`);
  if (tpl.fmt && !FMTS.includes(tpl.fmt)) e.push(`${id}: fmt '${tpl.fmt}' 은 허용되지 않음`);
  if (tpl.bk && !BUCKETS.includes(tpl.bk)) e.push(`${id}: bk '${tpl.bk}' 은 허용되지 않음`);
  if (tpl.sp && !SPEAKERS.includes(tpl.sp)) e.push(`${id}: 화자는 NICOTT 또는 NINA 여야 함`);

  // 3 아이디 충돌
  if (knownIds.has(tpl.id)) e.push(`${id}: 이미 있는 아이디`);

  // 4 캔버스
  const w = tpl.w || 1080, h = tpl.h || 1350;
  if (w !== 1080 || ![1350,1920].includes(h)) e.push(`${id}: 캔버스는 1080x1350 또는 1080x1920 만 허용 (현재 ${w}x${h})`);

  // 5 색상 직접 사용 금지 (브랜드 토큰만)
  const blob = (tpl.css||'') + (tpl.html||'');
  const hex = blob.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  if (hex.length) e.push(`${id}: 색상값 직접 사용 ${[...new Set(hex)].join(', ')} — 브랜드 토큰 변수만 쓸 것`);
  const rgb = blob.match(/rgba?\([^)]*\)/g) || [];
  const allowRgb = rgb.filter(v => !/rgba\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/.test(v));
  if (allowRgb.length) e.push(`${id}: 임의 rgb 색 사용 ${[...new Set(allowRgb)].slice(0,3).join(', ')}`);

  // 6 사용한 CSS 변수가 허용 목록 안인지
  const used = (blob.match(/var\(\s*(--[\w-]+)/g) || []).map(v => v.replace(/var\(\s*/,''));
  for (const u of [...new Set(used)]) if (!TOKENS.includes(u)) e.push(`${id}: 알 수 없는 변수 ${u}`);

  // 7 CSS 스코프 — 반드시 자기 아이디로 시작
  const sels = (tpl.css||'').split('}').map(s => s.split('{')[0].trim()).filter(Boolean);
  for (const s of sels) if (!s.startsWith('.' + tpl.id)) e.push(`${id}: CSS 선택자가 '.${tpl.id}' 로 시작하지 않음 → "${s.slice(0,40)}"`);

  // 8 자리표시자와 슬롯 일치
  const ph = [...(tpl.html||'').matchAll(/\{\{(?:(?:bg|nl|fs|fs2):)?([\w]+)\}\}/g)].map(m => m[1]);
  const keys = new Set((fields||[]).map(f => f.k));
  for (const p of [...new Set(ph)]) if (!keys.has(p)) e.push(`${id}: 자리표시자 {{${p}}} 에 대응하는 슬롯이 없음`);
  for (const f of fields||[]) {
    if (!f.k || !f.t || !f.l) e.push(`${id}: 슬롯 정의 불완전 ${JSON.stringify(f).slice(0,50)}`);
    if (!['image','text','area','select','color'].includes(f.t)) e.push(`${id}: 슬롯 타입 '${f.t}' 허용 안 됨`);
    if (f.t === 'image' && !/^img\d+$/.test(f.k)) e.push(`${id}: 사진 슬롯 키는 img1, img2… 형식이어야 함 (현재 ${f.k})`);
    if (f.t === 'select' && !Array.isArray(f.o)) e.push(`${id}: select 슬롯에 보기(o) 없음`);
  }

  // 9 금지 표현
  for (const b of BANNED) if (blob.includes(b) || JSON.stringify(fields||[]).includes(b)) e.push(`${id}: 금지 표현 '${b}'`);

  // 10 코드 실행 시도 차단
  if (/<script|javascript:|onerror=|onload=|eval\(/i.test(blob)) e.push(`${id}: 스크립트/이벤트 핸들러 포함 — 허용되지 않음`);

  // 11 스토리·릴스 하단 안전영역
  if (h === 1920) {
    const bottoms = [...(tpl.css||'').matchAll(/bottom:\s*(\d+)px/g)].map(m => +m[1]);
    if (bottoms.some(b => b < 250 && b > 0)) e.push(`${id}: 세로형인데 하단 250px 안전영역에 요소가 있음 (앱 UI에 가려짐)`);
  }
  return e;
}

function main() {
  const file = process.argv[2] || 'data/templates/pending.json';
  if (!fs.existsSync(file)) { console.log('검사할 파일이 없습니다:', file); process.exit(0); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = data.templates || [];
  const known = new Set(JSON.parse(fs.existsSync('config/known-ids.json') ? fs.readFileSync('config/known-ids.json','utf8') : '[]'));

  const report = [], passed = [];
  for (const t of list) {
    const e = validate(t, known);
    if (e.length) report.push(...e); else { passed.push(t); known.add(t.id); }
  }

  const md = [`# 자동 생성 템플릿 검사`, '', `생성 ${list.length}종 · 통과 ${passed.length}종 · 반려 ${list.length - passed.length}종`, ''];
  if (report.length) md.push('## 반려 사유', ...report.map(r => '- ' + r), '', '반려된 템플릿은 대시보드로 보내지 않았습니다.');
  else md.push('## 전 항목 통과 — 규칙 위반 없음');
  fs.mkdirSync('data/templates', { recursive: true });
  fs.writeFileSync('data/templates/_check.md', md.join('\n'));

  // 통과분만 대시보드로 전달
  fs.writeFileSync(file, JSON.stringify({ generated: data.generated || new Date().toISOString(), insights: data.insights || [], templates: passed }, null, 2));
  fs.writeFileSync('config/known-ids.json', JSON.stringify([...known], null, 2));

  console.log(`검사 완료 — 통과 ${passed.length} / 반려 ${list.length - passed.length}`);
  if (!passed.length && list.length) { console.log('통과한 템플릿이 없습니다.'); process.exit(1); }
}

if (require.main === module) main();
module.exports = { validate };
