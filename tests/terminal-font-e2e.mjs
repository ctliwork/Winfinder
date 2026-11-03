// Real Windows/WebView2/ConPTY regression test. Any failed check exits nonzero.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exe = path.resolve('src-tauri/target/debug/Winfinder.exe');
const out = path.resolve('e2e-out');
const cwd = path.resolve('e2e-files');
const port = 9223;
fs.mkdirSync(out, { recursive: true });
const results = [];
const terminalTabIds = [];
let browser, page, child;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const detail = await fn();
  results.push({ name, passed: true, detail });
  console.log('FONT PASS', name, JSON.stringify(detail ?? null));
}
async function boot() {
  terminalTabIds.length = 0;
  child = spawn(exe, ['--dir=' + cwd], {
    env: { ...process.env, WINFINDER_DEVTOOLS_PORT: String(port) },
    stdio: 'ignore',
  });
  let error;
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (!page) throw new Error('no app page');
      await page.waitForSelector('#btn-terminal', { timeout: 5000 });
      break;
    } catch (e) {
      error = e;
      await browser?.close().catch(() => {});
      browser = null;
      await pause(500);
    }
  }
  assert.ok(browser, 'App did not connect: ' + error);
  // Observe the actual xterm instances through their public API, not a mock.
  await page.evaluate(() => {
    const Terminal = window.Terminal;
    window.__fontTestTerms = [];
    window.Terminal = class extends Terminal {
      constructor(options) {
        super(options);
        window.__fontTestTerms.push(this);
      }
    };
  });
}
async function settings() {
  await page.keyboard.press('Control+,');
  await page.click('#dlg [data-sec="terminal"]');
  await page.waitForSelector('#dlg input[data-pref="terminalFont"]');
}
async function closeSettings() {
  await page.click('#dlg .set-close');
  await page.waitForSelector('#dlg', { state: 'hidden' });
}
async function setFont(name, size) {
  await page.fill('#dlg input[data-pref="terminalFont"]', name);
  await page.locator('#dlg input[data-pref="terminalFont"]').press('Tab');
  await page.selectOption('#dlg select[data-pref="terminalFontSize"]', String(size));
}
async function openTerminal() {
  const n = await page.evaluate(() => window.__fontTestTerms.length);
  await page.locator('#tabs .tab').first().click();
  await page.click('#btn-terminal');
  await page.waitForFunction((n) => window.__fontTestTerms.length === n + 1, n);
  terminalTabIds.push(await page.locator('#tabs .tab.active').getAttribute('data-tab'));
  await page.waitForFunction(() => {
    const xt = window.__fontTestTerms.at(-1);
    return Array.from({ length: xt.buffer.active.length }, (_, i) => xt.buffer.active.getLine(i)?.translateToString(true) || '').some((s) => /PS .*>/.test(s));
  }, null, { timeout: 30000 });
}
async function snapshot() {
  return page.evaluate(() => window.__fontTestTerms.map((xt) => {
    const styles = getComputedStyle(xt.element.querySelector('.xterm-rows'));
    return {
      family: xt.options.fontFamily, size: xt.options.fontSize,
      cssFamily: styles.fontFamily, cssSize: styles.fontSize,
      cols: xt.cols, rows: xt.rows,
      text: Array.from({ length: xt.buffer.active.length }, (_, i) => xt.buffer.active.getLine(i)?.translateToString(true) || '').join('\n'),
    };
  }));
}
async function commandOutput(marker, command) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction((marker) => {
    const xt = window.__fontTestTerms.at(-1);
    return Array.from({ length: xt.buffer.active.length }, (_, i) => xt.buffer.active.getLine(i)?.translateToString(true) || '').includes(marker);
  }, marker, { timeout: 15000 });
}
async function quit() {
  await page.locator('#tabs .tab').first().click();
  await page.click('#btn-more');
  await page.locator('#menu').getByText('結束 Winfinder', { exact: true }).click();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('app did not quit')), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await browser.close().catch(() => {});
  browser = null;
}
try {
  await boot();
  await check('settings UI and initial font', async () => {
    await settings();
    assert.equal(await page.locator('#dlg input[data-pref="terminalFont"]').inputValue(), 'Cascadia Mono');
    assert.equal(await page.locator('#dlg select[data-pref="terminalFontSize"]').inputValue(), '13');
    await closeSettings();
    await openTerminal();
    const [t] = await snapshot();
    assert.equal(t.size, 13);
    assert.ok(t.family.startsWith('"Cascadia Mono"'));
    assert.equal(t.cssSize, '13px');
    return { size: t.size, family: t.family, cols: t.cols };
  });
  await check('live font update and terminal refit', async () => {
    await settings();
    await setFont('Consolas', 20);
    await closeSettings();
    await page.waitForFunction(() => window.__fontTestTerms[0].options.fontSize === 20);
    await pause(300);
    const [t] = await snapshot();
    assert.equal(t.cssSize, '20px');
    assert.ok(await page.evaluate(() => document.activeElement?.matches('.term.on .xterm-helper-textarea')), 'closing settings must return focus to terminal input');
    assert.ok(t.family.startsWith('"Consolas"'));
    assert.ok(t.cols > 10);
    assert.ok(t.cols < results[0].detail.cols, 'larger font should reduce columns');
    await commandOutput('font-live-ok', 'Write-Output ("font-live-" + "ok")');
    await page.screenshot({ path: path.join(out, 'terminal-font-live.png') });
    return { family: t.family, cssSize: t.cssSize, cols: t.cols };
  });
  await check('new tab inherits font; background tab updates', async () => {
    await openTerminal();
    let ts = await snapshot();
    assert.equal(ts.length, 2);
    assert.equal(ts[1].size, 20);
    assert.ok(ts[1].family.startsWith('"Consolas"'));
    await settings();
    await setFont('Courier New', 16);
    await closeSettings();
    await pause(300);
    ts = await snapshot();
    assert.ok(ts.every((t) => t.size === 16 && t.family.startsWith('"Courier New"')));
    await page.locator('#tabs .tab[data-tab="' + terminalTabIds[0] + '"]').click();
    await pause(300);
    const first = (await snapshot())[0];
    assert.equal(first.cssSize, '16px');
    await page.keyboard.type('Write-Output ("background-" + "ok")');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const xt = window.__fontTestTerms[0];
      return Array.from({ length: xt.buffer.active.length }, (_, i) => xt.buffer.active.getLine(i)?.translateToString(true) || '').includes('background-ok');
    });
    await page.screenshot({ path: path.join(out, 'terminal-font-background.png') });
    return ts.map(({family,size}) => ({family,size}));
  });
  await check('missing font falls back; blank font resets', async () => {
    await settings();
    await setFont('Winfinder Missing Font 123456', 18);
    await closeSettings();
    await page.locator('#tabs .tab[data-tab="' + terminalTabIds[1] + '"]').click();
    await commandOutput('fallback-ok', 'Write-Output ("fallback-" + "ok")');
    await settings();
    await setFont('   ', 18);
    await closeSettings();
    assert.ok((await snapshot()).every((t) => t.family.startsWith('"Cascadia Mono"')));
    return { fallbackCommand: true, blankResets: true };
  });
  await check('PowerShell output, history, completion and interrupt after font changes', async () => {
    await page.keyboard.type('Get-ChildIt');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => {
      const xt = window.__fontTestTerms.at(-1);
      return xt.buffer.active.getLine(xt.buffer.active.baseY + xt.buffer.active.cursorY)?.translateToString(true).includes('Get-ChildItem');
    });
    await page.keyboard.press('Escape');
    await commandOutput('history-ok', 'Write-Output ("history-" + "ok")');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => {
      const xt = window.__fontTestTerms.at(-1);
      return xt.buffer.active.getLine(xt.buffer.active.baseY + xt.buffer.active.cursorY)?.translateToString(true).includes('Write-Output');
    });
    await page.keyboard.press('Escape');
    await page.keyboard.type('Start-Sleep 60');
    await page.keyboard.press('Enter');
    await pause(1200);
    await page.keyboard.press('Control+C');
    await page.waitForFunction(() => {
      const xt = window.__fontTestTerms.at(-1);
      return /PS .*?>\s*$/.test(xt.buffer.active.getLine(xt.buffer.active.baseY + xt.buffer.active.cursorY)?.translateToString(true) || '');
    }, null, { timeout: 10000 });
    await commandOutput('interrupt-ok', 'Write-Output ("interrupt-" + "ok")');
    return { completion: true, history: true, interrupt: true };
  });
  await check('font and size survive a full application restart', async () => {
    await settings();
    await setFont('Consolas', 22);
    await closeSettings();
    await quit();
    await boot();
    await settings();
    assert.equal(await page.locator('#dlg input[data-pref="terminalFont"]').inputValue(), 'Consolas');
    assert.equal(await page.locator('#dlg select[data-pref="terminalFontSize"]').inputValue(), '22');
    await closeSettings();
    await openTerminal();
    const [t] = await snapshot();
    assert.equal(t.size, 22);
    assert.equal(t.cssSize, '22px');
    assert.ok(t.family.startsWith('"Consolas"'));
    await commandOutput('restart-ok', 'Write-Output ("restart-" + "ok")');
    await page.screenshot({ path: path.join(out, 'terminal-font-restart.png') });
    return { family: t.family, size: t.size, command: true };
  });
  await check('exit closes the terminal tab', async () => {
    const before = await page.locator('#tabs .tab').count();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await page.waitForFunction((before) => document.querySelectorAll('#tabs .tab').length === before - 1, before, { timeout: 15000 });
    return true;
  });
  console.log('FONT RESULT', JSON.stringify({ passed: true, results }));
} catch (error) {
  results.push({ passed: false, error: error.stack || String(error) });
  console.error('FONT FAILED', error);
  if (page) {
    await page.screenshot({ path: path.join(out, 'terminal-font-failure.png') }).catch(() => {});
    console.error('FONT SCREEN', JSON.stringify(await snapshot().catch(() => null)));
  }
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'terminal-font-report.json'), JSON.stringify(results, null, 2));
  await browser?.close().catch(() => {});
  // This executable is the test build started by this isolated CI job.
  spawnSync('taskkill', ['/IM', path.basename(exe), '/F']);
}
