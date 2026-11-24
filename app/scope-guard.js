'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function walk(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp, base, out);
    else if (st.isFile()) {
      const rel = path.relative(base, fp).replace(/\\/g, '/');
      const buf = fs.readFileSync(fp);
      out[rel] = { b64: buf.toString('base64'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    }
  }
  return out;
}
function snapshot(dir) { return walk(dir); }
function enforceScope({ before, dir, allowed }) {
  const allowedSet = new Set((allowed || []).map((p) => p.replace(/\\/g, '/')));
  const after = snapshot(dir);
  const rels = new Set([...Object.keys(before), ...Object.keys(after)]);
  const violations = [];
  const restored = [];
  for (const rel of rels) {
    if (allowedSet.has(rel)) continue;
    const b = before[rel];
    const a = after[rel];
    if (b && a && b.sha256 === a.sha256) continue;
    violations.push(rel);
    const fp = path.join(dir, rel);
    if (b) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, Buffer.from(b.b64, 'base64'));
      restored.push({ rel, action: a ? 'restored' : 'recreated' });
    } else if (a) {
      fs.rmSync(fp, { force: true });
      restored.push({ rel, action: 'deleted_new_file' });
    }
  }
  const prune = (d) => {
    if (!fs.existsSync(d) || d === dir) return;
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      if (fs.statSync(fp).isDirectory()) prune(fp);
    }
    if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  };
  prune(dir);
  return { violations, restored, after: snapshot(dir) };
}
module.exports = { snapshot, enforceScope, walk };
