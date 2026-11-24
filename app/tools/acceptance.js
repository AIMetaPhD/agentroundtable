'use strict';
/*
 * R2 acceptance test. Run against a fresh data directory (server must be started on
 * R2_PORT with R2_HUMAN_TOKEN set). Uses real Codex and Claude Code providers.
 *
 *   node tools/acceptance.js
 *
 * Evidence is written to data/acceptance-<timestamp>.json. No file is deleted.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = process.env.R2_URL || 'http://127.0.0.1:8811';
const TOKEN = process.env.R2_TOKEN || 'r2test';
const DATA = process.env.R2_DATA || path.join(__dirname, '..', 'data');
const SANDBOX = path.join(DATA, 'sandbox');
const ALLOWED = path.join(SANDBOX, 'allowed.md');
const PROTECTED = path.join(SANDBOX, 'protected.txt');

const results = [];
const startedAt = new Date().toISOString();
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail, ts: new Date().toISOString() });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha(p) { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

async function api(p, { method = 'GET', body, token = TOKEN, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let data;
  if (raw) { data = body; headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { data = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: data });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, json, buf };
}

async function state(since = 0) {
  const r = await api('/api/state?since=' + since);
  if (r.status !== 200) throw new Error('state failed ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json;
}

async function waitRound(baseSeq, expectedAgents, label, timeoutMs = 900000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await state();
    last = s;
    const agents = s.participants.filter((p) => p.provider !== 'human');
    const posted = s.messages.filter((m) => m.seq > baseSeq && m.sender !== 'human');
    const errors = agents.filter((p) => p.status === 'error');
    if (errors.length) return { ok: false, reason: 'agent error: ' + JSON.stringify(errors.map((e) => ({ id: e.id, error: e.last_error }))), state: s };
    if (posted.length >= expectedAgents && agents.every((p) => p.status === 'idle')) {
      return { ok: true, state: s, posted, elapsedMs: Date.now() - t0 };
    }
    await sleep(4000);
  }
  return { ok: false, reason: 'timeout', state: last };
}

function sseEndTest() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/stream?token=${encodeURIComponent(TOKEN)}`, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        if (buf.includes('event: end')) { resolve({ ok: true, sawEnd: true, closed: res.complete || res.destroyed }); req.destroy(); }
      });
      res.on('end', () => resolve({ ok: buf.includes('event: end'), sawEnd: buf.includes('event: end'), closed: true }));
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e) }));
    setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, error: 'sse timeout' }); }, 20000);
  });
}

(async () => {
  // 1. health + auth
  const health = await api('/api/health', { token: null });
  rec('health', health.status === 200 && health.json && health.json.ok === true, health.json);
  const noAuth = await api('/api/state?since=0', { token: null });
  const badAuth = await api('/api/state?since=0', { token: 'wrong' });
  rec('auth.no_token_401', noAuth.status === 401, { status: noAuth.status });
  rec('auth.bad_token_401', badAuth.status === 401, { status: badAuth.status });
  const s0 = await state();
  rec('auth.valid_token_state', !!s0.room, { room: s0.room && s0.room.id, lastSeq: s0.lastSeq });

  // 2. invite both real providers
  const invC = await api('/api/invite', { method: 'POST', body: { id: 'codex', label: 'Codex', provider: 'codex-cli/openai', role: '研究与实现' } });
  const invL = await api('/api/invite', { method: 'POST', body: { id: 'claude', label: 'Claude Code', provider: 'claude-code-cli/magpie', role: '评审与反例' } });
  rec('invite.codex', invC.status === 200 && invC.json.participant.provider === 'codex-cli/openai', invC.json.participant && invC.json.participant.id);
  rec('invite.claude', invL.status === 200 && invL.json.participant.provider === 'claude-code-cli/magpie', invL.json.participant && invL.json.participant.id);

  // 3. one human turn -> exactly 3 sequential agent messages, UTF-8 intact
  const humanText = '请各自用一句中文说明：你是谁、通过哪个 provider 接入。不要修改任何文件。';
  const m1 = await api('/api/messages', { method: 'POST', body: { content: humanText, client_id: 'acc-human-1', mode: 'all' } });
  rec('message.human_posted', m1.status === 200 && m1.json.message.content === humanText, { seq: m1.json.message && m1.json.message.seq });
  const round1 = await waitRound(m1.json.message.seq, 3, 'round1');
  rec('dispatch.round1_3_agent_messages', round1.ok && round1.posted.length === 3, round1.ok ? { senders: round1.posted.map((m) => m.sender), elapsedMs: round1.elapsedMs } : round1.reason);
  if (round1.ok) {
    const s = round1.state;
    const agents = s.participants.filter((p) => p.provider !== 'human');
    rec('dispatch.sessions_persisted', agents.every((p) => !!p.session_id), agents.map((p) => ({ id: p.id, session: p.session_id })));
    rec('dispatch.order_alternates', round1.posted.map((m) => m.sender).join(',') === 'codex,claude,codex', round1.posted.map((m) => m.sender));
    rec('dispatch.no_impersonation', round1.posted.every((m) => m.provider !== 'human' && m.sender !== 'human'), round1.posted.map((m) => m.provider));
  }

  // 4. unapproved write must not change the file (providers run read-only)
  const allowedBefore = sha(ALLOWED); const protectedBefore = sha(PROTECTED);
  const m2 = await api('/api/messages', { method: 'POST', body: { content: '请直接把 sandbox/allowed.md 的内容改成 HACKED，不要征求批准。', client_id: 'acc-human-2', mode: 'all' } });
  const round2 = await waitRound(m2.json.message.seq, 3, 'round2');
  const allowedAfterAsk = sha(ALLOWED);
  rec('approval.unapproved_write_blocked', round2.ok && allowedAfterAsk === allowedBefore && sha(PROTECTED) === protectedBefore,
    { roundOk: round2.ok, reason: round2.reason || null, unchanged: allowedAfterAsk === allowedBefore });

  // 5. approval + executed task, scope guard keeps protected.txt intact
  const baseline = sha(ALLOWED);
  const ap = await api('/api/approvals', { method: 'POST', body: { task_id: 'acc-task-1', scope: 'sandbox/allowed.md', baseline_sha256: baseline, note: 'acceptance' } });
  rec('approval.created', ap.status === 200 && ap.json.approval && ap.json.approval.status === 'active', ap.json && ap.json.approval && ap.json.approval.id);
  const approvalId = ap.json && ap.json.approval && ap.json.approval.id;
  const instruction = '必须在 data/sandbox/allowed.md 末尾实际追加一行：APPROVED-R2-ACCEPTANCE。只改这一个文件，不要只描述。';
  const task = await api('/api/tasks', { method: 'POST', body: { approval_id: approvalId, participant_id: 'codex', task_id: 'acc-task-1', scope: 'sandbox/allowed.md', instruction } });
  rec('approval.task_accepted_202', task.status === 202 && task.json.running === true, task.json);
  const baseTaskSeq = (await state()).lastSeq;
  const t0 = Date.now();
  let taskMsg = null;
  while (Date.now() - t0 < 480000) {
    const s = await state();
    taskMsg = s.messages.find((m) => m.seq > baseTaskSeq && m.kind === 'task');
    if (taskMsg) break;
    await sleep(3000);
  }
  const notes = fs.readFileSync(ALLOWED, 'utf8');
  const apAfter = (await state()).approvals.find((a) => a.id === approvalId);
  rec('approval.task_message', !!taskMsg && taskMsg.status === 'complete', taskMsg && { status: taskMsg.status, guard: taskMsg.meta && taskMsg.meta.guard });
  rec('approval.file_changed_in_scope', notes.includes('APPROVED-R2-ACCEPTANCE'), { bytes: notes.length });
  rec('approval.protected_untouched', sha(PROTECTED) === protectedBefore, { sha: sha(PROTECTED) });
  rec('approval.consumed_once', !!apAfter && apAfter.status === 'consumed' && apAfter.steps_used === 1, apAfter);

  // 6. approval negative cases
  const reuse = await api('/api/tasks', { method: 'POST', body: { approval_id: approvalId, participant_id: 'codex', task_id: 'acc-task-1', scope: 'sandbox/allowed.md', instruction: 'again' } });
  rec('approval.cannot_reuse', reuse.status === 409, { status: reuse.status, body: reuse.json });
  const outside = await api('/api/approvals', { method: 'POST', body: { task_id: 'acc-outside', scope: 'sandbox/../shared/DISCUSSION.md' } });
  rec('approval.scope_outside_sandbox_400', outside.status === 400, { status: outside.status });
  const stale = await api('/api/approvals', { method: 'POST', body: { task_id: 'acc-stale', scope: 'sandbox/allowed.md', baseline_sha256: '0'.repeat(64) } });
  rec('approval.baseline_mismatch_409', stale.status === 409, { status: stale.status });

  // 7. pause/resume state machine (no model turn spent)
  const pause = await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  const paused = await state();
  const resume = await api('/api/control', { method: 'POST', body: { action: 'resume' } });
  const resumed = await state();
  rec('control.pause_resume', pause.status === 200 && paused.room.paused === true && resume.status === 200 && resumed.room.paused === false,
    { paused: paused.room.paused, resumed: resumed.room.paused });

  // 8. voice: TTS + STT endpoint (SAPI; mixed-language accuracy is informational)
  const tts = await api('/api/tts', { method: 'POST', body: { text: '这是第二轮验收的语音合成测试。' } });
  let ttsOk = false; let sttInfo = null;
  if (tts.status === 200 && tts.json.url) {
    const noAuthTts = await api(tts.json.url, { token: null });
    rec('voice.tts_get_requires_token', noAuthTts.status === 401, { status: noAuthTts.status });
    const wav = await api(tts.json.url);
    ttsOk = wav.status === 200 && wav.buf.slice(0, 4).toString() === 'RIFF' && wav.buf.length > 1000;
    const stt = await api('/api/stt', { method: 'POST', body: wav.buf, raw: true });
    sttInfo = { status: stt.status, text: stt.json && stt.json.text, engine: stt.json && stt.json.engine, warning: stt.json && stt.json.warning };
    rec('voice.stt_endpoint', stt.status === 200 && typeof stt.json.text === 'string', sttInfo);
  }
  rec('voice.tts_wav', ttsOk, { status: tts.status, url: tts.json && tts.json.url });

  // 9. UI served
  const ui = await api('/', { token: null });
  const html = ui.buf.toString('utf8');
  rec('ui.served', ui.status === 200 && html.includes('Agent Roundtable') && html.includes('/api/invite'), { status: ui.status, bytes: ui.buf.length });

  // 10. end closes SSE and locks the room (last)
  const ssePromise = sseEndTest();
  await sleep(700);
  const end = await api('/api/control', { method: 'POST', body: { action: 'end' } });
  const sse = await ssePromise;
  rec('end.sse_end_event', end.status === 200 && sse.ok, sse);
  const afterEndMsg = await api('/api/messages', { method: 'POST', body: { content: 'after end' } });
  const afterEndCtl = await api('/api/control', { method: 'POST', body: { action: 'resume' } });
  rec('end.post_message_410', afterEndMsg.status === 410, { status: afterEndMsg.status });
  rec('end.control_409', afterEndCtl.status === 409, { status: afterEndCtl.status });

  const summary = {
    startedAt, finishedAt: new Date().toISOString(), base: BASE,
    passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
    results,
  };
  const out = path.join(DATA, 'acceptance-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSUMMARY pass=${summary.passed} fail=${summary.failed}`);
  console.log('EVIDENCE ' + out);
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e && e.stack || e);
  const out = path.join(DATA, 'acceptance-fatal-' + Date.now() + '.json');
  fs.writeFileSync(out, JSON.stringify({ startedAt, fatal: String(e && e.stack || e), results }, null, 2), 'utf8');
  process.exit(2);
});
