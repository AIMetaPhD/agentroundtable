'use strict';
/* Dispatcher/cancellation tests with fake providers; no model calls. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../db');
const { Dispatcher } = require('../dispatcher');
const { ROOM, PARTICIPANT, TASK, JOB, MESSAGE } = require('../state');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, error: String(e.message || e) }); console.log('FAIL', name, '::', e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(20); }
  throw new Error('timeout waiting for condition');
}
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-disp-'));
  const store = new Store(dir);
  const broadcast = () => {};
  return { store, broadcast };
}
function provider(fn) { return (participant, opts) => ({ turn: (args) => fn(participant, args, opts) }); }
function addAgents(store) {
  store.ensureParticipant({ id: 'codex', label: 'Codex', provider: 'codex-cli/openai', role: 'r' });
  store.ensureParticipant({ id: 'claude', label: 'Claude', provider: 'claude-code-cli/magpie', role: 'r' });
  store.ensureParticipant({ id: 'subagent', label: 'Sub', provider: 'claude-code-subagent/magpie', role: 'r' });
}
function human(store, text, seq = store.lastSeq() + 1) {
  return store.addMessage({ sender: 'human', sender_label: '人类', provider: 'human', role: '决策者', kind: 'chat', content: text }).message;
}

(async () => {
  // 1. single round success + cursor
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'hello');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'reply-' + p.id, sessionId: 's-' + p.id, rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'single', humanSeq: h.seq });
    await waitFor(() => !d.status().running && store.messages(0).some((m) => m.kind === 'agent'));
    const msg = store.messages(0).find((m) => m.kind === 'agent');
    check('single posts one agent message', () => eq(msg.sender, 'codex'));
    check('single advances cursor', () => eq(store.cursor('codex') >= h.seq, true));
    check('single job done', () => eq(store.jobs()[0].state, JOB.DONE));
  }

  // 2. pause aborts current round and resume continues
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'pause me');
    let calls = 0;
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p, { signal }) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
        return { ok: false, aborted: true, error: 'aborted' };
      }
      return { ok: true, text: 'after-resume', sessionId: 's2', rec: { ms: 1 } };
    }) });
    d.enqueueRound({ mode: 'single', humanSeq: h.seq });
    await waitFor(() => store.participant('codex').status === PARTICIPANT.PROCESSING);
    store.transitionRoom('pause');
    d.stop('pause');
    await waitFor(() => store.jobs()[0].state === JOB.QUEUED);
    check('pause requeues round', () => eq(store.jobs()[0].state, JOB.QUEUED));
    check('pause leaves participant idle', () => eq(store.participant('codex').status, PARTICIPANT.IDLE));
    store.transitionRoom('resume');
    d.resume();
    await waitFor(() => store.messages(0).some((m) => m.kind === 'agent'));
    check('resume finishes round', () => eq(store.messages(0).find((m) => m.kind === 'agent').content, 'after-resume'));
  }

  // 2b. all mode must actually run A -> B -> A (repeated agent)
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'all');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'r-' + p.id, sessionId: 's-' + p.id, rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'all', humanSeq: h.seq });
    await waitFor(() => !d.status().running && store.jobs()[0].state === JOB.DONE);
    const agents = store.messages(0).filter((m) => m.kind === 'agent').map((m) => m.sender);
    check('all mode runs A-B-A', () => eq(agents.join(','), 'codex,claude,codex'));
  }

  // 2c. panel mode runs A -> B -> C -> A
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'panel success');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'r-' + p.id, sessionId: 's-' + p.id, rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'panel', humanSeq: h.seq });
    await waitFor(() => !d.status().running && store.jobs()[0].state === JOB.DONE);
    const agents = store.messages(0).filter((m) => m.kind === 'agent').map((m) => m.sender);
    check('panel mode runs A-B-C-A', () => eq(agents.join(','), 'codex,claude,subagent,codex'));
  }

  // 2d. directed target bypasses default rotation
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'target');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'targeted-' + p.id, sessionId: 's', rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'single', humanSeq: h.seq, target: 'claude' });
    await waitFor(() => !d.status().running && store.messages(0).some((m) => m.kind === 'agent'));
    check('targeted dispatch uses selected agent', () => eq(store.messages(0).find((m) => m.kind === 'agent').sender, 'claude'));
  }

  // 2e. invited session must be the session actually returned
  {
    const { store, broadcast } = fresh(); addAgents(store);
    store.updateParticipant('codex', { session_id: 'expected-session' });
    const h = human(store, 'mismatch');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async () => ({ ok: true, text: 'wrong-session', sessionId: 'other-session', rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'single', humanSeq: h.seq, target: 'codex' });
    await waitFor(() => !d.status().running && store.participants().find((p) => p.id === 'codex').status === PARTICIPANT.ERROR);
    check('session mismatch posts no agent message', () => eq(store.messages(0).filter((m) => m.kind === 'agent').length, 0));
    check('session mismatch records error', () => eq(/session_mismatch/.test(store.participant('codex').last_error || ''), true));
  }

  // 2f. disabled target must not fall back to another agent
  {
    const { store, broadcast } = fresh(); addAgents(store);
    store.updateParticipant('claude', { disabled: true, status: PARTICIPANT.DISABLED });
    const h = human(store, 'disabled target');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'should-not-run-' + p.id, sessionId: 's', rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'single', humanSeq: h.seq, target: 'claude' });
    await waitFor(() => !d.status().running);
    check('disabled target posts no other agent', () => eq(store.messages(0).filter((m) => m.kind === 'agent').length, 0));
    check('disabled target posts system notice', () => eq(store.messages(0).some((m) => m.kind === 'system'), true));
  }

  // 3. panel chain stops on first failure
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'panel');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => {
      if (p.id === 'codex') return { ok: false, error: 'boom' };
      return { ok: true, text: 'should-not-run', sessionId: 's', rec: { ms: 1 } };
    }) });
    d.enqueueRound({ mode: 'panel', humanSeq: h.seq });
    await waitFor(() => !d.status().running && store.jobs()[0].state === JOB.FAILED);
    const agents = store.messages(0).filter((m) => m.kind === 'agent');
    check('panel failure posts no later agent', () => eq(agents.length, 0));
    check('panel failure posts system message', () => eq(store.messages(0).some((m) => m.kind === 'system' && m.status === MESSAGE.FAILED), true));
  }

  // 4. queued human messages are two jobs, not one rerun
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h1 = human(store, 'one');
    const h2 = human(store, 'two');
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'r-' + p.id, sessionId: 's', rec: { ms: 1 } })) });
    d.enqueueRound({ mode: 'single', humanSeq: h1.seq });
    d.enqueueRound({ mode: 'single', humanSeq: h2.seq });
    await waitFor(() => !d.status().running && store.jobs().filter((j) => j.state === JOB.DONE).length === 2);
    const agents = store.messages(0).filter((m) => m.kind === 'agent');
    check('two messages -> two rounds', () => eq(agents.length, 2));
    check('two rounds use different agents', () => eq(new Set(agents.map((m) => m.sender)).size, 2));
  }

  // 5. pause cancels an in-flight task, records cancelled task message
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const allowed = path.join(store.sandboxDir, 'allowed.md');
    const baseline = require('crypto').createHash('sha256').update(fs.readFileSync(allowed)).digest('hex');
    const ap = store.addApproval({ task_id: 't', scope: 'sandbox/allowed.md', baseline_sha256: baseline, ttl_ms: 60000 }).approval;
    const created = store.createTaskAndConsume({ approval_id: ap.id, task_id: 't', participant_id: 'codex', scope: 'sandbox/allowed.md', instruction: 'x', baseline_sha256: baseline });
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p, { signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { ok: false, aborted: true, error: 'aborted' };
    }) });
    d.kick();
    await waitFor(() => store.task(created.task.id).state === TASK.RUNNING);
    store.transitionRoom('pause');
    d.stop('pause');
    await waitFor(() => store.task(created.task.id).state === TASK.CANCELLED);
    check('cancelled task state', () => eq(store.task(created.task.id).state, TASK.CANCELLED));
    check('cancelled task message', () => eq(store.messages(0).some((m) => m.kind === 'task' && m.status === MESSAGE.CANCELLED), true));
    check('task approval stays consumed', () => eq(store.approval(ap.id).status, 'consumed'));
  }

  // 6. restart recovery re-queues a running round and resumes it
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const h = human(store, 'restart');
    const job = store.addJob('round', { mode: 'single', human_seq: h.seq, completed: [] });
    store.updateJobState(job.id, 'start', { started_at: new Date().toISOString() });
    const recovered = new Store(store.dataDir);
    check('restart re-queues round', () => eq(recovered.job(job.id).state, JOB.QUEUED));
    const d = new Dispatcher({ store: recovered, broadcast, providerFactory: provider(async (p) => ({ ok: true, text: 'after-restart', sessionId: 's', rec: { ms: 1 } })) });
    d.start();
    await waitFor(() => recovered.messages(0).some((m) => m.kind === 'agent'));
    check('restart resumes round', () => eq(recovered.messages(0).find((m) => m.kind === 'agent').content, 'after-restart'));
  }

  // 7. end cancels an in-flight task and closes the approval lifecycle
  {
    const { store, broadcast } = fresh(); addAgents(store);
    const allowed = path.join(store.sandboxDir, 'allowed.md');
    const baseline = require('crypto').createHash('sha256').update(fs.readFileSync(allowed)).digest('hex');
    const ap = store.addApproval({ task_id: 't-end', scope: 'sandbox/allowed.md', baseline_sha256: baseline, ttl_ms: 60000 }).approval;
    const created = store.createTaskAndConsume({ approval_id: ap.id, task_id: 't-end', participant_id: 'codex', scope: 'sandbox/allowed.md', instruction: 'x', baseline_sha256: baseline });
    const d = new Dispatcher({ store, broadcast, providerFactory: provider(async (p, { signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { ok: false, aborted: true, error: 'aborted' };
    }) });
    d.kick();
    await waitFor(() => store.task(created.task.id).state === TASK.RUNNING);
    store.transitionRoom('end');
    d.stop('end');
    d.cancelAll('meeting ended');
    await waitFor(() => store.task(created.task.id).state === TASK.CANCELLED);
    check('end cancels task', () => eq(store.task(created.task.id).state, TASK.CANCELLED));
    check('end leaves room ended', () => eq(store.room().state, ROOM.ENDED));
  }

  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
