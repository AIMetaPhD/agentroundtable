'use strict';
/* Branch B HTTP checks: existing-session field, shared project snapshot, target routing. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8843';
const TOKEN = process.env.R2_TOKEN || 'branchb2';
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
async function api(p, { method = 'GET', body } = {}) {
  const headers = { authorization: 'Bearer ' + TOKEN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  const health = await api('/api/health');
  if (health.json.room === 'ended') {
    await api('/api/rooms', { method: 'POST', body: { name: 'branchb-tests' } });
  }
  const list = await api('/api/sessions?provider=codex&limit=1');
  const real = list.json && list.json.sessions && list.json.sessions[0];
  check('existing codex session discoverable', !!real, real && { id: real.id, title: real.title });
  const inv = await api('/api/invite', { method: 'POST', body: { id: 'probe', label: 'Probe', provider: 'codex-cli/openai', role: 'r', session_id: real ? real.id : null } });
  check('invite accepts a real session_id', inv.status === 200 && (!real || inv.json.participant.session_id === real.id), inv.json.participant && inv.json.participant.session_id);
  const fake = await api('/api/invite', { method: 'POST', body: { id: 'probe-fake', label: 'P', provider: 'codex-cli/openai', session_id: '00000000-0000-0000-0000-000000000000' } });
  check('unknown session_id rejected', fake.status === 400, fake.status);
  const nl = await api('/api/invite', { method: 'POST', body: { id: 'probe2', label: 'P', provider: 'codex-cli/openai', session_id: 'x\ny' } });
  check('session_id newline rejected', nl.status === 400, nl.status);
  const dash = await api('/api/invite', { method: 'POST', body: { id: 'probe3', label: 'P', provider: 'codex-cli/openai', session_id: '-evil' } });
  check('session_id leading dash rejected', dash.status === 400, dash.status);
  const abs = path.resolve(__dirname, '..', 'README.md');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  const sel = await api('/api/shared/select', { method: 'POST', body: { path: abs } });
  check('shared select records source+hash', sel.status === 200 && sel.json.shared.source_sha256 === sha && sel.json.shared.sha256 === sha, sel.json.shared);
  const outside = await api('/api/shared/select', { method: 'POST', body: { path: 'C:/Windows/win.ini' } });
  check('shared outside root rejected', outside.status === 400, outside.status);
  const badExt = await api('/api/shared/select', { method: 'POST', body: { path: path.resolve(__dirname, '..', 'server.js') } });
  check('shared non-markdown rejected', badExt.status === 400, badExt.status);
  const badTarget = await api('/api/messages', { method: 'POST', body: { content: 'x', target: 'nobody' } });
  check('unknown target rejected', badTarget.status === 400, badTarget.status);
  await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  const queued = await api('/api/messages', { method: 'POST', body: { content: 'targeted queued probe', target: 'probe' } });
  check('targeted message queues without model call', queued.status === 200 && queued.json.queued === true && queued.json.target === 'probe', queued.json && { queued: queued.json.queued, target: queued.json.target, job: queued.json.job_id });
  const st = await api('/api/state');
  const job = st.json.jobs.find((j) => j.state === 'queued');
  check('job payload preserves target', !!job && job.payload.target === 'probe', job && job.payload);
  await api('/api/control', { method: 'POST', body: { action: 'end' } });
  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
