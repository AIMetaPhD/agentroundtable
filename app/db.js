'use strict';
/*
 * SQLite store for the local meeting app (node:sqlite, Node >= 22).
 *
 * Schema v2 makes previously implicit state explicit:
 *   room.state, participants.disabled, approvals.expires_at, tasks, jobs.
 * Legacy databases are migrated in place; nothing is dropped.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  ROOM, PARTICIPANT, APPROVAL, TASK, JOB, MESSAGE,
  roomFromRow, nextRoom, nextApproval, nextTask, nextJob,
} = require('./state');

const MAIN_ROOM = 'main';
const SCHEMA_VERSION = 3;
const DEFAULT_APPROVAL_TTL_MS = Number(process.env.R2_APPROVAL_TTL_MS || 15 * 60 * 1000);

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return prefix + crypto.randomBytes(6).toString('hex'); }

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'roundtable.db');
    this.sharedDir = path.join(dataDir, 'shared');
    this.sandboxDir = path.join(dataDir, 'sandbox');
    this.roomId = MAIN_ROOM;
    this.applyRoomPaths();
    fs.mkdirSync(path.dirname(this.sharedPath), { recursive: true });
    fs.mkdirSync(this.sandboxDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS room (
        id TEXT PRIMARY KEY, name TEXT, objective TEXT, paused INTEGER DEFAULT 0,
        ended INTEGER DEFAULT 0, state TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT, room_id TEXT, label TEXT, provider TEXT, role TEXT,
        session_id TEXT, model TEXT, status TEXT DEFAULT 'idle', last_error TEXT,
        disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT,
        PRIMARY KEY(room_id, id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, seq INTEGER,
        sender TEXT, sender_label TEXT, provider TEXT, role TEXT, kind TEXT,
        content TEXT, status TEXT, client_id TEXT UNIQUE, meta TEXT, ts TEXT, updated_at TEXT,
        round_id TEXT, round_hop INTEGER,
        UNIQUE(room_id, seq)
      );
      CREATE TABLE IF NOT EXISTS cursors (
        room_id TEXT, participant_id TEXT, last_seq INTEGER DEFAULT 0,
        PRIMARY KEY(room_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, room_id TEXT, task_id TEXT, scope TEXT,
        baseline_sha256 TEXT, steps_allowed INTEGER, steps_used INTEGER DEFAULT 0,
        status TEXT, note TEXT, created_at TEXT, consumed_at TEXT,
        expires_at TEXT, last_error TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, room_id TEXT, task_id TEXT, approval_id TEXT,
        participant_id TEXT, scope TEXT, instruction TEXT, state TEXT,
        message_id INTEGER, error TEXT, cancel_requested INTEGER DEFAULT 0,
        created_at TEXT, started_at TEXT, finished_at TEXT, meta TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, room_id TEXT, kind TEXT, state TEXT, payload TEXT,
        error TEXT, created_at TEXT, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, ts TEXT, type TEXT, data TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(room_id, state, id);
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(room_id, state, id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(room_id, status);
    `);
    this.migrate();
    this.seed();
    const saved = this.getSetting('active_room');
    if (saved && this.roomById(saved)) this.roomId = saved;
    this.applyRoomPaths();
    this.recover();
  }

  migrate() {
    const cols = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const ensure = (table, name, def) => {
      if (!cols(table).includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    };
    ensure('room', 'state', 'TEXT');
    ensure('room', 'updated_at', 'TEXT');
    ensure('participants', 'disabled', 'INTEGER DEFAULT 0');
    ensure('participants', 'updated_at', 'TEXT');
    ensure('messages', 'updated_at', 'TEXT');
    ensure('messages', 'round_id', 'TEXT');
    ensure('messages', 'round_hop', 'INTEGER');
    ensure('approvals', 'expires_at', 'TEXT');
    ensure('approvals', 'last_error', 'TEXT');
    ensure('approvals', 'updated_at', 'TEXT');
    // v3: participants are keyed by (room_id, id) so two meetings can each
    // have their own "codex"/"claude" without overwriting each other.
    const partSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='participants'").get();
    if (partSql && !/PRIMARY KEY\s*\(\s*room_id/i.test(partSql.sql)) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE participants_v3 (
          id TEXT, room_id TEXT, label TEXT, provider TEXT, role TEXT,
          session_id TEXT, model TEXT, status TEXT DEFAULT 'idle', last_error TEXT,
          disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT,
          PRIMARY KEY(room_id, id)
        );
        INSERT OR IGNORE INTO participants_v3
          SELECT id, COALESCE(room_id, '${MAIN_ROOM}'), label, provider, role, session_id, model,
                 status, last_error, COALESCE(disabled, 0), created_at, updated_at FROM participants;
        DROP TABLE participants;
        ALTER TABLE participants_v3 RENAME TO participants;
        COMMIT;
      `);
    }
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version || 0);
    if (version < SCHEMA_VERSION) {
      this.db.exec(`
        UPDATE room SET state = CASE
          WHEN ended = 1 THEN '${ROOM.ENDED}'
          WHEN paused = 1 THEN '${ROOM.PAUSED}'
          ELSE '${ROOM.ACTIVE}' END
        WHERE state IS NULL OR state = '';
        UPDATE room SET updated_at = COALESCE(updated_at, created_at, '${nowIso()}');
        UPDATE participants SET room_id = COALESCE(room_id, '${MAIN_ROOM}');
        UPDATE participants SET disabled = COALESCE(disabled, 0);
        UPDATE participants SET updated_at = COALESCE(updated_at, created_at);
        UPDATE messages SET updated_at = COALESCE(updated_at, ts);
        UPDATE approvals SET updated_at = COALESCE(updated_at, created_at);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
  }

  seed() {
    const room = this.db.prepare('SELECT id FROM room WHERE id = ?').get(this.roomId);
    if (!room) {
      this.db.prepare('INSERT INTO room(id,name,objective,state,paused,ended,created_at,updated_at) VALUES (?,?,?,?,0,0,?,?)')
        .run(this.roomId, 'Agent Roundtable', '多 Agent 可靠性评审：讨论、质疑、由人类批准后执行受限任务。', ROOM.ACTIVE, nowIso(), nowIso());
    }
    if (!fs.existsSync(this.sharedPath)) {
      fs.writeFileSync(this.sharedPath, '# Shared discussion file\n\nVersion: draft-1\n', 'utf8');
    }
    const allowed = path.join(this.sandboxDir, 'allowed.md');
    const protectedFile = path.join(this.sandboxDir, 'protected.txt');
    if (!fs.existsSync(allowed)) {
      fs.writeFileSync(allowed, '# Approved task target\nline1: baseline\nline2: baseline\n', 'utf8');
    }
    if (!fs.existsSync(protectedFile)) {
      fs.writeFileSync(protectedFile, 'PROTECTED BASELINE — must not change without approval.\n', 'utf8');
    }
    this.ensureParticipant({ id: 'human', label: '人类决策者', provider: 'human', role: '决策者' });
  }

  /* ---------- rooms / settings ---------- */

  applyRoomPaths() {
    const roomsDir = path.join(this.sharedDir, 'rooms');
    if (this.roomId === MAIN_ROOM) {
      this.sharedPath = path.join(this.sharedDir, 'DISCUSSION.md');
      this.sharedSourcePath = path.join(this.sharedDir, 'SOURCE.json');
    } else {
      this.sharedPath = path.join(roomsDir, this.roomId + '.md');
      this.sharedSourcePath = path.join(roomsDir, this.roomId + '.SOURCE.json');
    }
    fs.mkdirSync(path.dirname(this.sharedPath), { recursive: true });
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, String(value), nowIso());
  }

  roomById(roomId) {
    const r = this.db.prepare('SELECT * FROM room WHERE id = ?').get(roomId);
    if (!r) return null;
    const state = roomFromRow(r);
    return { ...r, state, paused: state === ROOM.PAUSED, ended: state === ROOM.ENDED };
  }

  rooms() {
    return this.db.prepare(`SELECT r.*,
        (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS message_count,
        (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id AND p.provider <> 'human') AS agent_count
      FROM room r ORDER BY r.created_at DESC, r.rowid DESC`).all()
      .map((r) => {
        const state = roomFromRow(r);
        return { ...r, state, paused: state === ROOM.PAUSED, ended: state === ROOM.ENDED };
      });
  }

  useRoom(roomId) {
    const room = this.roomById(roomId);
    if (!room) throw Object.assign(new Error('room not found'), { status: 404 });
    this.roomId = roomId;
    this.setSetting('active_room', roomId);
    this.applyRoomPaths();
    return room;
  }

  createRoom({ name, objective } = {}) {
    if (this.rooms().some((r) => r.state !== ROOM.ENDED)) {
      throw Object.assign(new Error('an unfinished meeting exists; end it first'), { status: 409 });
    }
    const roomId = 'r' + crypto.randomBytes(5).toString('hex');
    const ts = nowIso();
    const title = String(name || '').trim() || ('会议 ' + new Date(ts).toLocaleString('zh-CN'));
    this.db.prepare('INSERT INTO room(id,name,objective,state,paused,ended,created_at,updated_at) VALUES (?,?,?,?,0,0,?,?)')
      .run(roomId, title, String(objective || '').trim() || '多 Agent 讨论：共享项目文件、由人类决定是否执行。', ROOM.ACTIVE, ts, ts);
    this.useRoom(roomId);
    fs.writeFileSync(this.sharedPath, '# Shared discussion file\n\nVersion: draft-1\n', 'utf8');
    this.ensureParticipant({ id: 'human', label: '人类决策者', provider: 'human', role: '决策者' });
    this.event('room_created', { name: title });
    return this.room();
  }

  /*
   * Startup reconciliation: no state may remain "running/processing" merely
   * because the previous process died. Round jobs are safe to retry; task
   * jobs are not (a killed write may be partial), so they become orphaned.
   */
  recover() {
    const ts = nowIso();
    const runningJobs = this.db.prepare('SELECT * FROM jobs WHERE state = ?').all(JOB.RUNNING);
    for (const job of runningJobs) {
      if (job.kind === 'round') {
        // A round from an ended meeting must never resume into a new meeting.
        const room = this.roomById(job.room_id);
        const canResume = room && room.state !== ROOM.ENDED;
        this.db.prepare('UPDATE jobs SET state = ?, started_at = NULL, error = ?, finished_at = ? WHERE id = ?')
          .run(canResume ? JOB.QUEUED : JOB.CANCELLED, canResume ? 'server restarted; round will resume' : 'meeting ended',
            canResume ? null : ts, job.id);
      } else {
        this.db.prepare('UPDATE jobs SET state = ?, finished_at = ?, error = ? WHERE id = ?')
          .run(JOB.INTERRUPTED, ts, 'server restarted during task', job.id);
      }
    }
    this.db.prepare("UPDATE jobs SET state = ?, finished_at = ?, error = ? WHERE kind = 'task' AND state IN (?, ?)")
      .run(JOB.CANCELLED, ts, 'server restarted during task', JOB.QUEUED, JOB.RUNNING);
    this.db.prepare('UPDATE tasks SET state = ?, finished_at = ?, error = ? WHERE state IN (?, ?)')
      .run(TASK.ORPHANED, ts, 'server restarted', TASK.QUEUED, TASK.RUNNING);
    this.db.prepare('UPDATE participants SET status = ?, last_error = ?, updated_at = ? WHERE status = ?')
      .run(PARTICIPANT.UNKNOWN, 'server restarted while processing', ts, PARTICIPANT.PROCESSING);
    this.expireApprovals();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  room() {
    const r = this.db.prepare('SELECT * FROM room WHERE id = ?').get(this.roomId);
    const state = roomFromRow(r);
    return { ...r, state, paused: state === ROOM.PAUSED, ended: state === ROOM.ENDED };
  }

  transitionRoom(event) {
    return this.tx(() => {
      const r = this.room();
      const next = nextRoom(r.state, event);
      this.db.prepare('UPDATE room SET state = ?, paused = ?, ended = ?, updated_at = ? WHERE id = ?')
        .run(next, next === ROOM.PAUSED ? 1 : 0, next === ROOM.ENDED ? 1 : 0, nowIso(), this.roomId);
      return this.room();
    });
  }

  // Compatibility wrapper for older call sites/tests.
  setRoom({ paused, ended }) {
    if (ended) return this.transitionRoom('end');
    const cur = this.room().state;
    if (paused === true && cur === ROOM.ACTIVE) return this.transitionRoom('pause');
    if (paused === false && cur === ROOM.PAUSED) return this.transitionRoom('resume');
    return this.room();
  }

  participants() {
    // created_at has millisecond resolution; rowid preserves invite order when
    // two participants are inserted in the same millisecond.
    return this.db.prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY created_at, rowid').all(this.roomId)
      .map((p) => ({ ...p, disabled: !!p.disabled }));
  }

  participant(participantId) {
    const p = this.db.prepare('SELECT * FROM participants WHERE id = ? AND room_id = ?').get(participantId, this.roomId);
    return p ? { ...p, disabled: !!p.disabled } : p;
  }

  ensureParticipant({ id: participantId, label, provider, role, session_id = null, model = null }) {
    const p = this.participant(participantId);
    if (p) {
      if (label) this.db.prepare('UPDATE participants SET label = ?, updated_at = ? WHERE id = ? AND room_id = ?').run(label, nowIso(), participantId, this.roomId);
      return this.participant(participantId);
    }
    this.db.prepare('INSERT INTO participants(id,room_id,label,provider,role,session_id,model,status,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)')
      .run(participantId, this.roomId, label, provider, role, session_id, model, PARTICIPANT.IDLE, nowIso(), nowIso());
    return this.participant(participantId);
  }

  updateParticipant(participantId, fields) {
    const allowed = ['session_id', 'status', 'last_error', 'model', 'disabled'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.participant(participantId);
    if (fields.status && !Object.values(PARTICIPANT).includes(fields.status)) {
      throw new Error('invalid participant status: ' + fields.status);
    }
    const vals = keys.map((k) => k === 'disabled' ? (fields[k] ? 1 : 0) : fields[k]);
    this.db.prepare('UPDATE participants SET ' + keys.map((k) => `${k} = ?`).join(', ') + ', updated_at = ? WHERE id = ? AND room_id = ?')
      .run(...vals, nowIso(), participantId, this.roomId);
    return this.participant(participantId);
  }

  nextSeq() {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages WHERE room_id = ?').get(this.roomId);
    return Number(row.m) + 1;
  }

  addMessage({ sender, sender_label, provider, role, kind = 'chat', content, status = MESSAGE.COMPLETE, client_id = null, meta = {}, round_id = null, round_hop = null }) {
    if (client_id) {
      const existing = this.db.prepare('SELECT * FROM messages WHERE client_id = ?').get(client_id);
      if (existing) return { duplicate: true, message: this.hydrate(existing) };
    }
    const seq = this.nextSeq();
    const ts = nowIso();
    const info = this.db.prepare(`INSERT INTO messages(room_id,seq,sender,sender_label,provider,role,kind,content,status,client_id,meta,ts,updated_at,round_id,round_hop)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(this.roomId, seq, sender, sender_label || sender, provider || 'unknown', role || 'participant',
        kind, content, status, client_id, JSON.stringify(meta || {}), ts, ts, round_id, round_hop);
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
    return { duplicate: false, message: this.hydrate(row) };
  }

  roundMessage(roundId, hop, sender) {
    const row = this.db.prepare('SELECT * FROM messages WHERE room_id = ? AND round_id = ? AND round_hop = ? AND sender = ? AND status = ? ORDER BY seq DESC LIMIT 1')
      .get(this.roomId, roundId, hop, sender, MESSAGE.COMPLETE);
    return this.hydrate(row);
  }

  updateMessage(messageId, fields) {
    const allowed = ['content', 'status', 'meta'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return null;
    const vals = keys.map((k) => k === 'meta' ? JSON.stringify(fields[k] || {}) : fields[k]);
    this.db.prepare('UPDATE messages SET ' + keys.map((k) => `${k} = ?`).join(', ') + ', updated_at = ? WHERE id = ?')
      .run(...vals, nowIso(), messageId);
    return this.hydrate(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
  }

  hydrate(row) {
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
    return { ...row, meta };
  }

  messages(since = 0) {
    return this.db.prepare('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq').all(this.roomId, since).map((r) => this.hydrate(r));
  }

  lastSeq() {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages WHERE room_id = ?').get(this.roomId);
    return Number(row.m);
  }

  cursor(participantId) {
    const row = this.db.prepare('SELECT last_seq FROM cursors WHERE room_id = ? AND participant_id = ?').get(this.roomId, participantId);
    return row ? Number(row.last_seq) : 0;
  }

  setCursor(participantId, seq) {
    this.db.prepare(`INSERT INTO cursors(room_id,participant_id,last_seq) VALUES (?,?,?)
      ON CONFLICT(room_id,participant_id) DO UPDATE SET last_seq = excluded.last_seq`).run(this.roomId, participantId, seq);
  }

  /* ---------- approvals ---------- */

  expireApprovals() {
    const now = nowIso();
    const rows = this.db.prepare('SELECT id FROM approvals WHERE room_id = ? AND status = ? AND expires_at IS NOT NULL AND expires_at <= ?')
      .all(this.roomId, APPROVAL.ACTIVE, now);
    for (const row of rows) {
      this.db.prepare('UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(APPROVAL.EXPIRED, now, row.id, APPROVAL.ACTIVE);
    }
    return rows.length;
  }

  addApproval({ task_id, scope, baseline_sha256, ttl_ms, note = '' }) {
    this.expireApprovals();
    const active = this.db.prepare('SELECT id FROM approvals WHERE room_id = ? AND task_id = ? AND status = ?')
      .get(this.roomId, task_id, APPROVAL.ACTIVE);
    if (active) return { conflict: true, id: active.id };
    const ttl = ttl_ms === undefined ? DEFAULT_APPROVAL_TTL_MS : Number(ttl_ms);
    if (!Number.isFinite(ttl) || ttl < 0) throw new Error('ttl_ms must be >= 0');
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const apId = id('ap');
    this.db.prepare(`INSERT INTO approvals(id,room_id,task_id,scope,baseline_sha256,steps_allowed,steps_used,status,note,created_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,0,?,?,?,?,?)`)
      .run(apId, this.roomId, task_id, scope, baseline_sha256, 1, APPROVAL.ACTIVE, note, nowIso(), expiresAt, nowIso());
    return { approval: this.approval(apId) };
  }

  approval(apId) {
    this.expireApprovals();
    return this.db.prepare('SELECT * FROM approvals WHERE id = ? AND room_id = ?').get(apId, this.roomId);
  }

  approvals() {
    this.expireApprovals();
    return this.db.prepare('SELECT * FROM approvals WHERE room_id = ? ORDER BY created_at DESC').all(this.roomId);
  }

  transitionApproval(apId, event, extra = {}) {
    return this.tx(() => {
      const ap = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND room_id = ?').get(apId, this.roomId);
      if (!ap) return null;
      const next = nextApproval(ap.status, event);
      this.db.prepare('UPDATE approvals SET status = ?, consumed_at = COALESCE(?, consumed_at), last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?')
        .run(next, extra.consumed_at || null, extra.error || null, nowIso(), apId);
      return this.approval(apId);
    });
  }

  // Compatibility wrapper: status changes must go through transitionApproval.
  setApproval(apId, fields) {
    if (fields.status && fields.status !== this.approval(apId).status) throw new Error('use transitionApproval for status changes');
    const allowed = ['steps_used', 'consumed_at'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.approval(apId);
    this.db.prepare('UPDATE approvals SET ' + keys.map((k) => `${k} = ?`).join(', ') + ', updated_at = ? WHERE id = ?')
      .run(...keys.map((k) => fields[k]), nowIso(), apId);
    return this.approval(apId);
  }

  /* ---------- tasks ---------- */

  task(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND room_id = ?').get(taskId, this.roomId);
    return row ? { ...row, meta: (() => { try { return JSON.parse(row.meta || '{}'); } catch { return {}; } })() } : row;
  }

  tasks() {
    return this.db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC').all(this.roomId)
      .map((r) => ({ ...r, meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })() }));
  }

  updateTaskState(taskId, event, extra = {}) {
    return this.tx(() => {
      const t = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND room_id = ?').get(taskId, this.roomId);
      if (!t) throw new Error('task not found');
      const next = nextTask(t.state, event);
      this.db.prepare(`UPDATE tasks SET state = ?, message_id = COALESCE(?, message_id), error = COALESCE(?, error),
        started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), cancel_requested = COALESCE(?, cancel_requested)
        WHERE id = ?`)
        .run(next, extra.message_id || null, extra.error || null, extra.started_at || null, extra.finished_at || null,
          extra.cancel_requested === undefined ? null : (extra.cancel_requested ? 1 : 0), taskId);
      return this.task(taskId);
    });
  }

  /*
   * Atomically: verify approval, consume it, create task and queue job.
   * A crash between these steps is no longer possible.
   */
  createTaskAndConsume({ approval_id, task_id, participant_id, scope, instruction, baseline_sha256 }) {
    return this.tx(() => {
      this.expireApprovals();
      const ap = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND room_id = ?').get(approval_id, this.roomId);
      if (!ap) throw Object.assign(new Error('approval not found'), { status: 404 });
      if (ap.status !== APPROVAL.ACTIVE) throw Object.assign(new Error('approval not active'), { status: 409, approval: ap });
      if (ap.task_id !== task_id) throw Object.assign(new Error('approval task_id mismatch'), { status: 409 });
      if (ap.scope !== scope) throw Object.assign(new Error('approval scope mismatch'), { status: 409 });
      if (baseline_sha256 !== undefined && ap.baseline_sha256 !== baseline_sha256) throw Object.assign(new Error('baseline mismatch'), { status: 409 });
      const next = nextApproval(ap.status, 'consume');
      const ts = nowIso();
      this.db.prepare('UPDATE approvals SET status = ?, steps_used = 1, consumed_at = ?, updated_at = ? WHERE id = ?')
        .run(next, ts, ts, approval_id);
      const taskId = id('tk');
      this.db.prepare(`INSERT INTO tasks(id,room_id,task_id,approval_id,participant_id,scope,instruction,state,cancel_requested,created_at,meta)
        VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
        .run(taskId, this.roomId, task_id, approval_id, participant_id, scope, instruction, TASK.QUEUED, nowIso(), '{}');
      const jobId = id('jb');
      this.db.prepare('INSERT INTO jobs(id,room_id,kind,state,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run(jobId, this.roomId, 'task', JOB.QUEUED, JSON.stringify({ task_id: taskId }), nowIso());
      return { approval: this.approval(approval_id), task: this.task(taskId), job: this.job(jobId) };
    });
  }

  /* ---------- durable job queue ---------- */

  job(jobId) { return this.hydrateJob(this.db.prepare('SELECT * FROM jobs WHERE id = ? AND room_id = ?').get(jobId, this.roomId)); }

  hydrateJob(row) {
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { /* ignore */ }
    return { ...row, payload };
  }

  jobs() {
    return this.db.prepare('SELECT * FROM jobs WHERE room_id = ? ORDER BY created_at DESC').all(this.roomId).map((r) => this.hydrateJob(r));
  }

  addJob(kind, payload = {}) {
    const jobId = id('jb');
    this.db.prepare('INSERT INTO jobs(id,room_id,kind,state,payload,created_at) VALUES (?,?,?,?,?,?)')
      .run(jobId, this.roomId, kind, JOB.QUEUED, JSON.stringify(payload), nowIso());
    return this.job(jobId);
  }

  nextQueuedJob() {
    const row = this.db.prepare('SELECT * FROM jobs WHERE room_id = ? AND state = ? ORDER BY rowid LIMIT 1')
      .get(this.roomId, JOB.QUEUED);
    return this.hydrateJob(row);
  }

  hasQueuedJobs() {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE room_id = ? AND state = ? LIMIT 1').get(this.roomId, JOB.QUEUED);
  }

  updateJobState(jobId, event, extra = {}) {
    return this.tx(() => {
      const j = this.db.prepare('SELECT * FROM jobs WHERE id = ? AND room_id = ?').get(jobId, this.roomId);
      if (!j) throw new Error('job not found');
      const next = nextJob(j.state, event);
      this.db.prepare(`UPDATE jobs SET state = ?, error = COALESCE(?, error), payload = COALESCE(?, payload),
        started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at) WHERE id = ?`)
        .run(next, extra.error || null, extra.payload ? JSON.stringify(extra.payload) : null,
          extra.started_at || null, extra.finished_at || null, jobId);
      return this.job(jobId);
    });
  }

  updateJobPayload(jobId, payload) {
    this.db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify(payload || {}), jobId);
    return this.job(jobId);
  }

  cancelQueuedTasks(reason) {
    const ts = nowIso();
    const rows = this.db.prepare('SELECT id FROM tasks WHERE room_id = ? AND state = ?').all(this.roomId, TASK.QUEUED);
    for (const t of rows) {
      this.db.prepare('UPDATE tasks SET state = ?, error = ?, finished_at = ? WHERE id = ? AND state = ?')
        .run(TASK.CANCELLED, reason, ts, t.id, TASK.QUEUED);
    }
    return rows.length;
  }

  cancelQueuedJobs(reason) {
    const ts = nowIso();
    const jobs = this.db.prepare('SELECT id FROM jobs WHERE room_id = ? AND state = ?').all(this.roomId, JOB.QUEUED);
    for (const j of jobs) {
      this.db.prepare('UPDATE jobs SET state = ?, error = ?, finished_at = ? WHERE id = ? AND state = ?')
        .run(JOB.CANCELLED, reason, ts, j.id, JOB.QUEUED);
    }
    return jobs.length;
  }

  /* ---------- shared / files ---------- */

  event(type, data = {}) {
    this.db.prepare('INSERT INTO events(room_id,ts,type,data) VALUES (?,?,?,?)')
      .run(this.roomId, nowIso(), type, JSON.stringify(data));
  }

  shared() {
    const content = fs.readFileSync(this.sharedPath, 'utf8');
    let source = null;
    try { source = JSON.parse(fs.readFileSync(this.sharedSourcePath, 'utf8')); } catch { /* optional */ }
    return {
      path: path.relative(this.dataDir, this.sharedPath).replace(/\\/g, '/'),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      content,
      bytes: Buffer.byteLength(content),
      source_path: source && source.source_path ? source.source_path : null,
      source_sha256: source && source.source_sha256 ? source.source_sha256 : null,
      selected_at: source && source.selected_at ? source.selected_at : null,
    };
  }

  setSharedFile({ sourcePath, content, sourceSha256 }) {
    const tmp = this.sharedPath + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, this.sharedPath);
    const meta = {
      source_path: sourcePath,
      source_sha256: sourceSha256,
      snapshot_sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      selected_at: nowIso(),
    };
    fs.writeFileSync(this.sharedSourcePath, JSON.stringify(meta, null, 2), 'utf8');
    return this.shared();
  }

  sandboxFiles() {
    const out = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        const st = fs.statSync(fp);
        if (st.isDirectory()) walk(fp);
        else if (st.isFile()) out.push({
          path: 'sandbox/' + path.relative(this.sandboxDir, fp).replace(/\\/g, '/'),
          sha256: crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'),
          bytes: st.size,
        });
      }
    };
    walk(this.sandboxDir);
    return out;
  }

  state(since = 0) {
    return {
      room: this.room(),
      room_id: this.roomId,
      rooms: this.rooms().map((r) => ({
        id: r.id, name: r.name, state: r.state, created_at: r.created_at,
        message_count: r.message_count, agent_count: r.agent_count,
      })),
      participants: this.participants(),
      messages: this.messages(since),
      lastSeq: this.lastSeq(),
      approvals: this.approvals(),
      tasks: this.tasks().slice(0, 25),
      jobs: this.jobs().slice(0, 25),
      shared: (() => { const s = this.shared(); return { path: s.path, sha256: s.sha256, bytes: s.bytes }; })(),
      files: this.sandboxFiles(),
    };
  }
}

module.exports = { Store, ROOM: MAIN_ROOM, SCHEMA_VERSION, DEFAULT_APPROVAL_TTL_MS };
