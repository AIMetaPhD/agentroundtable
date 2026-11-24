'use strict';
/* Browser reconnect gap test. Requires PLAYWRIGHT_PATH. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8835';
const TOKEN = process.env.R2_TOKEN || 'uitest';
async function api(p, { method = 'GET', body } = {}) {
  const headers = { authorization: 'Bearer ' + TOKEN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  await api('/api/control', { method: 'POST', body: { action: 'pause' } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + '/#token=' + encodeURIComponent(TOKEN), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roomState');
  await page.waitForTimeout(600);
  const text = 'OFFLINE_GAP_' + Date.now();
  await context.setOffline(true);
  await page.waitForTimeout(1500);
  const posted = await api('/api/messages', { method: 'POST', body: { content: text, mode: 'single' } });
  const offlineStatus = await page.textContent('#status');
  await context.setOffline(false);
  let seen = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    if ((await page.textContent('#messages')).includes(text)) { seen = true; break; }
  }
  const lastSeq = await page.textContent('#lastSeq');
  const all = await page.textContent('#messages');
  console.log(JSON.stringify({ posted: posted.status, queued: posted.json && posted.json.queued, offlineStatus, seen, lastSeq, hasText: all.includes(text) }));
  await browser.close();
  process.exit(seen ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
