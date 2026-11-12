// Real Windows/WebView2 smoke checks for the glass chrome and responsive layout.
// Run after: npx tauri build --debug --no-bundle
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = path.resolve('e2e-glass');
const files = path.join(out, 'files');
fs.mkdirSync(path.join(files, 'Projects'), { recursive: true });
for (const name of ['A.txt', 'B.txt', 'C.txt']) fs.writeFileSync(path.join(files, name), name);
for (const name of ['01-folder', '02-folder', '03-folder']) fs.mkdirSync(path.join(files, name), { recursive: true });
fs.writeFileSync(path.join(files, 'Readme.txt'), 'Winfinder\nGlass interface preview\n');
const exe = path.resolve('src-tauri/target/debug/Winfinder.exe');
const port = 9223;
const proc = spawn(exe, [`--dir=${files}`], {
  env: { ...process.env, WINFINDER_DEVTOOLS_PORT: String(port) },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
const report = [];
const errors = [];
try {
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch { await sleep(500); }
  }
  assert.ok(browser, 'WebView2 DevTools connection');
  // The DevTools port can be ready before WebView2 creates its first target.
  let page;
  for (let i = 0; i < 120; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
    if (page) break;
    await sleep(250);
  }
  assert.ok(page, 'app page');
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForSelector('#app');
  await page.evaluate(() => {
    const k = 'winfinder:prefs';
    const prefs = JSON.parse(localStorage.getItem(k) || '{}');
    Object.assign(prefs, { theme: 'light', view: 'columns', rememberView: false,
      autoUpdate: false, nativePreview: false, menuStyle: 'finder' });
    localStorage.setItem(k, JSON.stringify(prefs));
  });
  await page.reload();
  await page.waitForSelector('.crow');
  const cdp = await page.context().newCDPSession(page);
  const nativeMaterial = await page.evaluate(() => window.__finderEnv.material);
  for (const theme of ['light', 'dark', 'system']) {
    await page.evaluate((theme) => {
      const k = 'winfinder:prefs';
      const prefs = JSON.parse(localStorage.getItem(k));
      prefs.theme = theme;
      localStorage.setItem(k, JSON.stringify(prefs));
    }, theme);
    await page.reload();
    await page.waitForSelector('.crow');
    for (const width of [1180, 680]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 740, deviceScaleFactor: 1, mobile: false,
      });
      await page.waitForTimeout(200);
      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        return {
          width: innerWidth, height: innerHeight,
          main: rect('#main'), toolbar: rect('#toolbar'), more: rect('#btn-more'),
          close: rect('.cap.close'), status: rect('#statusbar'),
          tab: rect('.tab.active'), content: rect('#content'),
          sidebarFilter: style('#sidebar').backdropFilter,
          bodyBackground: style('body').backgroundColor,
          contentBackground: style('#body').backgroundColor,
          text: style('body').color,
          tabRadius: style('.tab.active').borderRadius,
          material: document.documentElement.dataset.material,
          theme: document.documentElement.dataset.theme || 'system',
        };
      });
      assert.equal(layout.theme, theme);
      assert.equal(layout.material, nativeMaterial);
      assert.ok(layout.sidebarFilter.includes('blur'), 'sidebar blur');
      assert.ok(layout.more.right <= layout.main.right + 1, 'more button fits');
      assert.ok(layout.close.right <= layout.main.right + 1, 'caption fits');
      assert.ok(layout.more.x >= layout.main.x, 'more button remains visible');
      assert.ok(layout.status.bottom <= layout.height + 1, 'status stays in window');
      assert.ok(layout.content.height > 200, 'usable file area');
      assert.equal(layout.tabRadius, '9px', 'floating rounded tab');
      if (nativeMaterial === 'acrylic') {
        assert.equal(layout.bodyBackground, 'rgba(0, 0, 0, 0)', 'desktop can show through shell');
      }
      const name = `${theme}-${width}`;
      const image = await page.screenshot({ path: path.join(out, `${name}.png`), type: 'png' });
      // Two small JPEG previews in the job log allow visual inspection without
      // downloading the artifact; full-resolution PNGs are kept in the artifact.
      if (width === 1180 && theme !== 'system') {
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
        console.log(`GLASS_SHOT ${name} ${jpeg.toString('base64')}`);
      }
      report.push({ name, ...layout, screenshotBytes: image.length });
      // Menus must remain legible and wholly on-screen at both widths.
      await page.click('#btn-more');
      await page.waitForSelector('#menu:not([hidden])');
      const menu = await page.locator('#menu').boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1, 'menu horizontal fit');
      assert.ok(menu.y >= 0 && menu.y + menu.height <= 741, 'menu vertical fit');
      await page.keyboard.press('Escape');
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  // Shift+arrows must extend/shrink a range without navigating into folders.
  const selectedNames = () => page.locator('.crow.sel .nm').allTextContents();
  const expectSelection = async (names) => {
    await page.waitForFunction((names) => {
      const actual = [...document.querySelectorAll('.crow.sel .nm')].map((e) => e.textContent);
      return JSON.stringify(actual) === JSON.stringify(names);
    }, names);
    assert.deepEqual(await selectedNames(), names);
  };
  const selectA = () => page.locator('.crow', { hasText: /^A[.]txt$/ }).first().click();
  await selectA();
  await page.keyboard.press('Shift+ArrowDown');
  await expectSelection(['A.txt', 'B.txt']);
  await page.keyboard.press('Shift+ArrowDown');
  await expectSelection(['A.txt', 'B.txt', 'C.txt']);
  await page.keyboard.press('Shift+ArrowUp');
  await expectSelection(['A.txt', 'B.txt']);
  await page.keyboard.press('Shift+ArrowUp');
  await expectSelection(['A.txt']);
  await page.keyboard.press('Shift+ArrowUp');
  // The anchor stays A.txt when extending in the opposite direction.
  await expectSelection(['Projects', 'A.txt']);
  await selectA();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expectSelection(['A.txt', 'B.txt', 'C.txt']);
  await page.keyboard.press('ArrowDown');
  await expectSelection(['Readme.txt']);
  // Starting in an ancestor column, then shrinking to one folder, must not
  // reopen that folder or discard the anchor.
  await page.locator('.crow', { hasText: /^01-folder$/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.col').length === 2);
  await page.keyboard.press('Shift+ArrowDown');
  await expectSelection(['01-folder', '02-folder']);
  assert.equal(await page.locator('.col').count(), 1);
  await page.keyboard.press('Shift+ArrowUp');
  await expectSelection(['01-folder']);
  assert.equal(await page.locator('.col').count(), 1);
  // Queue key repeats while navigating out of an ancestor column.
  await page.locator('.crow', { hasText: /^01-folder$/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.col').length === 2);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await expectSelection(['01-folder', '02-folder', '03-folder']);
  // List view retains the same range semantics.
  await page.click('#view-seg [data-view="list"]');
  await page.locator('.lrow', { hasText: 'A.txt' }).first().click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForFunction(() => document.querySelectorAll('.lrow.sel').length === 2);
  assert.deepEqual(await page.locator('.lrow.sel .nm').allTextContents(), ['A.txt', 'B.txt']);
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.lrow.sel').length === 1);
  await page.click('#view-seg [data-view="columns"]');
  report.push({ name: 'shift-arrow-selection', passed: true });
  // Check file navigation and preview after the shell/layout changes.
  await page.locator('.crow', { hasText: 'Projects' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.col').length >= 2);
  await page.locator('.crow', { hasText: 'Readme.txt' }).first().click();
  await page.waitForFunction(() => document.querySelector('.col-preview .pv-name')?.textContent === 'Readme.txt');
  await page.keyboard.press('Control+t');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2);
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1);
  await page.keyboard.press('Control+,');
  await page.waitForSelector('#dlg-window.settings');
  await page.locator('[data-sec="look"]').click();
  await page.locator('[data-pref="theme"]').selectOption('dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.keyboard.press('Escape');
  // Reduced transparency and high contrast must offer opaque readable surfaces.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await page.locator('#sidebar').evaluate((e) => getComputedStyle(e).backdropFilter), 'none');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  assert.equal(await page.locator('#sidebar').evaluate((e) => getComputedStyle(e).backdropFilter), 'none');
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('GLASS_RESULT', JSON.stringify({ passed: true, nativeMaterial, report }));
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
