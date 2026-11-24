'use strict';
/*
 * RC API tests: meetings, existing-session discovery, project browsing.
 * Run against a fresh data dir:
 *   R2_URL=http://127.0.0.1:8820 R2_TOKEN=... node tools/rc-api-tests.js
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.R2_URL || 'http://127.0.0.1:8820';
const TOKEN = process.env.R2_TOKEN || '';
const results = [];
function ok(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); }

async function api(p, opt = {}) {
  const headers = Object.assign({}, opt.headers || {});
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  if (opt.body) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { ...opt, headers });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

(async () => {
  const health = await api('/api/health');
  ok('health ok', health.status === 200 && health.body.ok, 'schema=' + health.body.schema_version);
  const startRoom = health.body.room_id;

  const rooms0 = await api('/api/rooms');
  ok('rooms listed', rooms0.status === 200 && Array.isArray(rooms0.body.rooms) && rooms0.body.rooms.length >= 1);

  const createActive = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'should fail' }) });
  ok('cannot create while a meeting is active', createActive.status === 409, JSON.stringify(createActive.body));

  const claudeList = await api('/api/sessions?provider=claude&limit=5');
  ok('claude sessions discovered', claudeList.status === 200 && claudeList.body.sessions.length > 0,
    'count=' + (claudeList.body.sessions || []).length + ' first=' + ((claudeList.body.sessions || [])[0] || {}).title);
  const codexList = await api('/api/sessions?provider=codex&limit=5');
  ok('codex sessions discovered', codexList.status === 200 && codexList.body.sessions.length > 0,
    'count=' + (codexList.body.sessions || []).length + ' first=' + ((codexList.body.sessions || [])[0] || {}).title);
  const badProvider = await api('/api/sessions?provider=other');
  ok('bad provider rejected', badProvider.status === 400);

  const proj = await api('/api/projects');
  ok('project roots listed', proj.status === 200 && proj.body.roots.length >= 1, JSON.stringify(proj.body.roots));
  const browse = await api('/api/projects/browse?path=' + encodeURIComponent(proj.body.default_root));
  ok('browse default root', browse.status === 200 && Array.isArray(browse.body.dirs), 'dirs=' + ((browse.body.dirs || []).length));
  const browseOutside = await api('/api/projects/browse?path=' + encodeURIComponent('C:/Windows'));
  ok('browse outside roots rejected', browseOutside.status === 400);

  // The project root may contain only folders; walk down until a markdown file
  // is found (still through the same browse endpoint).
  let mdFile = (browse.body.files || [])[0];
  let cursor = browse.body;
  for (let depth = 0; !mdFile && depth < 3 && cursor.dirs.length; depth++) {
    const sub = await api('/api/projects/browse?path=' + encodeURIComponent(cursor.dirs[0].path));
    if (sub.status !== 200) break;
    cursor = sub.body;
    mdFile = (cursor.files || [])[0];
  }
  if (mdFile) {
    const sel = await api('/api/shared/select', { method: 'POST', body: JSON.stringify({ path: mdFile.path }) });
    ok('select project markdown', sel.status === 200 && /^[0-9a-f]{64}$/.test(sel.body.shared.sha256), sel.body.shared && sel.body.shared.source_path);
  } else {
    ok('select project markdown', false, 'no .md/.txt in default root');
  }
  const outsideSelect = await api('/api/shared/select', { method: 'POST', body: JSON.stringify({ path: 'C:/Windows/win.ini' }) });
  ok('outside file rejected', outsideSelect.status === 400);

  const badSession = await api('/api/invite', { method: 'POST', body: JSON.stringify({ provider: 'claude-code-cli/magpie', id: 'claude', session_id: '00000000-0000-0000-0000-000000000000' }) });
  ok('unknown session id rejected', badSession.status === 400, JSON.stringify(badSession.body));

  const cSession = claudeList.body.sessions[0];
  const invite = await api('/api/invite', { method: 'POST', body: JSON.stringify({ provider: 'claude-code-cli/magpie', id: 'claude', label: 'Claude Code', role: '评审者', session_id: cSession.id }) });
  ok('invite with real session', invite.status === 200 && invite.body.participant.session_id === cSession.id);

  const state1 = await api('/api/state?since=0');
  ok('state has rooms and session bound', state1.status === 200 && Array.isArray(state1.body.rooms) && state1.body.participants.some((p) => p.id === 'claude' && p.session_id === cSession.id));

  // Disable the agent first: this test checks history retention, not a real
  // provider round (that is covered by the manual end-to-end pass).
  await api('/api/participants/claude/disable', { method: 'POST' });
  await api('/api/messages', { method: 'POST', body: JSON.stringify({ content: '旧会议里的一条消息（用于历史保留测试）', client_id: 'rc-test-old-' + Date.now(), mode: 'single', target: null }) });

  const end = await api('/api/control', { method: 'POST', body: JSON.stringify({ action: 'end' }) });
  ok('end meeting', end.status === 200 && end.body.state === 'ended');

  const afterEndSend = await api('/api/messages', { method: 'POST', body: JSON.stringify({ content: 'should fail' }) });
  ok('send after end rejected', afterEndSend.status === 410);

  let create2 = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: '第二场测试会议' }) });
  for (let i = 0; create2.status === 409 && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    create2 = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: '第二场测试会议' }) });
  }
  ok('create second meeting after end', create2.status === 200 && create2.body.room.id !== startRoom, JSON.stringify(create2.body).slice(0, 160));

  const stateNew = await api('/api/state?since=0');
  ok('new meeting is empty', stateNew.body.messages.length === 0 && stateNew.body.participants.every((p) => p.id === 'human'));
  ok('new meeting has its own shared file', stateNew.body.shared.path.includes('rooms/'), stateNew.body.shared.path);

  const oldSelect = await api('/api/rooms/' + encodeURIComponent(startRoom) + '/select', { method: 'POST' });
  ok('switch to history meeting', oldSelect.status === 200 && oldSelect.body.room.state === 'ended');
  const oldState = await api('/api/state?since=0');
  ok('history messages preserved', oldState.body.messages.some((m) => String(m.content).includes('历史保留测试')), 'count=' + oldState.body.messages.length);

  const backSelect = await api('/api/rooms/' + encodeURIComponent(create2.body.room.id) + '/select', { method: 'POST' });
  ok('switch back to new meeting', backSelect.status === 200 && backSelect.body.room.state === 'active');

  const fail = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  const out = path.join(process.env.R2_DATA_DIR || 'data', 'rc-api-tests.json');
  try { fs.writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2)); } catch { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
