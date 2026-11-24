'use strict';
/* Browser tests for the RC additions: meeting switcher, session picker, project browser. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.R2_URL || 'http://127.0.0.1:8820';
const TOKEN = process.env.R2_TOKEN || '';
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)}`); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept('RC UI 新会议'));
  await page.goto(BASE + '/#token=' + encodeURIComponent(TOKEN), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#roomSelect option').length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(600);

  const roomOptions = await page.locator('#roomSelect option').count();
  check('meeting list populated', roomOptions >= 1, 'options=' + roomOptions);

  // Session discovery through the UI.
  await page.selectOption('#inviteProvider', 'codex-cli/openai');
  await page.click('#loadSessions');
  await page.waitForFunction(() => document.querySelectorAll('#sessionPick option').length > 1, null, { timeout: 10000 }).catch(() => {});
  const sessCount = await page.locator('#sessionPick option').count();
  check('session picker lists existing codex sessions', sessCount > 1, 'options=' + sessCount);
  if (sessCount > 1) {
    const options = await page.locator('#sessionPick option').evaluateAll((els) => els.map((e) => ({ value: e.value, disabled: e.disabled })));
    const pick = options.find((o) => o.value && !o.disabled);
    check('at least one resumable session is selectable', !!pick, options.slice(0, 4));
    if (pick) {
      await page.selectOption('#sessionPick', pick.value);
      check('choosing a session fills the id field', (await page.inputValue('#inviteSession')) === pick.value);
    }
  }

  // Project browser: walk down until a markdown file is visible, then select it.
  await page.waitForFunction(() => document.querySelectorAll('#browseList button').length > 0, null, { timeout: 8000 }).catch(() => {});
  let fileBtn = page.locator('#browseList button[data-file]').first();
  for (let i = 0; i < 3 && !(await fileBtn.count()); i++) {
    const dir = page.locator('#browseList button[data-dir]').first();
    if (!(await dir.count())) break;
    await dir.click();
    await page.waitForTimeout(400);
    fileBtn = page.locator('#browseList button[data-file]').first();
  }
  check('project browser shows a markdown file', (await fileBtn.count()) === 1);
  if (await fileBtn.count()) {
    await fileBtn.click();
    await page.waitForFunction(() => /已固定/.test(document.querySelector('#sharedStatus').textContent), null, { timeout: 8000 }).catch(() => {});
    check('clicking a file fixes the shared snapshot', /已固定/.test(await page.textContent('#sharedStatus')), await page.textContent('#sharedStatus'));
  }

  // End the meeting, then create the next one from the UI.
  await page.click('#end');
  await page.waitForFunction(() => document.querySelector('#roomState').textContent.includes('ended'), null, { timeout: 8000 }).catch(() => {});
  check('UI end works', (await page.textContent('#roomState')).includes('ended'), await page.textContent('#roomState'));
  check('send disabled after end', await page.isDisabled('#send'));

  await page.waitForFunction(() => !document.querySelector('#newRoom').disabled, null, { timeout: 5000 }).catch(() => {});
  check('new-meeting button enabled after end', !(await page.isDisabled('#newRoom')));
  await page.click('#newRoom');
  await page.waitForFunction(() => [...document.querySelectorAll('#roomSelect option')].some((o) => o.textContent.includes('RC UI 新会议')), null, { timeout: 8000 }).catch(() => {});
  const names = await page.locator('#roomSelect option').allTextContents();
  check('new meeting appears and is selected', names.some((n) => n.includes('RC UI 新会议')), names);
  check('new meeting is active', (await page.textContent('#roomState')).includes('live'), await page.textContent('#roomState'));
  check('new meeting conversation is empty', (await page.textContent('#messages')).length < 400, (await page.textContent('#messages')).slice(0, 80));

  check('no page errors', errors.length === 0, errors);
  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
