'use strict';
/* Browser-level state tests with Playwright. Requires PLAYWRIGHT_PATH. */
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8835';
const TOKEN = process.env.R2_TOKEN || 'uitest';
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)}`); }
async function api(p, { method = 'GET', body } = {}) {
  const headers = { authorization: 'Bearer ' + TOKEN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  const queuedText = 'UI_QUEUE_' + Date.now();
  await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  await api('/api/messages', { method: 'POST', body: { content: queuedText, mode: 'single' } });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/#token=' + encodeURIComponent(TOKEN), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roomState');
  await page.waitForTimeout(800);
  check('room state is paused', (await page.textContent('#roomState')).includes('paused'), await page.textContent('#roomState'));
  check('worker pill exists', (await page.textContent('#workerState')).includes('worker'), await page.textContent('#workerState'));
  check('queued message rendered', (await page.textContent('#messages')).includes(queuedText));
  check('no page errors on load', errors.length === 0, errors);

  await page.click('#resume');
  await page.waitForFunction(() => document.querySelector('#messages').innerText.includes('没有可用参会者'), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#roomState').textContent.includes('live'), null, { timeout: 8000 }).catch(() => {});
  check('resume drains queued job', (await page.textContent('#messages')).includes('没有可用参会者'));
  check('room live after resume', (await page.textContent('#roomState')).includes('live'), await page.textContent('#roomState'));

  // Invite + disable/enable through UI.
  await api('/api/invite', { method: 'POST', body: { id: 'codex', label: 'Codex', provider: 'codex-cli/openai', role: 'r' } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const toggle = page.locator('button[data-person="codex"]');
  check('participant toggle rendered', await toggle.count() === 1);
  await toggle.click();
  await page.waitForTimeout(500);
  let st = await api('/api/state');
  check('UI disable works', st.json.participants.find((p) => p.id === 'codex').disabled === true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.locator('button[data-person="codex"]').click();
  await page.waitForTimeout(500);
  st = await api('/api/state');
  check('UI enable works', st.json.participants.find((p) => p.id === 'codex').disabled === false);

  // Approval revoke button.
  const files = await api('/api/files');
  const allowed = files.json.files.find((f) => f.path === 'sandbox/allowed.md');
  const ap = await api('/api/approvals', { method: 'POST', body: { task_id: 'ui-revoke', scope: 'sandbox/allowed.md', baseline_sha256: allowed.sha256, ttl_ms: 60000 } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  check('approval active visible', (await page.textContent('#approvals')).includes('ui-revoke'), await page.textContent('#approvals'));
  const revoke = page.locator('button[data-revoke]').first();
  check('revoke button rendered', await revoke.count() === 1);
  await revoke.click();
  await page.waitForTimeout(500);
  check('UI revoke works', (await page.textContent('#approvals')).includes('revoked'), await page.textContent('#approvals'));

  // Failed /api/tasks must auto-revoke the newly created approval.
  await page.route('**/api/tasks', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"injected failure"}' }));
  await page.fill('#taskId', 'ui-orphan');
  await page.click('#taskRun');
  await page.waitForTimeout(800);
  const stAfter = await api('/api/state');
  const orphan = stAfter.json.approvals.find((a) => a.task_id === 'ui-orphan');
  check('failed task auto-revokes approval', !!orphan && orphan.status === 'revoked', orphan);
  await page.unroute('**/api/tasks');

  check('no page errors after interactions', errors.length === 0, errors);
  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
