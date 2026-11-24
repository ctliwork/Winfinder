// Query the actual Tauri window; a process handle is not a visibility assertion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const exe = path.resolve('src-tauri/target/debug/Winfinder.exe');
const out = path.resolve('e2e-visibility');
const files = path.join(out, 'files');
fs.mkdirSync(files, { recursive: true });
const env = { ...process.env, WINFINDER_DEVTOOLS_PORT: '9225' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, browser, page;
const results = [];
async function boot(args) {
  proc = spawn(exe, args, { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (page) break;
    } catch { /* WebView2 is still starting. */ }
    await pause(200);
  }
  assert.ok(page, 'app page');
  await page.waitForSelector('#pathbar .crumb');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
async function visible(value) {
  await page.waitForFunction(async (value) =>
    (await window.__TAURI__.window.getCurrentWindow().isVisible()) === value, value, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()), value);
}
async function stop() {
  await browser?.close().catch(() => {});
  if (proc) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  browser = page = null;
}
try {
  await boot([`--dir=${files}`]);
  await page.evaluate((files) => {
    const prefs = JSON.parse(localStorage.getItem('winfinder:prefs') || '{}');
    Object.assign(prefs, { keepRunning: true, resetOnClose: true, autoUpdate: false,
      startup: 'custom', startDir: files });
    localStorage.setItem('winfinder:prefs', JSON.stringify(prefs));
  }, files);
  await page.reload();
  await page.waitForSelector('#pathbar .crumb');
  await visible(true);
  await page.click('#caption [data-act="close"]');
  await visible(false);
  assert.equal(proc.exitCode, null, 'close keeps the process running');
  results.push({ name: 'close hides the native window', passed: true });
  spawn(exe, [], { env, stdio: 'ignore' }).unref();
  await visible(true);
  assert.equal(proc.exitCode, null);
  results.push({ name: 'second launch reopens the native window', passed: true });
  await stop();

  await boot(['--background']);
  assert.equal(await page.evaluate(() => window.__finderEnv.background), true);
  await visible(false);
  assert.equal(proc.exitCode, null);
  results.push({ name: 'background launch remains hidden after page readiness', passed: true });
  spawn(exe, [], { env, stdio: 'ignore' }).unref();
  await visible(true);
  results.push({ name: 'normal launch reveals the background instance', passed: true });
  console.log('WINDOW RESULT', JSON.stringify({ passed: true, results }));
} catch (error) {
  results.push({ passed: false, error: error.stack || String(error) });
  console.error('WINDOW FAILED', error);
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2));
  await stop();
}
