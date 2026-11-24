'use strict';
/* Chinese IME safety check: plain Enter must not send; Ctrl+Enter must send. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8821';
const TOKEN = process.env.R2_TOKEN || '';
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)}`); }
async function api(p, opt = {}) {
  const headers = { authorization: 'Bearer ' + TOKEN };
  if (opt.body) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
  return r.json().catch(() => ({}));
}

(async () => {
  const s = await api('/api/state?since=0');
  const before = s.lastSeq || 0;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE + '/#token=' + encodeURIComponent(TOKEN), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#input');
  await page.click('#input');
  await page.type('#input', 'KV cache 迁移');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const afterEnter = await api('/api/state?since=0');
  check('plain Enter does not send while typing', afterEnter.lastSeq === before, { before, after: afterEnter.lastSeq });
  check('text stays in the input after Enter', (await page.inputValue('#input')).includes('KV cache 迁移'));

  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(500);
  const afterCtrl = await api('/api/messages?since=' + before);
  check('Ctrl+Enter sends the composed text', afterCtrl.messages.some((m) => m.content.includes('KV cache 迁移')), afterCtrl.messages.map((m) => m.content).slice(-2));
  check('input is cleared after send', (await page.inputValue('#input')) === '');

  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
