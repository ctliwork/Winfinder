import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = path.resolve('e2e-native-preview');
const files = path.join(out, 'files');
fs.mkdirSync(files, { recursive: true });
fs.writeFileSync(path.join(files, 'A.rtf'), '{\\rtf1\\ansi Native preview A}');
fs.writeFileSync(path.join(files, 'B.rtf'), '{\\rtf1\\ansi Native preview B}');
fs.writeFileSync(path.join(files, 'C.wfpreview'), 'pending discovery fixture');
const proc = spawn(path.resolve('src-tauri/target/debug/Winfinder.exe'), [`--dir=${files}`], {
  env: { ...process.env, WINFINDER_DEVTOOLS_PORT: '9238' }, stdio: 'ignore',
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page;
const results = [], errors = [];
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log('NATIVE PREVIEW PASS', name); }
  catch (e) { results.push({ name, passed: false, error: String(e) }); throw e; }
}
const row = (name) => page.locator('.item .nm, .item .label').filter({ hasText: name }).first();
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9238');
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (page) break;
    } catch { /* Wait for the app's WebView2 server. */ }
    await pause(200);
  }
  assert.ok(page, 'real Windows app is available');
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForSelector('#app');
  await page.evaluate((files) => {
    const prefs = JSON.parse(localStorage.getItem('winfinder:prefs') || '{}');
    Object.assign(prefs, { view: 'list', rememberView: false, autoUpdate: false,
      nativePreview: true, previewPane: true, startup: 'custom', startDir: files });
    localStorage.setItem('winfinder:prefs', JSON.stringify(prefs));
  }, files);
  await page.reload();
  await page.waitForSelector('.item');
  await page.evaluate(() => {
    const show = window.fsApi.previewShow;
    window.__previewCalls = [];
    window.__previewSuccess = null;
    window.fsApi.previewShow = async (...args) => {
      window.__previewCalls.push(args[0]);
      const result = await show(...args);
      if (result === true) window.__previewSuccess = args[0];
      return result;
    };
  });

  await check('[ST-013/CHG-009] registered RTF handler initializes and shows in the real native host', async () => {
    assert.equal(await page.evaluate(() => window.fsApi.previewAvailable('rtf')), true, 'Windows RTF handler is required');
    await row('A.rtf').click();
    await page.waitForFunction(() => document.querySelector('#pv-media')?.dataset.kind === 'native', null, { timeout: 25000 });
    assert.equal(await page.locator('#pv-media').getAttribute('data-native-error'), null);
    assert.equal(path.basename(await page.evaluate(() => window.__previewSuccess)), 'A.rtf');
  });

  await check('[ST-014/CHG-009] quick selection changes settle on the latest native file', async () => {
    await row('B.rtf').click();
    await row('A.rtf').click();
    await page.waitForFunction(() =>
      document.querySelector('#pv-media')?.dataset.kind === 'native' &&
      window.__previewSuccess?.endsWith('A.rtf'), null, { timeout: 25000 });
  });

  await check('[ST-015/CHG-009] closing the pane during discovery prevents late native activation', async () => {
    await page.evaluate(() => {
      const available = window.fsApi.previewAvailable;
      window.fsApi.previewAvailable = (ext) => ext === 'wfpreview'
        ? new Promise((resolve) => { window.__releaseLookup = () => resolve(true); })
            .then((result) => { window.__lookupComplete = true; return result; })
        : available(ext);
    });
    await row('C.wfpreview').click();
    await page.waitForFunction(() => !!window.__releaseLookup);
    await page.click('#btn-preview');
    assert.equal(await page.locator('#preview-pane').isVisible(), false);
    await page.evaluate(() => window.__releaseLookup());
    await page.waitForFunction(() => window.__lookupComplete);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__previewCalls.some((p) => p.endsWith('C.wfpreview'))), false);
  });
  assert.deepEqual(errors, []);
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  if (page) await page.screenshot({ path: path.join(out, 'page.png') }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
