'use strict';
/*
 * Read-only discovery of existing native sessions.
 *
 * Codex:   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Claude:  $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * Only metadata and a short title are read. Session files are never modified,
 * and no credential or config file is opened.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEAD_BYTES = 256 * 1024;
const MAX_FILES = 800;
const ACTIVE_LOCK_MS = 24 * 60 * 60 * 1000;

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function cleanTitle(text) {
  let t = String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) return null;
  if (/^#\s*AGENTS\.md/i.test(t)) return null;
  if (/^(Caveat:|This session is being continued)/i.test(t)) return null;
  return t.slice(0, 120);
}

function userTextFromCodex(o) {
  const p = o && o.payload;
  if (!p) return null;
  if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
    if (typeof p.content === 'string') return cleanTitle(p.content);
    if (Array.isArray(p.content)) {
      const t = p.content.filter((c) => c && (c.type === 'input_text' || c.type === 'text')).map((c) => c.text).join(' ');
      return cleanTitle(t);
    }
  }
  if (o.type === 'event_msg' && p.type === 'user_message') return cleanTitle(p.message);
  return null;
}

function parseCodex(file) {
  let id = null; let cwd = null; let title = null; let ts = null;
  let text = '';
  try { text = readHead(file); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta' && o.payload) {
      id = o.payload.id || o.payload.session_id || id;
      cwd = o.payload.cwd || cwd;
      ts = o.payload.timestamp || o.timestamp || ts;
    }
    if (!title) title = userTextFromCodex(o);
  }
  if (!id) {
    const m = path.basename(file).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
    if (m) id = m[1];
  }
  return id ? { id, cwd, title, ts } : null;
}

function parseClaude(file) {
  const id = path.basename(file, '.jsonl');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  let title = null; let cwd = null; let ts = null;
  let text = '';
  try { text = readHead(file); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle && !title) title = cleanTitle(o.customTitle);
    if (!title && o.type === 'user' && o.message) {
      const c = o.message.content;
      const t = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
      title = cleanTitle(t);
    }
    if (o.cwd) cwd = o.cwd;
    if (o.timestamp) ts = o.timestamp;
  }
  return { id, cwd, title, ts };
}

function walkCodex(dir, out, depth = 0) {
  if (depth > 5 || out.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkCodex(fp, out, depth + 1);
    else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) out.push(fp);
  }
}

function listCodex(limit) {
  const root = path.join(codexHome(), 'sessions');
  if (!fs.existsSync(root)) return [];
  const locks = new Map();
  const locksDir = path.join(codexHome(), 'thread-writer-locks');
  try {
    for (const name of fs.readdirSync(locksDir)) {
      const m = name.match(/^([0-9a-f-]{36})\.lock$/i);
      if (m) { try { locks.set(m[1].toLowerCase(), fs.statSync(path.join(locksDir, name)).mtimeMs); } catch { /* ignore */ } }
    }
  } catch { /* no lock directory */ }
  const files = [];
  walkCodex(root, files);
  const stat = files.map((f) => { try { const s = fs.statSync(f); return { f, mtime: s.mtimeMs, size: s.size }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const seen = new Set();
  for (const { f, mtime, size } of stat) {
    if (out.length >= limit) break;
    const p = parseCodex(f);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    // A live "current" session cannot be resumed from this app: Codex's
    // thread store rejects a second writer. Mark it read-only so the UI does
    // not hand the human a guaranteed failure.
    const lockAt = locks.get(String(p.id).toLowerCase());
    const active = lockAt !== undefined && Math.abs(mtime - lockAt) < ACTIVE_LOCK_MS;
    out.push({ id: p.id, provider: 'codex', title: p.title || '(未命名会话)', cwd: p.cwd || null, updated_at: new Date(mtime).toISOString(), size, active });
  }
  return out;
}

function listClaude(limit) {
  const root = path.join(claudeHome(), 'projects');
  if (!fs.existsSync(root)) return [];
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && /^[0-9a-f-]{36}\.jsonl$/i.test(e.name)) files.push(path.join(dir, e.name));
    }
  }
  const stat = files.map((f) => { try { const s = fs.statSync(f); return { f, mtime: s.mtimeMs, size: s.size }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  const out = [];
  for (const { f, mtime, size } of stat) {
    const p = parseClaude(f);
    if (!p) continue;
    out.push({ id: p.id, provider: 'claude', title: p.title || '(未命名会话)', cwd: p.cwd || null, updated_at: new Date(mtime).toISOString(), size });
  }
  return out;
}

function findSession(provider, id) {
  if (!id) return null;
  const list = listSessions(provider, { limit: 1000 });
  return list.find((s) => s.id === id) || null;
}

function listSessions(provider, { limit = 25 } = {}) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 25));
  if (provider === 'codex') return listCodex(n);
  if (provider === 'claude') return listClaude(n);
  return [];
}

module.exports = { listSessions, findSession, codexHome, claudeHome };
