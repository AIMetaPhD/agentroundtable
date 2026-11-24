'use strict';
/*
 * Real provider adapters for R2. No mock provider is used for acceptance.
 * Codex: codex exec/resume with native thread id.
 * Claude Code: claude --safe-mode/resume through the local MagPie gateway.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP = __dirname;
const DATA = process.env.R2_DATA_DIR ? path.resolve(process.env.R2_DATA_DIR) : path.join(APP, 'data');
const SANDBOX = path.join(DATA, 'sandbox');
const TURNS = path.join(DATA, 'turns');
fs.mkdirSync(TURNS, { recursive: true });

const MAGPIE = process.env.R2_MAGPIE_BASE || 'http://127.0.0.1:3425';
const CC_MODEL = process.env.R2_CC_MODEL || 'group/openrouter';

function run(cmd, args, { input = '', cwd = APP, env = process.env, timeoutMs = 240000, signal = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal && signal.aborted) return resolve({ code: -1, out: '', err: 'aborted before start', ms: 0, timedOut: false, killed: true, aborted: true, pid: null });
    const child = spawn(cmd, args, {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      shell: cmd === 'codex' || cmd.endsWith('.cmd'),
    });
    let out = ''; let err = ''; let timedOut = false; let killed = false; let settled = false;
    const killTree = () => {
      killed = true;
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    };
    const onAbort = () => { killTree(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const finish = (code, extra = {}) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, out, err, ms: Date.now() - started, timedOut, killed, aborted: !!(signal && signal.aborted), pid: child.pid, ...extra });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (e) => finish(-1, { err: err + '\n' + String(e) }));
    if (input) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}

function parseCodex(text) {
  let threadId = null; let last = null; let usage = null; const errors = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'thread.started') threadId = o.thread_id;
    if (o.type === 'item.completed' && o.item) {
      if (o.item.type === 'agent_message') last = o.item.text;
      if (o.item.type === 'error') errors.push(o.item.message);
    }
    if (o.type === 'turn.completed') usage = o.usage;
  }
  return { threadId, last, usage, errors };
}

function parseClaude(text) {
  let arr;
  try { arr = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(arr) ? arr : [arr];
  const init = list.find((x) => x.type === 'system' && x.subtype === 'init');
  const result = [...list].reverse().find((x) => x.type === 'result');
  return {
    sessionId: (result && result.session_id) || (init && init.session_id) || null,
    text: result ? result.result : null,
    isError: result ? !!result.is_error : true,
    usage: result && result.usage,
    costUsd: result && result.total_cost_usd,
    modelUsage: result && result.modelUsage,
    permissionDenials: result && result.permission_denials,
    terminalReason: result && result.terminal_reason,
  };
}

class CodexProvider {
  constructor({ id, sessionId = null, model = process.env.R2_CODEX_MODEL || '' }) {
    this.id = id; this.provider = 'codex-cli/openai'; this.sessionId = sessionId; this.model = model; this.busy = false;
  }
  async turn({ prompt, sandbox = 'read-only', tag = 'turn', timeoutMs = 360000, signal = null }) {
    if (this.busy) return { ok: false, error: 'provider busy' };
    this.busy = true;
    const dispatchId = `${this.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const lastFile = path.join(TURNS, dispatchId + '.last.txt');
    const args = ['exec'];
    if (this.sessionId) args.push('resume', this.sessionId);
    args.push('--json', '--ignore-user-config', '--skip-git-repo-check', '-o', lastFile,
      // Do not disable shell/unified_exec: read-only inspection is needed so
      // the agent can investigate instead of asking the human. Disable only
      // side-effect channels that are irrelevant to a discussion room.
      '--disable', 'browser_use', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'memories', '--disable', 'request_permissions_tool',
      '-c', 'agents.enabled=false',
      '-c', 'windows.sandbox="unelevated"', '-c', 'approval_policy="never"');
    // `codex exec resume` has no -s/-C: a resumed thread keeps its original
    // sandbox mode. Approved writes therefore use a fresh session (see dispatcher).
    if (!this.sessionId) args.push('-C', SANDBOX, '-s', sandbox);
    if (this.model) args.push('-m', this.model);
    args.push('-');
    try {
      const r = await run('codex', args, { input: prompt, cwd: SANDBOX, timeoutMs, signal });
      const parsed = parseCodex(r.out);
      const raw = path.join(TURNS, dispatchId + '.jsonl');
      fs.writeFileSync(raw, r.out, 'utf8');
      fs.writeFileSync(path.join(TURNS, dispatchId + '.err.txt'), r.err, 'utf8');
      const text = parsed.last || (fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : null);
      if (parsed.threadId) this.sessionId = parsed.threadId;
      const rec = { dispatchId, provider: this.provider, tag, ms: r.ms, code: r.code, timedOut: r.timedOut, aborted: !!r.aborted, usage: parsed.usage, errors: parsed.errors, raw: path.relative(APP, raw).replace(/\\/g, '/'), stderr: r.err.slice(-800) };
      if (r.aborted) return { ok: false, error: 'aborted', aborted: true, rec, sessionId: this.sessionId };
      if (r.code !== 0 || !text) {
        const m = String(r.err || '').split(String.fromCharCode(10)).find((line) => /thread-store conflict/i.test(line));
        const detail = m ? '：' + m.trim() : '';
        return { ok: false, error: `codex failed code=${r.code}${r.timedOut ? ' timeout' : ''}${detail}`, rec, sessionId: this.sessionId };
      }
      return { ok: true, text, sessionId: this.sessionId, rec };
    } finally { this.busy = false; }
  }
}

class ClaudeProvider {
  constructor({ id, sessionId = null, model = CC_MODEL }) {
    this.id = id; this.provider = 'claude-code-cli/magpie'; this.sessionId = sessionId; this.model = model; this.busy = false; this.lastEvents = [];
  }
  env() {
    const env = { ...process.env };
    for (const k of ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDECODE']) delete env[k];
    env.ANTHROPIC_BASE_URL = MAGPIE;
    env.ANTHROPIC_API_KEY = process.env.R2_MAGPIE_KEY || 'magpie';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    return env;
  }
  async turn({ prompt, permissionMode = 'dontAsk', tag = 'turn', timeoutMs = 240000, signal = null }) {
    if (this.busy) return { ok: false, error: 'provider busy' };
    this.busy = true;
    const dispatchId = `${this.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const args = ['--safe-mode', '-p', '--output-format', 'json', '--model', this.model,
      '--permission-mode', permissionMode, '--no-chrome', '--add-dir', SANDBOX];
    if (this.sessionId) args.push('--resume', this.sessionId);
    try {
      const r = await run('claude', args, { input: prompt, cwd: SANDBOX, env: this.env(), timeoutMs, signal });
      const parsed = parseClaude(r.out);
      const raw = path.join(TURNS, dispatchId + '.json');
      fs.writeFileSync(raw, r.out, 'utf8');
      fs.writeFileSync(path.join(TURNS, dispatchId + '.err.txt'), r.err, 'utf8');
      try { this.lastEvents = JSON.parse(r.out); } catch { this.lastEvents = []; }
      const rec = {
        dispatchId, provider: this.provider, tag, ms: r.ms, code: r.code, timedOut: r.timedOut,
        session_after: parsed && parsed.sessionId, usage: parsed && parsed.usage,
        cost_usd: parsed && parsed.costUsd, permission_denials: parsed && parsed.permissionDenials,
        terminal_reason: parsed && parsed.terminalReason, aborted: !!r.aborted,
        raw: path.relative(APP, raw).replace(/\\/g, '/'), stderr: r.err.slice(-800),
      };
      if (parsed && parsed.sessionId) this.sessionId = parsed.sessionId;
      if (r.aborted) return { ok: false, error: 'aborted', aborted: true, rec, sessionId: this.sessionId };
      if (r.code !== 0 || !parsed || parsed.isError || !parsed.text) return { ok: false, error: `claude failed code=${r.code}${r.timedOut ? ' timeout' : ''}`, rec, sessionId: this.sessionId };
      return { ok: true, text: parsed.text, sessionId: this.sessionId, rec };
    } finally { this.busy = false; }
  }
}

function parseSubagentEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const tool = list.find((e) => e.type === 'assistant' && Array.isArray(e.message && e.message.content) &&
    e.message.content.some((c) => c.type === 'tool_use' && c.name === 'Agent'));
  const toolUse = tool && tool.message.content.find((c) => c.type === 'tool_use' && c.name === 'Agent');
  const toolId = (toolUse && toolUse.id) || null;
  const childUsers = list.filter((e) => e.type === 'user' && e.agent_id);
  const childAssistants = list.filter((e) => e.type === 'assistant' && e.agent_id &&
    Array.isArray(e.message && e.message.content) &&
    e.message.content.some((c) => c.type === 'text' && String(c.text || '').trim()));
  const lastChild = childAssistants[childAssistants.length - 1];
  const childText = lastChild && Array.isArray(lastChild.message && lastChild.message.content)
    ? lastChild.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() : '';
  const subagentId = (lastChild && lastChild.agent_id) || (childUsers[childUsers.length - 1] && childUsers[childUsers.length - 1].agent_id) || null;
  // The Agent tool's tool_result is the harness's [Subagent hand-back] frame.
  // It carries the child agentId and the final report, so it is stronger
  // evidence than "parent's result text happens to match".
  const toolResult = toolId && list.find((e) => e.type === 'user' && Array.isArray(e.message && e.message.content) &&
    e.message.content.some((c) => c.type === 'tool_result' && c.tool_use_id === toolId));
  const handbackText = toolResult
    ? toolResult.message.content.filter((c) => c.type === 'tool_result')
      .flatMap((c) => Array.isArray(c.content) ? c.content : [])
      .filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
    : '';
  const handbackAgentId = (handbackText.match(/agentId:\s*([a-f0-9]+)/i) || [])[1] || null;
  const handbackOk = !!handbackText && /\[Subagent hand-back\]/.test(handbackText) &&
    !!handbackAgentId && handbackAgentId === subagentId;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return {
    tool_use_id: toolId,
    subagent_type: (toolUse && toolUse.input && toolUse.input.subagent_type) || null,
    subagent_id: subagentId,
    child_text: childText,
    handback_text: handbackText,
    handback_agent_id: handbackAgentId,
    handback_ok: handbackOk,
    child_events: childAssistants.length,
  };
}

class ClaudeSubagentProvider extends ClaudeProvider {
  constructor(opts) {
    super(opts);
    this.provider = 'claude-code-subagent/magpie';
  }
  async turn({ prompt, permissionMode = 'dontAsk', tag = 'subagent-turn', timeoutMs = 300000, signal = null }) {
    const parentPrompt = `你是「${this.id}」的父进程代理。必须使用 Agent 工具（subagent_type 为 general-purpose）恰好一次，把下面的房间问题原文交给子 Agent；不要自己回答，不要摘要或改写。子 Agent 只讨论、不修改文件，并且**不得再调用 Agent 工具**；它必须直接给出最终回复。拿到子 Agent 的最终原文后，原样返回。
房间问题：
${prompt}`;
    const result = await super.turn({ prompt: parentPrompt, permissionMode, tag, timeoutMs, signal });
    if (result.aborted) return result;
    const parsed = parseSubagentEvents(this.lastEvents);
    // Sometimes the harness surfaces the child's hand-back only as the parent's
    // final text (no agent_id on the text event). Accept that only when a real
    // Agent tool call, child ID and completed [Subagent hand-back] frame exist,
    // and label it as a parent relay.
    const relayText = (result.ok && result.text) ? String(result.text).trim() : '';
    const text = parsed.child_text || relayText;
    const textSource = parsed.child_text ? 'child-events' : (relayText ? 'parent-relay' : null);
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const relayMatchesHandback = !!text && !!parsed.handback_text &&
      norm(parsed.handback_text).includes(norm(text));
    const rec = {
      ...(result.rec || {}),
      parent_session_id: result.sessionId,
      parent_tool_use_id: parsed.tool_use_id,
      subagent_id: parsed.subagent_id,
      subagent_type: parsed.subagent_type,
      proxy: 'parent-process',
      text_source: textSource,
      child_events: parsed.child_events,
      handback_agent_id: parsed.handback_agent_id,
      handback_ok: parsed.handback_ok,
      relay_matches_handback: relayMatchesHandback,
    };
    if (!parsed.tool_use_id || !parsed.subagent_id || !text || !parsed.handback_ok || !relayMatchesHandback) {
      return { ok: false, error: 'subagent_not_verified', rec, sessionId: result.sessionId };
    }
    return { ok: true, text, sessionId: result.sessionId, rec };
  }
}

/*
 * Deterministic offline provider for automated tests and demos.
 * It parses the shared snapshot SHA-256 from the room prompt and echoes it,
 * so every agent reply proves which file version it consumed.
 */
class MockProvider {
  constructor({ id, sessionId = null } = {}) {
    this.id = id;
    this.provider = 'mock';
    this.sessionId = sessionId || ('mock-' + id + '-' + crypto.randomBytes(4).toString('hex'));
    this.busy = false;
  }
  async turn({ prompt, tag = 'mock-turn', signal = null }) {
    if (this.busy) return { ok: false, error: 'provider busy' };
    this.busy = true;
    try {
      if (signal && signal.aborted) {
        return { ok: false, error: 'aborted', aborted: true, rec: { dispatchId: 'mock-aborted', provider: this.provider, tag, ms: 0, aborted: true }, sessionId: this.sessionId };
      }
      const match = String(prompt || '').match(/sha256=([0-9a-f]{64})/i);
      const snapshotHash = match ? match[1] : 'unknown';
      const text = `[${this.id}] 收到讨论。当前共享文件快照 SHA-256 为 ${snapshotHash}。我同意推进此方案并建议下一步落地。`;
      const record = { dispatchId: 'mock-' + this.id + '-' + Date.now(), provider: this.provider, tag, ms: 1, code: 0, aborted: false, mock: true };
      return { ok: true, text, sessionId: this.sessionId, rec: record };
    } finally {
      this.busy = false;
    }
  }
}

function makeProvider(participant, { fresh = false } = {}) {
  const sessionId = fresh ? null : participant.session_id;
  if (process.env.R2_PROVIDER_MOCK === '1' || participant.provider === 'mock') {
    return new MockProvider({ id: participant.id, sessionId });
  }
  if (participant.provider === 'codex-cli/openai') return new CodexProvider({ id: participant.id, sessionId, model: participant.model || undefined });
  if (participant.provider === 'claude-code-cli/magpie') return new ClaudeProvider({ id: participant.id, sessionId, model: participant.model || undefined });
  if (participant.provider === 'claude-code-subagent/magpie') return new ClaudeSubagentProvider({ id: participant.id, sessionId, model: participant.model || undefined });
  throw new Error('unsupported provider: ' + participant.provider);
}

module.exports = { CodexProvider, ClaudeProvider, ClaudeSubagentProvider, MockProvider, parseSubagentEvents, makeProvider, DATA, SANDBOX, TURNS, CC_MODEL, MAGPIE };
