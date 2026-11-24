// Assertions against the real Windows/WebView2 application and isolated fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = path.resolve('e2e-interactions');
const files = path.join(out, 'files');
for (const dir of ['Source', 'Destination', 'Ancestor/Child/Deep']) {
  fs.mkdirSync(path.join(files, dir), { recursive: true });
}
for (const [name, value] of [['A.txt', 'alpha'], ['B.txt', 'beta'], ['C.txt', 'gamma']]) {
  fs.writeFileSync(path.join(files, 'Source', name), value);
}
fs.writeFileSync(path.join(files, 'Ancestor', 'Child', 'Deep', 'inside.txt'), 'inside');
const exe = path.resolve('src-tauri/target/debug/Winfinder.exe');
const proc = spawn(exe, [`--dir=${files}`], {
  env: { ...process.env, WINFINDER_DEVTOOLS_PORT: '9224' }, stdio: 'ignore',
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, page;
const results = [];
const errors = [];
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log('INTERACTION PASS', name);
}
async function goto(dir, mode = 'list') {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+l');
  await page.locator('#path-input').fill(dir);
  await page.keyboard.press('Enter');
  await page.waitForFunction((dir) => {
    const last = [...document.querySelectorAll('#pathbar .crumb[data-path]')].at(-1);
    return last?.dataset.path.toLowerCase() === dir.toLowerCase();
  }, dir);
  await page.click(`#view-seg [data-view="${mode}"]`);
  await page.waitForFunction((mode) => document.body.classList.contains(`view-${mode}`), mode);
}
const row = (name) => page.locator('.item .nm, .item .label').filter({ hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first();
async function blankMenu(selector = '#content') {
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
}
async function waitFile(file, exists = true) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file) === exists) return;
    await pause(50);
  }
  assert.equal(fs.existsSync(file), exists, file);
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (page) break;
    } catch { /* WebView2 is still starting. */ }
    await pause(200);
  }
  assert.ok(page, 'real app page');
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForSelector('#app');
  await page.evaluate((files) => {
    const prefs = JSON.parse(localStorage.getItem('winfinder:prefs') || '{}');
    Object.assign(prefs, { theme: 'dark', view: 'list', rememberView: false,
      autoUpdate: false, nativePreview: false, menuStyle: 'finder', confirmTrash: false,
      startup: 'custom', startDir: files });
    localStorage.setItem('winfinder:prefs', JSON.stringify(prefs));
  }, files);
  await page.reload();
  await page.waitForSelector('.item');

  await check('[ST-002/BUG-007] IME confirmation, Escape cancellation, and Enter commit', async () => {
    await goto(path.join(files, 'Source'));
    await row('A.txt').click();
    await page.keyboard.press('F2');
    const input = page.locator('input.rename');
    await input.fill('中文檔名.txt');
    await input.evaluate((e) => e.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true,
    })));
    assert.equal(await input.count(), 1);
    assert.equal(fs.existsSync(path.join(files, 'Source', '中文檔名.txt')), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('input.rename'));
    assert.equal(fs.readFileSync(path.join(files, 'Source', 'A.txt'), 'utf8'), 'alpha');
    await row('A.txt').click();
    await page.keyboard.press('F2');
    await input.fill('Renamed.txt');
    await page.keyboard.press('Enter');
    await waitFile(path.join(files, 'Source', 'Renamed.txt'));
    await page.waitForFunction(() => !document.querySelector('input.rename'));
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Source', 'A.txt'));
    await row('A.txt').waitFor();
  });

  await check('[ST-003/BUG-002] watcher read already running before F2 preserves the editor', async () => {
    await page.evaluate(() => {
      const original = window.fsApi.list;
      window.__releaseList = null;
      window.__heldList = false;
      window.fsApi.list = async (...args) => {
        const result = await original(...args);
        if (!window.__heldList) {
          window.__heldList = true;
          await new Promise((resolve) => { window.__releaseList = resolve; });
        }
        return result;
      };
      window.__restoreList = () => { window.fsApi.list = original; };
    });
    fs.writeFileSync(path.join(files, 'Source', 'watch.txt'), 'notification');
    await page.waitForFunction(() => !!window.__releaseList);
    await row('A.txt').click();
    await page.keyboard.press('F2');
    await page.locator('input.rename').fill('Draft.txt');
    await page.evaluate(() => { window.__releaseList(); window.__restoreList(); });
    await pause(700);
    assert.equal(await page.locator('input.rename').inputValue(), 'Draft.txt');
    assert.equal(await page.locator('input.rename').evaluate((e) => document.activeElement === e), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('input.rename'));
    assert.equal(fs.existsSync(path.join(files, 'Source', 'Draft.txt')), false);
  });

  await check('[ST-011/BUG-008] rename completion and watcher updates preserve address input', async () => {
    await page.evaluate(() => {
      const original = window.fsApi.rename;
      window.fsApi.rename = async (...args) => {
        await new Promise((resolve) => { window.__releaseRename = resolve; });
        return original(...args);
      };
      window.__restoreRename = () => { window.fsApi.rename = original; };
    });
    await row('A.txt').click();
    await page.keyboard.press('F2');
    await page.locator('input.rename').fill('Address-race.txt');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!window.__releaseRename);
    await page.keyboard.press('Control+l');
    await page.locator('#path-input').fill('partial path being typed');
    await page.evaluate(() => { window.__releaseRename(); window.__restoreRename(); });
    await waitFile(path.join(files, 'Source', 'Address-race.txt'));
    fs.writeFileSync(path.join(files, 'Source', 'address-watch.txt'), 'notification');
    await pause(700);
    assert.equal(await page.locator('#path-input').inputValue(), 'partial path being typed');
    assert.equal(await page.locator('#path-input').evaluate((e) => document.activeElement === e), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Source', 'A.txt'));
    await row('A.txt').waitFor();
  });

  await check('[ST-004/BUG-004] new text file and immediate Ctrl+Z undo the new file', async () => {
    await page.evaluate(() => {
      const original = window.fsApi.newFile;
      window.fsApi.newFile = async (...args) => {
        await new Promise((resolve) => { window.__releaseCreate = resolve; });
        return original(...args);
      };
      window.__restoreCreate = () => { window.fsApi.newFile = original; };
    });
    await page.keyboard.press('Control+Alt+n');
    await page.waitForFunction(() => !!window.__releaseCreate);
    await page.keyboard.press('Control+z');
    await page.evaluate(() => { window.__releaseCreate(); window.__restoreCreate(); });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已復原新增文字文件'));
    assert.equal(fs.existsSync(path.join(files, 'Source', '新文字文件.txt')), false);
    await page.waitForFunction(() => !document.querySelector('input.rename'));
  });

  await check('[ST-005/BUG-005] ancestor-column background creation uses the clicked folder', async () => {
    await goto(path.join(files, 'Ancestor'), 'columns');
    await row('Child').click();
    await row('Deep').click();
    const ancestor = page.locator('.col').filter({ has: page.locator('.nm', { hasText: /^Child$/ }) }).first();
    await ancestor.scrollIntoViewIfNeeded();
    const box = await ancestor.boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
    await page.locator('#menu .mi', { hasText: '新增資料夾' }).click();
    const input = page.locator('input.rename');
    await input.waitFor();
    await input.fill('Created-here');
    await page.keyboard.press('Enter');
    await waitFile(path.join(files, 'Ancestor', 'Created-here'));
    assert.equal(fs.existsSync(path.join(files, 'Ancestor', 'Child', 'Deep', 'Created-here')), false);
    await page.waitForFunction(() => !document.querySelector('input.rename'));
  });

  await check('[ST-006/BUG-006] deleting an ancestor returns to a surviving folder and can be undone', async () => {
    await goto(path.join(files, 'Ancestor'), 'columns');
    await row('Child').click();
    await row('Deep').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#pathbar .crumb')].at(-1)?.textContent === 'Deep');
    await row('inside.txt').click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => [...document.querySelectorAll('.crow.sel .nm')].some((e) => e.textContent === 'Child'));
    await page.click('#btn-trash');
    await waitFile(path.join(files, 'Ancestor', 'Child'), false);
    await page.waitForFunction(() => [...document.querySelectorAll('#pathbar .crumb')].at(-1)?.textContent === 'Ancestor');
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Ancestor', 'Child', 'Deep', 'inside.txt'));
    assert.equal(fs.readFileSync(path.join(files, 'Ancestor', 'Child', 'Deep', 'inside.txt'), 'utf8'), 'inside');
  });

  await check('[ST-007/BUG-003] an old deep-search response cannot replace the folder scope', async () => {
    await goto(path.join(files, 'Source'));
    await page.evaluate(() => {
      window.fsApi.search = () => new Promise((resolve) => { window.__resolveSearch = resolve; });
    });
    await page.locator('#search').fill('A');
    await page.locator('#search').press('Enter');
    await page.waitForFunction(() => !!window.__resolveSearch);
    await page.click('[data-scope="folder"]');
    await page.evaluate(() => window.__resolveSearch({ entries: [{ name: 'Stale.txt', path: 'C:\\Stale.txt', isDir: false }] }));
    await pause(150);
    assert.equal(await row('Stale.txt').count(), 0);
    assert.equal(await row('A.txt').count(), 1);
    await page.locator('#search').press('Escape');
  });

  await check('[ST-008] copy, paste, duplicate and undo preserve file contents', async () => {
    await goto(path.join(files, 'Source'));
    await row('B.txt').click();
    await page.keyboard.press('Control+c');
    await goto(path.join(files, 'Destination'));
    await page.keyboard.press('Control+v');
    await waitFile(path.join(files, 'Destination', 'B.txt'));
    assert.equal(fs.readFileSync(path.join(files, 'Destination', 'B.txt'), 'utf8'), 'beta');
    await row('B.txt').click();
    await page.keyboard.press('Control+d');
    await waitFile(path.join(files, 'Destination', 'B 2.txt'));
    assert.equal(fs.readFileSync(path.join(files, 'Destination', 'B 2.txt'), 'utf8'), 'beta');
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Destination', 'B 2.txt'), false);
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Destination', 'B.txt'), false);
    assert.equal(fs.readFileSync(path.join(files, 'Source', 'B.txt'), 'utf8'), 'beta');
  });

  await check('[ST-009] cut, paste and undo restore the original path', async () => {
    await goto(path.join(files, 'Source'));
    await row('C.txt').click();
    await page.keyboard.press('Control+x');
    await goto(path.join(files, 'Destination'));
    await page.keyboard.press('Control+v');
    await waitFile(path.join(files, 'Destination', 'C.txt'));
    assert.equal(fs.existsSync(path.join(files, 'Source', 'C.txt')), false);
    await page.keyboard.press('Control+z');
    await waitFile(path.join(files, 'Source', 'C.txt'));
    assert.equal(fs.existsSync(path.join(files, 'Destination', 'C.txt')), false);
    assert.equal(fs.readFileSync(path.join(files, 'Source', 'C.txt'), 'utf8'), 'gamma');
  });

  await check('[ST-010] views, tab switching, and reopening a closed tab retain the folder', async () => {
    await goto(path.join(files, 'Source'));
    for (const mode of ['icons', 'gallery', 'columns', 'list']) {
      await page.click(`#view-seg [data-view="${mode}"]`);
      await (mode === 'gallery' ? page.locator('.g-item[title="A.txt"]') : row('A.txt')).waitFor();
    }
    await page.keyboard.press('Control+t');
    await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
    await goto(path.join(files, 'Destination'));
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction(() => [...document.querySelectorAll('#pathbar .crumb')].at(-1)?.textContent === 'Source');
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction(() => [...document.querySelectorAll('#pathbar .crumb')].at(-1)?.textContent === 'Destination');
    await page.keyboard.press('Control+w');
    await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 1);
    await page.keyboard.press('Control+Shift+t');
    await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
    await page.waitForFunction(() => [...document.querySelectorAll('#pathbar .crumb')].at(-1)?.textContent === 'Destination');
  });
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('INTERACTION RESULT', JSON.stringify({ passed: true, results }));
} catch (error) {
  results.push({ passed: false, error: error.stack || String(error) });
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  console.error('INTERACTION FAILED', error);
  console.error('INTERACTION UI', await page?.evaluate(() => ({
    active: document.activeElement?.outerHTML,
    title: document.querySelector('#title')?.textContent,
    pathbar: document.querySelector('#pathbar')?.outerHTML,
    renaming: document.querySelector('input.rename')?.outerHTML,
  })).catch(() => null));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
