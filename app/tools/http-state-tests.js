'use strict';
/* HTTP-level state tests against a running server. No model calls. */
const http = require('http');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8831';
const TOKEN = process.env.R2_TOKEN || 'http-test';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)}`);
}
async function api(p, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let data;
  if (body !== undefined) { data = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: data });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const health = await api('/api/health', { token: null });
  check('health has explicit room/worker/schema', health.status === 200 && health.json.schema_version >= 3 && health.json.room === 'active' && health.json.worker, health.json);
  const noAuth = await api('/api/state', { token: null });
  check('no token 401', noAuth.status === 401);

  // pause -> message is queued -> resume drains it even with no agents (system message)
  const pause = await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  check('pause -> paused', pause.status === 200 && pause.json.state === 'paused', pause.json);
  const queued = await api('/api/messages', { method: 'POST', body: { content: 'queued while paused', mode: 'single' } });
  check('message while paused is queued, not dropped', queued.status === 200 && queued.json.queued === true && queued.json.job_id, queued.json);
  const pausedState = await api('/api/state');
  check('queued job visible', pausedState.json.jobs.some((j) => j.state === 'queued'), pausedState.json.jobs.map((j) => j.state));
  const resume = await api('/api/control', { method: 'POST', body: { action: 'resume' } });
  check('resume -> active', resume.status === 200 && resume.json.state === 'active', resume.json);
  let drained = null;
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const s = await api('/api/state');
    if (s.json.messages.some((m) => m.kind === 'system')) { drained = s.json; break; }
  }
  check('resume drains queued message', !!drained && drained.jobs.every((j) => j.state !== 'queued'), drained && drained.jobs.map((j) => j.state));

  // approval lifecycle: revoke, expiry, paused task rejection
  const files = await api('/api/files');
  const allowed = files.json.files.find((f) => f.path === 'sandbox/allowed.md');
  const ap1 = await api('/api/approvals', { method: 'POST', body: { task_id: 'revoke-me', scope: 'sandbox/allowed.md', baseline_sha256: allowed.sha256, ttl_ms: 60000 } });
  check('approval active with expires_at', ap1.status === 200 && ap1.json.approval.status === 'active' && !!ap1.json.approval.expires_at, ap1.json.approval);
  const revoke = await api('/api/approvals/' + ap1.json.approval.id + '/revoke', { method: 'POST' });
  check('revoke active -> revoked', revoke.status === 200 && revoke.json.approval.status === 'revoked', revoke.json);
  const revokeAgain = await api('/api/approvals/' + ap1.json.approval.id + '/revoke', { method: 'POST' });
  check('revoke terminal -> 409', revokeAgain.status === 409, revokeAgain.json);

  const ap2 = await api('/api/approvals', { method: 'POST', body: { task_id: 'expire-me', scope: 'sandbox/allowed.md', baseline_sha256: allowed.sha256, ttl_ms: 10 } });
  await sleep(60);
  const exp = await api('/api/state');
  check('expired approval visible', exp.json.approvals.find((a) => a.id === ap2.json.approval.id).status === 'expired', exp.json.approvals);
  const expiredTask = await api('/api/tasks', { method: 'POST', body: { approval_id: ap2.json.approval.id, participant_id: 'codex', task_id: 'expire-me', scope: 'sandbox/allowed.md', instruction: 'x' } });
  check('expired approval task rejected', expiredTask.status === 409, expiredTask.json);

  const ap3 = await api('/api/approvals', { method: 'POST', body: { task_id: 'paused-task', scope: 'sandbox/allowed.md', baseline_sha256: allowed.sha256, ttl_ms: 60000 } });
  await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  const pausedTask = await api('/api/tasks', { method: 'POST', body: { approval_id: ap3.json.approval.id, participant_id: 'codex', task_id: 'paused-task', scope: 'sandbox/allowed.md', instruction: 'x' } });
  check('task while paused 409', pausedTask.status === 409, pausedTask.json);
  await api('/api/control', { method: 'POST', body: { action: 'resume' } });

  // SSE replay via Last-Event-ID
  const sse = await new Promise((resolve) => {
    const req = http.get(BASE + '/api/stream?token=' + encodeURIComponent(TOKEN), { headers: { 'Last-Event-ID': '1' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.includes('"type":"hello"')) { req.destroy(); resolve({ ok: true, buf }); } });
      res.on('end', () => resolve({ ok: true, buf }));
    });
    req.on('error', () => resolve({ ok: false, buf: '' }));
    setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: true, buf: '' }); }, 1500);
  });
  check('SSE replays messages after Last-Event-ID', sse.ok && /id: 2\b/.test(sse.buf), sse.buf.slice(0, 300));

  // disabled participant route + health error visibility
  const inv = await api('/api/invite', { method: 'POST', body: { id: 'codex', label: 'Codex', provider: 'codex-cli/openai', role: 'r' } });
  check('invite codex', inv.status === 200 && inv.json.participant.disabled === false, inv.json.participant);
  const disable = await api('/api/participants/codex/disable', { method: 'POST' });
  check('disable participant', disable.status === 200 && disable.json.participant.disabled === true && disable.json.participant.status === 'disabled', disable.json);
  const enable = await api('/api/participants/codex/enable', { method: 'POST' });
  check('enable participant', enable.status === 200 && enable.json.participant.disabled === false && enable.json.participant.status === 'idle', enable.json);

  // end is terminal and idempotent
  const end = await api('/api/control', { method: 'POST', body: { action: 'end' } });
  const end2 = await api('/api/control', { method: 'POST', body: { action: 'end' } });
  check('end idempotent', end.status === 200 && end2.status === 200 && end.json.state === 'ended' && end2.json.state === 'ended', { end: end.json.state, end2: end2.json.state });
  const afterMsg = await api('/api/messages', { method: 'POST', body: { content: 'after end' } });
  const afterPause = await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  check('ended room rejects message 410', afterMsg.status === 410, afterMsg.status);
  check('ended room rejects pause 409', afterPause.status === 409, afterPause.status);

  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
