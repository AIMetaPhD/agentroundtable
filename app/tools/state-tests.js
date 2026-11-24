'use strict';
/* Deterministic state-machine tests; no model calls. Run: node tools/state-tests.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../db');
const { ROOM, PARTICIPANT, APPROVAL, TASK, JOB } = require('../state');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, error: String(e.message || e) }); console.log('FAIL', name, '::', e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`); }
function throws(fn, msg) { try { fn(); } catch { return; } throw new Error(msg || 'expected throw'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-state-'));
  let store = new Store(dir);
  check('room starts active', () => eq(store.room().state, ROOM.ACTIVE));
  check('pause -> paused', () => eq(store.transitionRoom('pause').state, ROOM.PAUSED));
  check('resume -> active', () => eq(store.transitionRoom('resume').state, ROOM.ACTIVE));
  check('pause again', () => eq(store.transitionRoom('pause').state, ROOM.PAUSED));
  check('end from paused', () => eq(store.transitionRoom('end').state, ROOM.ENDED));
  check('end idempotent', () => eq(store.transitionRoom('end').state, ROOM.ENDED));
  check('resume after end rejected', () => throws(() => store.transitionRoom('resume')));

  // New room for approval/task tests.
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-state-')));
  const allowed = path.join(store.sandboxDir, 'allowed.md');
  const baseline = require('crypto').createHash('sha256').update(fs.readFileSync(allowed)).digest('hex');
  const ap = store.addApproval({ task_id: 't1', scope: 'sandbox/allowed.md', baseline_sha256: baseline, ttl_ms: 5000 });
  check('approval active', () => eq(ap.approval.status, APPROVAL.ACTIVE));
  check('duplicate active approval conflict', () => {
    const again = store.addApproval({ task_id: 't1', scope: 'sandbox/allowed.md', baseline_sha256: baseline });
    if (!again.conflict) throw new Error('expected conflict');
  });
  const exp = store.addApproval({ task_id: 't-expire', scope: 'sandbox/allowed.md', baseline_sha256: baseline, ttl_ms: 10 });
  await sleep(40);
  store.expireApprovals();
  check('expired approval', () => eq(store.approval(exp.approval.id).status, APPROVAL.EXPIRED));
  check('expired approval cannot be consumed', () => throws(() => store.createTaskAndConsume({
    approval_id: exp.approval.id, task_id: 't-expire', participant_id: 'human',
    scope: 'sandbox/allowed.md', instruction: 'x', baseline_sha256: baseline,
  })));
  check('revoke active', () => eq(store.transitionApproval(ap.approval.id, 'revoke').status, APPROVAL.REVOKED));
  check('revoke consumed rejected', () => throws(() => store.transitionApproval(ap.approval.id, 'revoke')));

  const ap2 = store.addApproval({ task_id: 't2', scope: 'sandbox/allowed.md', baseline_sha256: baseline, ttl_ms: 60000 }).approval;
  const created = store.createTaskAndConsume({
    approval_id: ap2.id, task_id: 't2', participant_id: 'human',
    scope: 'sandbox/allowed.md', instruction: 'x', baseline_sha256: baseline,
  });
  check('task created queued', () => eq(created.task.state, TASK.QUEUED));
  check('approval consumed atomically', () => eq(store.approval(ap2.id).status, APPROVAL.CONSUMED));
  check('task job queued', () => eq(store.job(created.job.id).state, JOB.QUEUED));
  store.updateJobState(created.job.id, 'start', { started_at: new Date().toISOString() });
  store.updateTaskState(created.task.id, 'start', { started_at: new Date().toISOString() });
  check('task running', () => eq(store.task(created.task.id).state, TASK.RUNNING));
  store.updateTaskState(created.task.id, 'complete', { finished_at: new Date().toISOString() });
  check('task complete', () => eq(store.task(created.task.id).state, TASK.COMPLETED));
  check('complete task cannot cancel', () => throws(() => store.updateTaskState(created.task.id, 'cancel')));

  store.ensureParticipant({ id: 'codex', label: 'Codex', provider: 'codex-cli/openai', role: 'r' });
  store.updateParticipant('codex', { disabled: true, status: PARTICIPANT.DISABLED });
  check('participant disabled', () => eq(store.participant('codex').disabled, true));
  store.updateParticipant('codex', { disabled: false, status: PARTICIPANT.IDLE });
  check('participant enabled', () => eq(store.participant('codex').disabled, false));

  // Recovery: running round is retried, running task is orphaned, processing clears.
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-recovery-'));
  const recoveryStore = new Store(recoveryDir);
  const rAllowed = path.join(recoveryStore.sandboxDir, 'allowed.md');
  const rBaseline = require('crypto').createHash('sha256').update(fs.readFileSync(rAllowed)).digest('hex');
  recoveryStore.ensureParticipant({ id: 'claude', label: 'Claude', provider: 'claude-code-cli/magpie', role: 'r' });
  recoveryStore.updateParticipant('claude', { status: PARTICIPANT.PROCESSING });
  const round = recoveryStore.addJob('round', { mode: 'single', human_seq: 1, completed: [] });
  recoveryStore.updateJobState(round.id, 'start');
  const task2 = recoveryStore.createTaskAndConsume({
    approval_id: recoveryStore.addApproval({ task_id: 't3', scope: 'sandbox/allowed.md', baseline_sha256: rBaseline, ttl_ms: 60000 }).approval.id,
    task_id: 't3', participant_id: 'human', scope: 'sandbox/allowed.md', instruction: 'x', baseline_sha256: rBaseline,
  }).task;
  const taskJob = recoveryStore.jobs().find((j) => j.payload.task_id === task2.id);
  recoveryStore.updateJobState(taskJob.id, 'start');
  recoveryStore.updateTaskState(task2.id, 'start');
  const recovered = new Store(recoveryDir);
  check('recovery retries round', () => eq(recovered.job(round.id).state, JOB.QUEUED));
  check('recovery orphans task', () => eq(recovered.task(task2.id).state, TASK.ORPHANED));
  check('recovery clears processing', () => eq(recovered.participant('claude').status, PARTICIPANT.UNKNOWN));

  // Participant order must preserve insertion order when created_at ties.
  {
    const tieStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-order-')));
    const ts = '2026-01-01T00:00:00.000Z';
    const ins = tieStore.db.prepare('INSERT INTO participants(id,room_id,label,provider,role,status,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('z-first', 'main', 'Z first', 'codex-cli/openai', 'r', 'idle', 0, ts, ts);
    ins.run('a-second', 'main', 'A second', 'claude-code-cli/magpie', 'r', 'idle', 0, ts, ts);
    const ids = tieStore.participants().map((p) => p.id).filter((x) => x !== 'human');
    check('same-ms invite order uses rowid', () => eq(ids.join(','), 'z-first,a-second'));
  }

  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
