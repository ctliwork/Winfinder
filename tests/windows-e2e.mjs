// End-to-end run of the real app on Windows (.github/workflows/windows-test.yml).
// The app is started with WebView2's DevTools port open, so this script can
// click through its UI over CDP; desktop screenshots also catch the native
// windows (Explorer's preview handlers) that a page screenshot can't see.
// Usage: node tests/windows-e2e.mjs <fixtures folder>   (see tests/make_fixtures.py)
// Writes e2e-out/report.json and screenshots; prints the report.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FILES = path.resolve(process.argv[2] || 'e2e-files');
const OUT = path.resolve('e2e-out');
const DEBUG = path.resolve('src-tauri/target/debug');
const EXE = path.join(DEBUG, fs.readdirSync(DEBUG).find((f) => /^winfinder\.exe$/i.test(f)));
const PROC = path.basename(EXE, '.exe');
const PORT = 9222;
const env = { ...process.env, WINFINDER_DEVTOOLS_PORT: String(PORT) }; // see create_main_window in lib.rs
fs.mkdirSync(OUT, { recursive: true });

const report = { exe: EXE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout.trim();
let shots = 0;
// `log`: also print a small JPEG of it into the job log (SHOT <name> <base64>),
// for when the artifact can't be downloaded.
function desktop(name, { log = false } = {}) {
  const file = path.join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
  ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`);
  if (!log) return;
  const small = file.replace(/\.png$/, '.jpg');
  ps(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${file}'); $w=900; $h=[int]($i.Height*$w/$i.Width); $s=New-Object System.Drawing.Bitmap $i,$w,$h; $c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | ? { $_.MimeType -eq 'image/jpeg' }; $p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 55L; $s.Save('${small}', $c, $p)`);
  if (fs.existsSync(small)) console.log(`SHOT ${name} ${fs.readFileSync(small).toString('base64')}`);
}
// How many app processes run, and whether one shows its window.
function windows() {
  const [n, visible] = ps(`$p=@(Get-Process ${PROC} -ErrorAction SilentlyContinue); "$($p.Count) $(@($p | ? { $_.MainWindowHandle -ne 0 }).Count)"`).split(' ').map(Number);
  return { processes: n, visible: visible > 0 };
}
const launch = (args) => spawn(EXE, args, { env, detached: true, stdio: 'ignore' }).unref();
function again(args = []) {
  const t = Date.now();
  const r = spawnSync(EXE, args, { env, timeout: 20000 });
  return { exit: r.status, ms: Date.now() - t, timedOut: !!r.error };
}
async function step(name, fn) {
  try { report[name] = await fn(); } catch (e) { report[name] = { error: String(e).slice(0, 1500) }; }
  console.log(name, JSON.stringify(report[name]));
}

async function connect() {
  let last = 'nothing listening';
  for (let i = 0; i < 60; i++) {
    last = 'nothing listening';
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      last = `targets: ${JSON.stringify(targets.map((t) => [t.type, t.url]))}`;
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page = pages.find((p) => !p.url().startsWith('devtools'));
      if (page) return { browser, page };
      last += `; playwright sees ${browser.contexts().length} contexts, pages ${JSON.stringify(pages.map((p) => p.url()))}`;
      await browser.close().catch(() => {});
    } catch (e) { last = `${last} | ${String(e).slice(0, 200)}`; }
    await sleep(1000);
  }
  const ports = ps(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ? { $_.OwningProcess -in @(Get-Process ${PROC},msedgewebview2 -ErrorAction SilentlyContinue).Id } | % { $_.LocalPort }`);
  desktop('no-devtools');
  throw new Error(`no DevTools connection (${last}; ${JSON.stringify(windows())}; listening: ${ports.replace(/\s+/g, ' ')})`);
}

// What the column view's preview column shows, once something is there (or after 8 s).
const PROBE = () => {
  const m = document.querySelector('.cp-media');
  const img = m?.querySelector(':scope > img');
  return {
    title: document.querySelector('.col-preview .pv-name')?.textContent,
    kind: m?.dataset.kind,
    text: m?.innerText.replace(/\s+/g, ' ').trim().slice(0, 100),
    img: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
    font: !!m?.querySelector('.pv-font'),
  };
};
async function preview(page, name) {
  const t0 = Date.now();
  await page.locator('.col .crow', { hasText: name }).first().click();
  const shownMs = await page.evaluate((name) => new Promise((res) => {
    const t = performance.now();
    const tick = () => {
      const m = document.querySelector('.cp-media');
      const ready = document.querySelector('.col-preview .pv-name')?.textContent === name && m && m.dataset.kind;
      if (ready || performance.now() - t > 8000) res(Math.round(performance.now() - t)); else requestAnimationFrame(tick);
    };
    tick();
  }), name);
  await sleep(2500); // a native preview handler may lay its window over it meanwhile
  const r = { shownMs, ...(await page.evaluate(PROBE)), totalMs: Date.now() - t0 };
  desktop(`preview-${name.replace(/[^\w.]/g, '_')}`);
  return r;
}

// A photo with EXIF details (camera, exposure, date, GPS) for the media info step.
fs.copyFileSync(path.resolve('src-tauri/tests/exif.jpg'), path.join(FILES, '相機.jpg'));

let { browser, page } = {};
await step('start', async () => {
  const t = Date.now();
  launch([`--dir=${FILES}`]);
  ({ browser, page } = await connect());
  // The first page may still be the webview's blank one, before the app loads.
  await page.waitForSelector('#app', { timeout: 20000 });
  await page.evaluate(() => {
    const k = 'winfinder:prefs';
    const p = JSON.parse(localStorage.getItem(k) || '{}');
    Object.assign(p, { menuStyle: 'finder', view: 'columns', rememberView: false, colPreview: true, nativePreview: true, keepRunning: true });
    localStorage.setItem(k, JSON.stringify(p));
  });
  await page.reload();
  await page.waitForSelector('.col .crow', { timeout: 20000 });
  desktop('start');
  return { ms: Date.now() - t, url: page.url(), ...windows() };
});

for (const name of ['筆記.txt', '說明.md', '資料.csv', '照片.jpg', '報告.docx', '簡報.pptx', '預算.xlsx', '文件.pdf', '封存.7z', '封存.tar.gz', 'arial.ttf', '說明.rtf']) {
  await step(`preview ${name}`, () => preview(page, name));
}

await step('arrow keys', async () => {
  await page.locator('.col .crow', { hasText: '筆記.txt' }).first().click();
  await sleep(1500);
  const t = Date.now();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('.cp-media')?.dataset.kind, null, { timeout: 8000 });
  return { ms: Date.now() - t, ...(await page.evaluate(PROBE)) };
});

await step('media info', async () => {
  await page.locator('.col .crow', { hasText: '相機.jpg' }).first().click();
  await page.waitForSelector('.col-preview .pv-media-info', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.col-preview .pv-media-info').scrollIntoView());
  desktop('media-info');
  const rows = await page.$$eval('.col-preview .pv-media-info > div', (els) => els.map((e) => [...e.children].map((c) => c.textContent)));
  await page.locator('.col .crow', { hasText: '照片.jpg' }).first().click();
  await page.waitForFunction(() => document.querySelector('.col-preview .pv-name')?.textContent === '照片.jpg');
  await sleep(1500);
  const plain = await page.$$eval('.col-preview .pv-media-info > div', (els) => els.map((e) => [...e.children].map((c) => c.textContent)));
  return { rows, plain };
});

await step('reopen closed tab', async () => {
  const titles = () => page.$$eval('#tabs .tab', (els) => els.map((e) => e.textContent.trim()));
  await page.locator('.col .crow', { hasText: '子資料夾' }).first().click({ button: 'middle' });
  await sleep(800);
  const opened = await titles();
  await page.locator('#tabs .tab').last().click();
  await page.keyboard.press('Control+W');
  await sleep(500);
  const closed = await titles();
  await page.keyboard.press('Control+Shift+T');
  await sleep(800);
  const reopened = await titles();
  await page.keyboard.press('Control+W');
  await page.locator('#tabs .tab').first().click();
  return { opened, closed, reopened };
});

await step('snap layouts', async () => {
  const build = ps('(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").CurrentBuildNumber');
  await page.hover('#caption [data-act="max"]');
  await sleep(2000);
  desktop('snap-layouts', { log: true });
  ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')");
  await page.mouse.move(400, 400);
  await sleep(500);
  return { build, ...windows() };
});

// Settings changed for one step: written to the page's storage, then a reload.
async function withPrefs(patch) {
  await page.evaluate((patch) => {
    const k = 'winfinder:prefs';
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) || '{}'), ...patch }));
  }, patch);
  await page.reload();
  await page.waitForSelector('.col .crow, #view .item', { timeout: 20000 });
  await sleep(500);
}
// The names shown, whatever the view (list rows, icons, columns).
const names = () => page.$$eval('#view [data-i] .nm, #view [data-i] .label', (els) => els.map((e) => e.textContent.trim()));
const titleIs = (t) => page.waitForFunction((t) => document.querySelector('#title')?.textContent === t, t, { timeout: 8000 });

// Each column keeps its own folder's order: a folder that remembers another
// sort must not reorder the columns to its left (they used to jump).
// 大資料夾 remembers "by name, Z to A": its own column follows that, the
// column to its left keeps the folder's own order.
await step('column sort', async () => {
  await withPrefs({ rememberView: true, folderViews: { [path.join(FILES, '大資料夾').toLowerCase()]: { sort: { key: 'name', dir: -1 } } } });
  const col = (i) => page.$$eval('.col', (cs, i) => [...(cs[i]?.querySelectorAll('.crow .nm') || [])].map((e) => e.textContent).join('|'), i);
  const orders = [await col(0)];
  let big = '';
  for (const name of ['大資料夾', '子資料夾', '大資料夾', '筆記.txt']) {
    await page.locator('.col').first().locator('.crow', { hasText: name }).first().click();
    await sleep(900);
    orders.push(await col(0));
    if (name === '大資料夾') big = (await col(1)).split('|')[0];
  }
  await withPrefs({ rememberView: false, folderViews: {} });
  return { stable: new Set(orders).size === 1, ownOrder: big === 'file 02999.txt', bigFirst: big, orders: [...new Set(orders)].map((o) => o.slice(0, 160)) };
});

// With Windows icons (the default), a folder never shows the blue Finder
// folder while its own icon loads (it used to flash).
await step('no blue folders', async () => {
  await page.evaluate(() => {
    window.__blue = [];
    const check = () => {
      for (const svg of document.querySelectorAll('#view svg.folder, #places svg.folder, #tabs svg.folder, #pathbar svg.folder')) {
        if (getComputedStyle(svg).visibility === 'visible' && svg.getBoundingClientRect().width > 0) window.__blue.push((svg.closest('[data-i], .place, .tab, .crumb')?.textContent || '?').trim().slice(0, 30));
      }
    };
    window.__blueObserver = new MutationObserver(check);
    window.__blueObserver.observe(document, { childList: true, subtree: true, attributes: true });
  });
  // Folders never shown before, so their icons have to load.
  for (const n of ['甲', '乙', '丙', '丁']) fs.mkdirSync(path.join(FILES, '子資料夾', `新的${n}`), { recursive: true });
  for (const name of ['子資料夾', '大資料夾', '子資料夾']) {
    await page.locator('.col').first().locator('.crow', { hasText: name }).first().click();
    await sleep(800);
  }
  for (const k of ['2', '1', '3']) { await page.keyboard.press(`Control+${k}`); await sleep(800); }
  await page.keyboard.press('Control+T');
  await sleep(800);
  await page.keyboard.press('Control+W');
  await sleep(500);
  await page.locator('.col').first().locator('.crow', { hasText: '筆記.txt' }).first().click(); // back in the top folder
  await sleep(500);
  return page.evaluate(() => { window.__blueObserver.disconnect(); return { seen: [...new Set(window.__blue)], learnt: Object.keys(JSON.parse(localStorage.getItem('winfinder:folder-icon') || '{}')) }; });
});

// The column view, at the top folder (a step may have left it elsewhere).
async function backToTop() {
  await page.keyboard.press('Control+3');
  await sleep(500);
  await page.locator('.col').first().locator('.crow', { hasText: '筆記.txt' }).first().click();
  await sleep(500);
}

await step('file operations', async () => {
  await backToTop();
  const sub = path.join(FILES, '子資料夾');
  const has = (...p) => fs.existsSync(path.join(sub, ...p));
  const r = {};
  await page.keyboard.press('Control+2');
  await page.locator('#view .lrow', { hasText: '子資料夾' }).first().dblclick();
  await titleIs('子資料夾');
  await page.keyboard.press('Control+Shift+N');
  await page.waitForSelector('input.rename');
  await page.keyboard.type('新資料夾A');
  await page.keyboard.press('Enter');
  await sleep(1000);
  r.newFolder = has('新資料夾A');
  await page.locator('#view .lrow', { hasText: 'inner.txt' }).first().click();
  await page.keyboard.press('F2');
  await page.waitForSelector('input.rename');
  await page.keyboard.type('改名');
  await page.keyboard.press('Enter');
  await sleep(1000);
  r.renamed = has('改名.txt') && !has('inner.txt');
  await page.keyboard.press('Control+Z');
  await sleep(1000);
  r.renameUndone = has('inner.txt') && !has('改名.txt');
  await page.locator('#view .lrow', { hasText: 'inner.txt' }).first().click();
  await page.keyboard.press('Control+C');
  await sleep(300);
  await page.locator('#view .lrow', { hasText: '新資料夾A' }).first().dblclick();
  await titleIs('新資料夾A');
  await page.keyboard.press('Control+V');
  await sleep(1500);
  r.pasted = has('新資料夾A', 'inner.txt');
  r.listedAfterPaste = await names();
  await page.keyboard.press('Control+Z');
  await sleep(1500);
  r.pasteUndone = !has('新資料夾A', 'inner.txt');
  await page.keyboard.press('Alt+ArrowUp');
  await titleIs('子資料夾');
  await page.locator('#view .lrow', { hasText: '新資料夾A' }).first().click();
  await page.keyboard.press('Delete');
  await sleep(2000);
  r.trashed = !has('新資料夾A');
  await page.keyboard.press('Control+Z');
  await sleep(2000);
  r.restored = has('新資料夾A');
  r.listed = await names();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Control+3');
  await sleep(800);
  return r;
});

// Column view: the sort menu names the folder it sorts (the column worked in),
// sorts only that column, either way, with or without folders first.
await step('sort menu', async () => {
  await backToTop();
  await withPrefs({ rememberView: true, folderViews: {} });
  const col = (i) => page.$$eval('.col', (cs, i) => [...(cs[i]?.querySelectorAll('.crow .nm') || [])].map((e) => e.textContent), i);
  const pick = async (re) => { await page.locator('#menu .mi', { hasText: re }).first().click(); await sleep(700); };
  await page.locator('.col').first().locator('.crow', { hasText: '子資料夾' }).first().click();
  await sleep(700);
  await page.locator('.col').nth(1).locator('.crow', { hasText: 'inner.txt' }).first().click();
  await sleep(500);
  const root = await col(0);
  const before = await col(1);
  await page.click('#btn-sort');
  const title = await page.$eval('#menu .mi', (e) => e.textContent.trim());
  await pick(/^降冪/);
  const desc = await col(1);
  await page.click('#btn-sort');
  await pick(/資料夾排在前面/);
  const mixed = await col(1);
  await page.click('#btn-sort');
  await pick(/資料夾排在前面/);
  await page.click('#btn-sort');
  await pick(/^升冪/);
  const after = await col(1);
  const rootAfter = await col(0);
  await withPrefs({ rememberView: false, folderViews: {} });
  return { title, before, desc, mixed, after, rootUnchanged: JSON.stringify(root) === JSON.stringify(rootAfter) };
});

// The up button goes to the parent folder (Back goes to the previous one).
await step('up button', async () => {
  await backToTop();
  await page.locator('.col').first().locator('.crow', { hasText: '子資料夾' }).first().click();
  await sleep(600);
  await page.locator('.col').nth(1).locator('.crow', { hasText: '新的甲' }).first().click();
  await sleep(600);
  const r = { at: await page.$eval('#title', (e) => e.textContent) };
  await page.click('#btn-up');
  await sleep(600);
  r.up1 = await page.$eval('#title', (e) => e.textContent);
  await page.click('#btn-up');
  await sleep(600);
  r.up2 = await page.$eval('#title', (e) => e.textContent);
  await page.click('#btn-back');
  await sleep(600);
  r.back = await page.$eval('#title', (e) => e.textContent);
  return r;
});

// A new folder keeps its name box, also after a file with a native (Windows)
// preview was selected; typing names it.
await step('new folder name box', async () => {
  await backToTop();
  const r = {};
  for (const before of ['說明.rtf', '報告.docx', '筆記.txt']) {
    await page.locator('.col').first().locator('.crow', { hasText: before }).first().click();
    await sleep(2500);
    await page.keyboard.press('Control+Shift+N');
    await sleep(2500);
    const box = await page.evaluate(() => { const i = document.querySelector('input.rename'); return i ? (document.activeElement === i ? 'focused' : 'not focused') : 'gone'; });
    const name = `直接命名${before.split('.')[1]}`;
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await sleep(1200);
    r[before] = { box, named: fs.existsSync(path.join(FILES, name)) };
    await page.keyboard.press('Control+Z'); // rename back
    await sleep(800);
    await page.keyboard.press('Control+Z'); // and the new folder
    await sleep(1200);
  }
  desktop('new-folder');
  return r;
});

await step('views', async () => {
  const r = {};
  for (const [k, v] of [['1', 'icons'], ['2', 'list'], ['4', 'gallery'], ['3', 'columns']]) {
    await page.keyboard.press(`Control+${k}`);
    await sleep(800);
    r[v] = await page.evaluate(() => ({ cls: document.querySelector('#view').className, items: document.querySelectorAll('#view [data-i]').length }));
  }
  return r;
});

// In every view, typing in the search box leaves only what matches.
await step('search in folder', async () => {
  const r = {};
  for (const [k, v] of [['3', 'columns'], ['2', 'list'], ['1', 'icons']]) {
    await page.keyboard.press(`Control+${k}`);
    await sleep(600);
    await page.keyboard.press('Control+F');
    await page.keyboard.type('筆記');
    await sleep(1200);
    const found = await names();
    await page.keyboard.press('Escape');
    await sleep(600);
    r[v] = { found, ok: found.length === 1 && found[0] === '筆記.txt', after: (await names()).length, view: await page.$eval('#view', (e) => e.className) };
  }
  await page.keyboard.press('Control+3');
  await sleep(600);
  return r;
});

await step('quick look', async () => {
  await page.locator('.col .crow', { hasText: '筆記.txt' }).first().click();
  await page.keyboard.press('Space');
  await page.waitForSelector('#ql:not([hidden])', { timeout: 5000 });
  await sleep(600);
  const r = { title: await page.$eval('#ql-title', (e) => e.textContent), text: await page.$eval('#ql-body', (e) => e.innerText.slice(0, 40)) };
  desktop('quick-look');
  await page.keyboard.press('Space');
  await sleep(600);
  return { ...r, closed: await page.$eval('#ql', (e) => e.hidden) };
});

await step('settings', async () => {
  await page.keyboard.press('Control+,');
  await page.waitForSelector('#dlg:not([hidden])', { timeout: 5000 });
  const sections = await page.$$eval('#dlg [data-sec]', (els) => els.map((e) => e.textContent.trim()));
  desktop('settings');
  await page.keyboard.press('Escape');
  await sleep(400);
  return { sections, closed: await page.$eval('#dlg', (e) => e.hidden) };
});

await step('tabs', async () => {
  const count = () => page.$$eval('#tabs .tab', (e) => e.length);
  const r = { before: await count() };
  await page.keyboard.press('Control+T');
  await sleep(600);
  r.afterNew = await count();
  await page.keyboard.press('Control+Tab');
  await sleep(400);
  r.active = await page.$eval('#tabs .tab.active', (e) => e.textContent.trim());
  await page.locator('#tabs .tab').last().click();
  await page.keyboard.press('Control+W');
  await sleep(400);
  r.afterClose = await count();
  return r;
});

await step('big folder', async () => {
  const t = Date.now();
  await page.locator('.col .crow', { hasText: '大資料夾' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.col').length >= 2 && document.querySelectorAll('.col')[1].querySelector('.crow'), null, { timeout: 20000 });
  const columns = { ms: Date.now() - t, ...(await page.evaluate(() => { const c = [...document.querySelectorAll('.col')].pop(); return { rows: c.querySelectorAll('.crow').length, pads: c.querySelectorAll('.vpad').length, height: c.scrollHeight }; })) };
  await page.locator('.col .crow', { hasText: 'file 00000.txt' }).first().click();
  await page.click('#view-seg [data-view="list"]');
  await page.waitForSelector('#view.list .lrow');
  const t2 = Date.now();
  await page.keyboard.press('Control+A');
  await page.waitForFunction(() => /已選取 3000/.test(document.querySelector('#status-text').textContent), null, { timeout: 10000 });
  const list = { selectAllMs: Date.now() - t2, ...(await page.evaluate(() => ({ rows: document.querySelectorAll('#view .lrow').length, virtual: document.querySelector('#view').classList.contains('virtual'), nodes: document.querySelectorAll('*').length }))) };
  desktop('big-folder-list');
  await page.click('#view-seg [data-view="columns"]');
  await page.locator('.col .crow', { hasText: '筆記.txt' }).first().click();
  return { columns, list };
});

await step('content search', async () => {
  await page.click('#search');
  await page.keyboard.type('zebra');
  await page.click('[data-scope="content"]');
  await page.waitForFunction(() => !/搜尋中/.test(document.querySelector('#search-status').textContent), null, { timeout: 30000 });
  const r = await page.evaluate(() => ({ status: document.querySelector('#search-status').textContent, found: [...document.querySelectorAll('#view .nm')].map((e) => e.textContent).slice(0, 10) }));
  desktop('content-search');
  await page.keyboard.press('Escape');
  return r;
});

await step('extract 7z', async () => {
  await page.locator('.col .crow', { hasText: '封存.7z' }).first().click({ button: 'right' });
  await page.locator('#menu >> text=/^解壓縮到/').first().click();
  await sleep(4000);
  const out = path.join(FILES, '封存');
  return { folder: fs.existsSync(out), files: fs.existsSync(out) ? fs.readdirSync(out, { recursive: true }) : [], toast: await page.evaluate(() => document.querySelector('#toast')?.textContent) };
});

await step('second launch', async () => {
  const tabs = await page.evaluate(() => document.querySelectorAll('.tab').length);
  const r = again([`--dir=${path.join(FILES, '子資料夾')}`]);
  await sleep(2000);
  return { ...r, tabsBefore: tabs, tabsAfter: await page.evaluate(() => document.querySelectorAll('.tab').length), title: await page.evaluate(() => document.querySelector('#title').textContent), ...windows() };
});

await step('close hides', async () => {
  await page.click('#caption [data-act="close"]');
  await sleep(2000);
  desktop('after-close');
  return windows();
});

await step('open again', async () => {
  const r = again();
  await sleep(2000);
  desktop('opened-again');
  const closeLit = await page.evaluate(() => getComputedStyle(document.querySelector('.cap.close')).backgroundColor);
  // Closing cleared the tabs: one tab, in the startup folder.
  const tabs = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.textContent.trim()));
  return { ...r, ...windows(), closeButton: closeLit, tabs };
});

await step('quit', async () => {
  await page.click('#btn-more');
  await page.locator('#menu >> text=結束 Winfinder').click();
  await sleep(4000);
  return windows();
});
await browser?.close().catch(() => {});

await step('background start', async () => {
  launch(['--background']);
  await sleep(10000);
  const hidden = windows();
  desktop('background');
  const r = again();
  await sleep(3000);
  desktop('background-opened');
  return { afterStart: hidden, second: r, afterOpen: windows() };
});
spawnSync('taskkill', ['/IM', path.basename(EXE), '/F']);

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('REPORT', JSON.stringify(report));
