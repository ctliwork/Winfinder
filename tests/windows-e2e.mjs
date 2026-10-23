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
const EXE = path.join(DEBUG, fs.readdirSync(DEBUG).find((f) => /^(winfinder|finder-win)\.exe$/i.test(f)));
const PROC = path.basename(EXE, '.exe');
const PORT = 9222;
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
fs.mkdirSync(OUT, { recursive: true });

const report = { exe: EXE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout.trim();
let shots = 0;
function desktop(name) {
  const file = path.join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
  ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`);
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
  try { report[name] = await fn(); } catch (e) { report[name] = { error: String(e).slice(0, 300) }; }
  console.log(name, JSON.stringify(report[name]));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools'));
      if (page) return { browser, page };
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('no DevTools connection');
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

let { browser, page } = {};
await step('start', async () => {
  const t = Date.now();
  launch([`--dir=${FILES}`]);
  ({ browser, page } = await connect());
  await page.evaluate(() => {
    const k = 'finder-win:prefs';
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
  return { ...r, ...windows(), closeButton: closeLit };
});

await step('quit', async () => {
  await page.click('#btn-more');
  await page.locator('#menu >> text=結束 WinFinder').click();
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
