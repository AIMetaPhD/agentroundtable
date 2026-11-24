'use strict';
/*
 * Agent Roundtable — local-first meeting app.
 * Node 24 + node:sqlite, no third-party runtime dependencies.
 * Real Codex/Claude Code sessions only; no mock provider is used for acceptance.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Store, SCHEMA_VERSION } = require('./db');
const { Dispatcher } = require('./dispatcher');
const { SANDBOX } = require('./providers');
const { listSessions, findSession } = require('./sessions');
const { ROOM, PARTICIPANT, APPROVAL, MESSAGE } = require('./state');

const APP = __dirname;
const DATA = process.env.R2_DATA_DIR ? path.resolve(process.env.R2_DATA_DIR) : path.join(APP, 'data');
const PORT = Number(process.env.R2_PORT || 8810);
const PUBLIC = path.join(APP, 'public');
const TOOLS = path.join(APP, 'tools');
const TTS_DIR = path.join(DATA, 'tts');
const TMP_DIR = path.join(DATA, 'tmp');
for (const d of [DATA, TTS_DIR, TMP_DIR, SANDBOX]) fs.mkdirSync(d, { recursive: true });

const store = new Store(DATA);
const HUMAN_TOKEN = process.env.R2_HUMAN_TOKEN || crypto.randomBytes(24).toString('hex');
const TOKEN_FILE = path.join(DATA, 'room-token.txt');
fs.writeFileSync(TOKEN_FILE, HUMAN_TOKEN, { encoding: 'utf8', mode: 0o600 });

const sse = new Set();
function sseFrame(obj) {
  let out = '';
  if (obj.type === 'message' && obj.message && obj.message.seq) out += `id: ${obj.message.seq}\n`;
  return out + `data: ${JSON.stringify(obj)}\n\n`;
}
function broadcast(obj) {
  const frame = sseFrame(obj);
  for (const res of sse) { try { res.write(frame); } catch { /* ignore */ } }
}
const dispatcher = new Dispatcher({ store, broadcast });

// Abortable long-running child work (TTS/STT). End aborts all of it.
const activeControllers = new Set();
const TTS_LOCKS = new Map();
function track(controller) { activeControllers.add(controller); return controller; }
function untrack(controller) { activeControllers.delete(controller); }
function abortActive() {
  for (const c of activeControllers) { try { c.abort(); } catch { /* ignore */ } }
  activeControllers.clear();
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}
function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authOf(req, url) {
  const h = req.headers['authorization'];
  const raw = (h && h.startsWith('Bearer ')) ? h.slice(7).trim() : String(req.headers['x-room-token'] || (url && url.searchParams.get('token')) || '').trim();
  return raw && raw === HUMAN_TOKEN ? { role: 'human', id: 'human' } : null;
}
function requireHuman(req, res, url) {
  const a = authOf(req, url);
  if (!a) { json(res, 401, { error: 'human token required' }); return null; }
  return a;
}
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function closeSse() {
  for (const res of sse) {
    try {
      res.write(`event: end\ndata: ${JSON.stringify({ type: 'end', ts: new Date().toISOString() })}\n\n`);
      res.end(() => { try { if (res.socket) res.socket.destroy(); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }
  sse.clear();
}
function runPowerShell(script, args, timeoutMs = 180000, signal = null) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, script), ...args],
      { timeout: timeoutMs, windowsHide: true, encoding: 'buffer', signal },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code || 1) : 0,
        aborted: !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')),
        stdout: stdout ? stdout.toString('utf8') : '',
        stderr: stderr ? stderr.toString('utf8') : '',
        ms: Date.now() - t0,
      }));
  });
}
/*
 * Allowed project roots are persisted in data/projects.json so the human can
 * add a folder from the UI without editing environment variables. The app
 * parent folder is always available; R2_SHARED_ROOTS still adds read-only
 * roots for scripted setups.
 */
const PROJECTS_FILE = path.join(DATA, 'projects.json');
const DEFAULT_ROOT = path.resolve(APP, '..');
function loadProjectRoots() {
  const roots = [DEFAULT_ROOT];
  try {
    const saved = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(saved.roots)) roots.push(...saved.roots.map(String));
  } catch { /* first run */ }
  for (const x of String(process.env.R2_SHARED_ROOTS || '').split(';')) {
    if (x.trim()) roots.push(path.resolve(x.trim()));
  }
  const seen = new Set();
  return roots.filter((r) => {
    const key = path.resolve(r);
    if (seen.has(key) || !fs.existsSync(key)) return false;
    seen.add(key);
    return true;
  });
}
function saveProjectRoot(realPath) {
  const roots = loadProjectRoots().filter((r) => path.resolve(r) !== DEFAULT_ROOT);
  if (!roots.some((r) => path.resolve(r) === realPath)) roots.push(realPath);
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ roots }, null, 2), 'utf8');
}
function isWithin(root, real) {
  let rr;
  try { rr = fs.realpathSync(root); } catch { rr = root; }
  const rel = path.relative(rr, real);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function allowedRoots() { return loadProjectRoots(); }
function resolveSharedFile(input) {
  if (!input || typeof input !== 'string') return null;
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(DEFAULT_ROOT, input);
  let real;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  if (!allowedRoots().some((root) => isWithin(root, real))) return null;
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
  if (!/\.(md|markdown|txt)$/i.test(real)) return null;
  return { path: real, content: fs.readFileSync(real, 'utf8'), sha256: sha256File(real) };
}
function browseProject(input) {
  const candidate = path.isAbsolute(input || '') ? path.resolve(input) : DEFAULT_ROOT;
  let real;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  if (!allowedRoots().some((root) => isWithin(root, real))) return null;
  const st = fs.statSync(real);
  if (!st.isDirectory()) return null;
  const dirs = []; const files = [];
  for (const e of fs.readdirSync(real, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const fp = path.join(real, e.name);
    if (e.isDirectory()) {
      if (dirs.length < 200) dirs.push({ name: e.name, path: fp });
    } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name) && files.length < 200) {
      try { files.push({ name: e.name, path: fp, size: fs.statSync(fp).size }); } catch { /* skip */ }
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const roots = allowedRoots().map((r) => ({ path: r, isDefault: path.resolve(r) === DEFAULT_ROOT }));
  const atRoot = roots.find((r) => path.resolve(r.path) === real);
  const parent = atRoot ? null : path.dirname(real);
  return { path: real, parent, dirs: dirs.slice(0, 100), files, roots };
}
function resolveSandbox(scope) {
  if (!scope || typeof scope !== 'string') return null;
  if (!scope.startsWith('sandbox/')) return null;
  const p = path.resolve(DATA, scope);
  if (!p.startsWith(SANDBOX + path.sep)) return null;
  return p;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      const room = store.room();
      const errors = store.participants().filter((x) => x.status === PARTICIPANT.ERROR).map((x) => ({ id: x.id, error: x.last_error }));
      return json(res, 200, {
        ok: true, port: PORT, schema_version: SCHEMA_VERSION,
        room: room.state, room_id: room.id, worker: dispatcher.status(),
        queued_jobs: store.hasQueuedJobs(), participant_errors: errors,
      });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const f = path.join(PUBLIC, p.slice('/static/'.length));
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript', 'content-length': data.length });
      return res.end(data);
    }
    if (req.method === 'GET' && p === '/api/stream') {
      const a = authOf(req, url);
      if (!a) return json(res, 401, { error: 'token required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      // Replay messages the browser missed while disconnected. EventSource
      // sends Last-Event-ID automatically; the client also reconciles by seq.
      const lastId = Number(req.headers['last-event-id'] || 0);
      if (lastId > 0) {
        for (const m of store.messages(lastId)) {
          res.write(`id: ${m.seq}\ndata: ${JSON.stringify({ type: 'message', message: m })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ type: 'hello', lastSeq: store.lastSeq(), room: store.room(), worker: dispatcher.status() })}\n\n`);
      if (store.room().state === ROOM.ENDED) {
        res.write(`event: end\ndata: ${JSON.stringify({ type: 'end' })}\n\n`);
        return res.end(() => { try { if (res.socket) res.socket.destroy(); } catch { /* ignore */ } });
      }
      sse.add(res);
      const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(hb); sse.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      const since = Number(url.searchParams.get('since') || 0);
      const st = store.state(since);
      st.shared = (() => { const s = store.shared(); return { path: s.path, sha256: s.sha256, bytes: s.bytes, source_path: s.source_path, source_sha256: s.source_sha256, selected_at: s.selected_at }; })();
      st.tokenFile = 'data/room-token.txt';
      st.worker = dispatcher.status();
      st.schema_version = SCHEMA_VERSION;
      return json(res, 200, st);
    }
    if (req.method === 'GET' && p === '/api/messages') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      return json(res, 200, { messages: store.messages(Number(url.searchParams.get('since') || 0)), lastSeq: store.lastSeq() });
    }
    if (req.method === 'GET' && p === '/api/rooms') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      const rooms = store.rooms();
      const active = rooms.find((r) => r.state !== ROOM.ENDED) || null;
      return json(res, 200, {
        room_id: store.roomId,
        active_room_id: active ? active.id : null,
        rooms: rooms.map((r) => ({
          id: r.id, name: r.name, state: r.state, created_at: r.created_at,
          message_count: r.message_count, agent_count: r.agent_count,
        })),
      });
    }
    if (req.method === 'POST' && p === '/api/rooms') {
      const a = requireHuman(req, res, url); if (!a) return;
      if (dispatcher.status().running) return json(res, 409, { error: '当前回合执行中，请等待或暂停后再新建会议' });
      if (store.rooms().some((r) => r.state !== ROOM.ENDED)) return json(res, 409, { error: '还有未结束的会议；请先点“结束”' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const room = store.createRoom({ name: b.name, objective: b.objective });
      broadcast({ type: 'room_switch', room, rooms: store.rooms() });
      return json(res, 200, { room, rooms: store.rooms().map((r) => ({ id: r.id, name: r.name, state: r.state, created_at: r.created_at })) });
    }
    if (req.method === 'POST' && /^\/api\/rooms\/[^/]+\/select$/.test(p)) {
      const a = requireHuman(req, res, url); if (!a) return;
      if (dispatcher.status().running) return json(res, 409, { error: '当前回合执行中，请等待或暂停后再切换会议' });
      const roomId = decodeURIComponent(p.split('/')[3]);
      const target = store.roomById(roomId);
      if (!target) return json(res, 404, { error: 'room not found' });
      const room = store.useRoom(roomId);
      broadcast({ type: 'room_switch', room, rooms: store.rooms() });
      if (room.state === ROOM.ACTIVE) dispatcher.kick().catch((e) => store.event('worker_error', { error: String(e.stack || e) }));
      return json(res, 200, { room, rooms: store.rooms().map((r) => ({ id: r.id, name: r.name, state: r.state, created_at: r.created_at })) });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      const provider = String(url.searchParams.get('provider') || '');
      if (!['codex', 'claude'].includes(provider)) return json(res, 400, { error: 'provider must be codex|claude' });
      try {
        return json(res, 200, { provider, sessions: listSessions(provider, { limit: url.searchParams.get('limit') }) });
      } catch (e) {
        return json(res, 500, { error: '无法读取会话列表：' + String(e.message || e) });
      }
    }
    if (req.method === 'GET' && p === '/api/projects') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      return json(res, 200, { roots: allowedRoots(), default_root: DEFAULT_ROOT });
    }
    if (req.method === 'POST' && p === '/api/projects/roots') {
      const a = requireHuman(req, res, url); if (!a) return;
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const input = String(b.path || '').trim();
      if (!input) return json(res, 400, { error: 'path required' });
      let real;
      try { real = fs.realpathSync(path.isAbsolute(input) ? input : path.resolve(DEFAULT_ROOT, input)); }
      catch { return json(res, 400, { error: '目录不存在' }); }
      if (!fs.statSync(real).isDirectory()) return json(res, 400, { error: '不是目录' });
      saveProjectRoot(real);
      return json(res, 200, { roots: allowedRoots(), added: real });
    }
    if (req.method === 'GET' && p === '/api/projects/browse') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      const out = browseProject(url.searchParams.get('path') || '');
      if (!out) return json(res, 400, { error: '路径不在已授权的项目根目录内' });
      return json(res, 200, out);
    }
    if (req.method === 'GET' && p === '/api/shared') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      return json(res, 200, store.shared());
    }
    if (req.method === 'POST' && p === '/api/shared/select') {
      const a = requireHuman(req, res, url); if (!a) return;
      if (store.room().state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const picked = resolveSharedFile(b.path);
      if (!picked) return json(res, 400, { error: 'path must be an existing .md/.txt under an allowed project root (max 2 MiB)' });
      const shared = store.setSharedFile({ sourcePath: picked.path, content: picked.content, sourceSha256: picked.sha256 });
      store.event('shared_selected', { source_path: picked.path, source_sha256: picked.sha256, snapshot_sha256: shared.sha256 });
      broadcast({ type: 'shared', shared: { path: shared.path, sha256: shared.sha256, bytes: shared.bytes, source_path: shared.source_path, source_sha256: shared.source_sha256 } });
      return json(res, 200, { shared: { path: shared.path, sha256: shared.sha256, bytes: shared.bytes, source_path: shared.source_path, source_sha256: shared.source_sha256, selected_at: shared.selected_at } });
    }
    if (req.method === 'GET' && p === '/api/files') {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      return json(res, 200, { files: store.sandboxFiles() });
    }
    if (req.method === 'POST' && p === '/api/invite') {
      const a = requireHuman(req, res, url); if (!a) return;
      if (store.room().state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const provider = b.provider;
      if (!['codex-cli/openai', 'claude-code-cli/magpie', 'claude-code-subagent/magpie', 'mock'].includes(provider)) return json(res, 400, { error: 'unsupported provider' });
      const id = String(b.id || provider.split('/')[0]).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'agent';
      if (id === 'human') return json(res, 400, { error: 'reserved participant id' });
      const sessionId = b.session_id ? String(b.session_id).trim() : null;
      if (sessionId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sessionId)) return json(res, 400, { error: 'invalid session_id (UUID/thread id characters only)' });
      if (sessionId && provider !== 'claude-code-subagent/magpie') {
        const kind = provider.startsWith('codex') ? 'codex' : 'claude';
        if (!findSession(kind, sessionId)) {
          return json(res, 400, { error: `未在本机 ${kind} 会话索引中找到该 ID；请从列表选择，或留空新建会话` });
        }
      }
      const existing = store.participant(id);
      if (existing) {
        // Re-invite updates the bound session instead of silently keeping an
        // old one. The native session itself is never modified.
        const fields = { status: PARTICIPANT.IDLE, last_error: null };
        if (b.session_id !== undefined) fields.session_id = sessionId;
        const part = store.updateParticipant(id, fields);
        store.event('participant_updated', { id, provider, session_id: part.session_id });
        broadcast({ type: 'participant', participant: part });
        return json(res, 200, { participant: part, updated: true });
      }
      const part = store.ensureParticipant({ id, label: b.label || id, provider, role: b.role || '参会者', model: b.model || null, session_id: sessionId });
      store.event('participant_joined', { id, provider });
      broadcast({ type: 'participant', participant: part });
      return json(res, 200, { participant: part });
    }
    if (req.method === 'POST' && /^\/api\/participants\/[^/]+\/(disable|enable)$/.test(p)) {
      const a = requireHuman(req, res, url); if (!a) return;
      if (store.room().state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      const [, pid, action] = p.match(/^\/api\/participants\/([^/]+)\/(disable|enable)$/);
      if (pid === 'human') return json(res, 400, { error: 'cannot disable the human' });
      const part = store.participant(pid);
      if (!part) return json(res, 404, { error: 'participant not found' });
      const disabled = action === 'disable';
      if (disabled) dispatcher.stopParticipant(pid, 'participant disabled');
      const out = store.updateParticipant(pid, { disabled, status: disabled ? PARTICIPANT.DISABLED : PARTICIPANT.IDLE, last_error: null });
      store.event('participant_disabled', { id: pid, disabled });
      broadcast({ type: 'participant', participant: out });
      return json(res, 200, { participant: out });
    }
    if (req.method === 'POST' && p === '/api/messages') {
      const a = requireHuman(req, res, url); if (!a) return;
      const room = store.room();
      if (room.state === ROOM.ENDED) return json(res, 410, { error: 'meeting ended' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const content = String(b.content || '').trim();
      if (!content) return json(res, 400, { content: 'content required', error: 'content required' });
      const mode = ['single', 'all', 'panel'].includes(b.mode) ? b.mode : 'single';
      if (b.mode !== undefined && !['single', 'all', 'panel'].includes(b.mode)) return json(res, 400, { error: 'mode must be single|all|panel' });
      const target = b.target ? String(b.target).trim() : null;
      if (target) {
        const tp = store.participant(target);
        if (!tp || tp.provider === 'human' || tp.disabled) return json(res, 400, { error: 'target must be an enabled invited agent' });
      }
      const out = store.addMessage({
        sender: 'human', sender_label: '人类决策者', provider: 'human', role: '决策者',
        kind: 'chat', content, client_id: b.client_id || null, meta: { source: b.source || 'text' },
      });
      let job = null;
      if (!out.duplicate) {
        broadcast({ type: 'message', message: out.message });
        job = dispatcher.enqueueRound({ mode, humanSeq: out.message.seq, target });
      }
      return json(res, 200, {
        message: out.message, duplicate: out.duplicate, mode, target,
        queued: room.state === ROOM.PAUSED, job_id: job ? job.id : null,
      });
    }
    if (req.method === 'POST' && p === '/api/control') {
      const a = requireHuman(req, res, url); if (!a) return;
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const room = store.room();
      if (b.action === 'end') {
        if (room.state !== ROOM.ENDED) {
          dispatcher.stop('end');
          store.transitionRoom('end');
          dispatcher.cancelAll('meeting ended');
          abortActive();
          // Let the abort unwind before the client can create the next meeting,
          // so a finished round cannot post into the new room.
          for (let i = 0; i < 60 && dispatcher.status().running; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          closeSse();
        }
        store.event('control', { action: 'end' });
        return json(res, 200, store.room());
      }
      if (room.state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      if (b.action === 'pause') {
        if (room.state !== ROOM.PAUSED) {
          store.transitionRoom('pause');
          dispatcher.stop('pause');
          store.event('control', { action: 'pause' });
          broadcast({ type: 'room', room: store.room() });
        }
        return json(res, 200, store.room());
      }
      if (b.action === 'resume') {
        if (room.state !== ROOM.PAUSED) return json(res, 409, { error: 'room is not paused' });
        store.transitionRoom('resume');
        store.event('control', { action: 'resume' });
        broadcast({ type: 'room', room: store.room() });
        dispatcher.resume();
        return json(res, 200, store.room());
      }
      return json(res, 400, { error: 'unknown action' });
    }
    if (req.method === 'POST' && p === '/api/approvals') {
      const a = requireHuman(req, res, url); if (!a) return;
      if (store.room().state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const file = resolveSandbox(b.scope);
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: 'scope must be an existing file under sandbox/' });
      const baseline = b.baseline_sha256 || sha256File(file);
      if (baseline !== sha256File(file)) return json(res, 409, { error: 'baseline mismatch' });
      let created;
      try { created = store.addApproval({ task_id: b.task_id, scope: b.scope, baseline_sha256: baseline, ttl_ms: b.ttl_ms, note: b.note || '' }); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      if (created.conflict) return json(res, 409, { error: 'task already has an active approval', approval_id: created.id });
      store.event('approval_created', created.approval);
      return json(res, 200, created);
    }
    if (req.method === 'POST' && p.match(/^\/api\/approvals\/[^/]+\/revoke$/)) {
      const a = requireHuman(req, res, url); if (!a) return;
      if (store.room().state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      const apId = p.split('/')[3];
      const ap = store.approval(apId);
      if (!ap) return json(res, 404, { error: 'not found' });
      try {
        const out = store.transitionApproval(apId, 'revoke');
        store.event('approval_revoked', out);
        broadcast({ type: 'approval', approval: out });
        return json(res, 200, { approval: out });
      } catch (e) { return json(res, 409, { error: String(e.message || e), approval: store.approval(apId) }); }
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const a = requireHuman(req, res, url); if (!a) return;
      const room = store.room();
      if (room.state === ROOM.ENDED) return json(res, 409, { error: 'meeting ended' });
      if (room.state === ROOM.PAUSED) return json(res, 409, { error: 'room is paused; resume before running a task' });
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      if (!String(b.task_id || '').trim()) return json(res, 400, { error: 'task_id required' });
      if (!String(b.instruction || '').trim()) return json(res, 400, { error: 'instruction required' });
      const file = resolveSandbox(b.scope);
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: 'scope must be an existing file under sandbox/' });
      const ap = store.approval(b.approval_id);
      if (!ap) return json(res, 404, { error: 'approval not found' });
      if (ap.status !== APPROVAL.ACTIVE) return json(res, 409, { error: 'approval not active', status: ap.status, approval: ap });
      if (ap.task_id !== b.task_id) return json(res, 409, { error: 'approval task_id mismatch' });
      if (ap.scope !== b.scope) return json(res, 409, { error: 'approval scope mismatch' });
      const currentSha = sha256File(file);
      if (currentSha !== ap.baseline_sha256) {
        store.transitionApproval(ap.id, 'invalidate', { error: 'baseline changed' });
        return json(res, 409, { error: 'baseline changed; approval invalidated', approval: store.approval(ap.id) });
      }
      const participantId = b.participant_id;
      const participant = store.participant(participantId);
      if (!participant || participant.provider === 'human') return json(res, 400, { error: 'participant must be an invited agent' });
      if (participant.disabled) return json(res, 409, { error: 'participant is disabled' });
      if (!['codex-cli/openai', 'claude-code-cli/magpie', 'claude-code-subagent/magpie', 'mock'].includes(participant.provider)) return json(res, 400, { error: 'unsupported provider' });
      try {
        const created = store.createTaskAndConsume({
          approval_id: ap.id, task_id: b.task_id, participant_id: participantId,
          scope: b.scope, instruction: String(b.instruction || ''), baseline_sha256: currentSha,
        });
        dispatcher.kick().catch((e) => store.event('worker_error', { error: String(e.stack || e) }));
        broadcast({ type: 'task', task: created.task });
        return json(res, 202, { approval: created.approval, task: created.task, running: true });
      } catch (e) {
        return json(res, e.status || 500, { error: String(e.message || e), approval: e.approval || store.approval(ap.id) });
      }
    }
    if (req.method === 'POST' && p === '/api/tts') {
      const a = requireHuman(req, res, url); if (!a) return;
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'text required' });
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      const out = path.join(TTS_DIR, `tts-${hash}.wav`);
      const txt = path.join(TMP_DIR, `tts-${hash}-${crypto.randomBytes(3).toString('hex')}.txt`);
      if (!fs.existsSync(out)) {
        const controller = track(new AbortController());
        try {
          // One writer per text hash: concurrent clicks await the same render.
          let pending = TTS_LOCKS.get(hash);
          if (!pending) {
            pending = (async () => {
              fs.writeFileSync(txt, text, 'utf8');
              try {
                const r = await runPowerShell('tts.ps1', ['-TextFile', txt, '-OutFile', out, '-Voice', b.voice || 'Microsoft Huihui Desktop'], 180000, controller.signal);
                return r;
              } finally {
                try { fs.unlinkSync(txt); } catch { /* ignore */ }
                TTS_LOCKS.delete(hash);
              }
            })();
            TTS_LOCKS.set(hash, pending);
          }
          const r = await pending;
          if (r.aborted) return json(res, 499, { error: 'cancelled' });
          if (r.code !== 0) return json(res, 500, { error: 'tts failed', detail: { code: r.code, stderr: r.stderr.slice(-400) } });
        } finally { untrack(controller); }
      }
      return json(res, 200, { url: `/api/tts/${path.basename(out)}` });
    }
    if (req.method === 'GET' && p.startsWith('/api/tts/')) {
      const a = authOf(req, url); if (!a) return json(res, 401, { error: 'token required' });
      const f = path.join(TTS_DIR, path.basename(p));
      if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': data.length, 'cache-control': 'no-store' });
      return res.end(data);
    }
    if (req.method === 'POST' && p === '/api/stt') {
      const a = requireHuman(req, res, url); if (!a) return;
      const raw = await readBody(req);
      if (!raw.length) return json(res, 400, { error: 'audio body required' });
      const base = 'stt-' + crypto.randomBytes(8).toString('hex');
      const wav = path.join(TMP_DIR, base + '.wav');
      const txt = path.join(TMP_DIR, base + '.txt');
      const controller = track(new AbortController());
      let finished = false;
      req.on('close', () => { if (!finished) controller.abort(); });
      fs.writeFileSync(wav, raw);
      try {
        let text = '';
        let engine = 'sapi-zh-CN';
        if (process.env.R2_ASR_CMD) {
          engine = 'custom';
          let extra = [];
          try { extra = process.env.R2_ASR_ARGS ? JSON.parse(process.env.R2_ASR_ARGS) : []; } catch { return json(res, 500, { error: 'R2_ASR_ARGS must be a JSON array' }); }
          if (!Array.isArray(extra)) return json(res, 500, { error: 'R2_ASR_ARGS must be a JSON array' });
          const r = await new Promise((resolve) => {
            execFile(process.env.R2_ASR_CMD, [...extra, wav], { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal: controller.signal },
              (err, stdout) => resolve({ code: err ? 1 : 0, aborted: !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')), stdout: String(stdout || '') }));
          });
          if (r.aborted) return json(res, 499, { error: 'cancelled' });
          if (r.code !== 0) return json(res, 500, { error: 'custom ASR failed' });
          text = r.stdout.trim();
        } else {
          const r = await runPowerShell('stt.ps1', ['-WavFile', wav, '-OutFile', txt], 180000, controller.signal);
          if (r.aborted) return json(res, 499, { error: 'cancelled' });
          if (r.code !== 0) return json(res, 500, { error: 'stt failed', detail: { code: r.code, stderr: r.stderr.slice(-400) } });
          text = fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').replace(/^﻿/, '').trim() : '';
        }
        return json(res, 200, { text, engine, warning: engine === 'sapi-zh-CN' ? 'SAPI 中文混英识别不可靠；请核对原转写后再发送。' : '' });
      } finally {
        finished = true;
        untrack(controller);
        for (const f of [wav, txt]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    store.event('server_error', { error: String(e.stack || e) });
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  store.event('server_start', { port: PORT, schema_version: SCHEMA_VERSION, room: store.room().state });
  dispatcher.start();
  console.log(`R2_READY http://127.0.0.1:${PORT} token_file=${TOKEN_FILE} state=${store.room().state}`);
});

process.on('SIGINT', () => { try { dispatcher.stop('shutdown'); abortActive(); } catch { /* ignore */ } process.exit(0); });
process.on('SIGTERM', () => { try { dispatcher.stop('shutdown'); abortActive(); } catch { /* ignore */ } process.exit(0); });
