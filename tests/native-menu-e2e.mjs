import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = path.resolve('e2e-native-menu');
const files = path.join(out, 'files');
fs.mkdirSync(path.join(files, 'Folder'), { recursive: true });
for (const name of ['A.txt', 'B.txt']) fs.writeFileSync(path.join(files, name), name);
const exe = path.resolve('src-tauri/target/debug/Winfinder.exe');
const proc = spawn(exe, [`--dir=${files}`], {
  env: { ...process.env, WINFINDER_DEVTOOLS_PORT: '9226' }, stdio: 'ignore',
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let browser, page;
function popup(close = false) {
  const code = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NativeMenuProbe { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$h = [NativeMenuProbe]::FindWindow('#32768', $null)
${close ? "if ($h -ne [IntPtr]::Zero) { [NativeMenuProbe]::PostMessage($h, 0x100, [IntPtr]0x1B, [IntPtr]::Zero) | Out-Null; [NativeMenuProbe]::PostMessage($h, 0x101, [IntPtr]0x1B, [IntPtr]::Zero) | Out-Null }" : ''}
$h.ToInt64()`;
  const result = spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', code],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim()) !== 0;
}
const row = (name) => page.locator('.lrow .nm').filter({ hasText: new RegExp('^' + name.replace('.', '[.]') + '$') });
async function check(name, invoke, expectedPaths, background = false, shift = false) {
  const before = await page.evaluate(() => window.__nativeCalls.length);
  const action = invoke();
  let shown = false;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    if (popup()) { shown = true; break; }
    await pause(100);
  }
  assert.equal(shown, true, name + ' opens an actual Windows popup');
  popup(true);
  await action;
  await page.waitForFunction((before) => window.__nativeReturned > before, before);
  const call = await page.evaluate((i) => window.__nativeCalls[i], before);
  assert.deepEqual(call.paths.map((p) => p.toLowerCase()).sort(), expectedPaths.map((p) => p.toLowerCase()).sort());
  assert.equal(call.background, background);
  assert.equal(call.shift, shift);
  assert.deepEqual(call.extras, [], 'native menus contain no injected app commands');
  results.push({ name, passed: true, ...call });
  console.log('NATIVE MENU PASS', name);
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (page) break;
    } catch { /* WebView2 is still starting. */ }
    await pause(200);
  }
  assert.ok(page, 'real app page');
  await page.waitForSelector('#app');
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('winfinder:prefs') || '{}');
    Object.assign(prefs, { menuStyle: 'windows', view: 'list', rememberView: false,
      autoUpdate: false, nativePreview: false });
    localStorage.setItem('winfinder:prefs', JSON.stringify(prefs));
  });
  await page.reload();
  await row('A.txt').waitFor();
  await page.evaluate(() => {
    const original = window.fsApi.nativeMenu;
    window.__nativeCalls = [];
    window.__nativeReturned = 0;
    window.fsApi.nativeMenu = async (paths, background, shift, extras) => {
      window.__nativeCalls.push({ paths, background, shift, extras });
      const result = await original(paths, background, shift, extras);
      window.__nativeReturned++;
      return result;
    };
  });
  await check('single file', () => row('A.txt').click({ button: 'right' }), [path.join(files, 'A.txt')]);
  await row('A.txt').click();
  await row('B.txt').click({ modifiers: ['Control'] });
  await check('multiple files', () => row('A.txt').click({ button: 'right' }), ['A.txt', 'B.txt'].map((p) => path.join(files, p)));
  await check('folder', () => row('Folder').click({ button: 'right' }), [path.join(files, 'Folder')]);
  const box = await page.locator('#content').boundingBox();
  await check('folder background', () => page.locator('#content').click({ button: 'right', position: { x: 20, y: box.height - 20 } }), [files], true);
  await check('Shift right-click', () => row('A.txt').click({ button: 'right', modifiers: ['Shift'] }), [path.join(files, 'A.txt')], false, true);
  await row('A.txt').click();
  await check('keyboard context menu', () => page.keyboard.press('Shift+F10'), [path.join(files, 'A.txt')]);
  console.log('NATIVE MENU RESULT', JSON.stringify({ passed: true, results }));
} catch (error) {
  popup(true);
  results.push({ passed: false, error: error.stack || String(error) });
  console.error('NATIVE MENU FAILED', error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2));
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
