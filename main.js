const { app, BrowserWindow, ipcMain, shell, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Windows system files that Explorer hides by default.
const SYSTEM_NAMES = new Set([
  'desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp',
  '$windows.~bt', '$windows.~ws', '$winreagent', 'recovery', 'config.msi', 'documents and settings',
]);

function isHiddenName(name) {
  const lower = name.toLowerCase();
  return name.startsWith('.') || SYSTEM_NAMES.has(lower) || lower.startsWith('ntuser.');
}

let mainWindow;
const startDir = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice(6) || null;

function createWindow() {
  const win11 = isWin && Number(os.release().split('.')[2]) >= 22000;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 680,
    minHeight: 420,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 20 },
    // Windows 11 acrylic shows through the translucent sidebar and toolbar.
    backgroundMaterial: win11 ? 'acrylic' : undefined,
    vibrancy: isMac ? 'sidebar' : undefined,
    backgroundColor: win11 || isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true, // built-in PDF viewer for Quick Look
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', { maximized: false }));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: {
      platform: process.platform,
      material: win11 ? 'acrylic' : (isMac ? 'vibrancy' : 'none'),
      ...(startDir ? { dir: startDir } : {}),
    },
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- window controls ----------
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:toggleMaximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow?.close());

// ---------- places ----------
ipcMain.handle('fs:places', async () => {
  const safe = (name) => { try { return app.getPath(name); } catch { return null; } };
  const favorites = [
    { id: 'home', label: os.userInfo().username, path: os.homedir(), icon: 'home' },
    { id: 'desktop', label: '桌面', path: safe('desktop'), icon: 'desktop' },
    { id: 'documents', label: '文件', path: safe('documents'), icon: 'doc' },
    { id: 'downloads', label: '下載項目', path: safe('downloads'), icon: 'download' },
    { id: 'pictures', label: '圖片', path: safe('pictures'), icon: 'photo' },
    { id: 'music', label: '音樂', path: safe('music'), icon: 'music' },
    { id: 'videos', label: '影片', path: safe('videos'), icon: 'video' },
  ].filter((f) => f.path && fs.existsSync(f.path));

  const locations = [];
  if (isWin) {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const checks = letters.map(async (l) => {
      const root = `${l}:\\`;
      try {
        await withTimeout(fsp.access(root), 800);
        let label = `本機磁碟 (${l}:)`;
        locations.push({ id: root, label, path: root, icon: 'drive', letter: l });
      } catch { /* not mounted */ }
    });
    await Promise.all(checks);
    locations.sort((a, b) => a.letter.localeCompare(b.letter));
  } else {
    locations.push({ id: '/', label: os.hostname(), path: '/', icon: 'drive' });
  }
  return { favorites, locations, home: os.homedir(), sep: path.sep };
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ---------- listing ----------
async function statEntry(dir, dirent) {
  const full = path.join(dir, dirent.name);
  let st = null;
  try { st = await fsp.stat(full); } catch {
    try { st = await fsp.lstat(full); } catch { /* unreadable */ }
  }
  const isDir = st ? st.isDirectory() : dirent.isDirectory();
  return {
    name: dirent.name,
    path: full,
    isDir,
    size: st && !isDir ? st.size : null,
    mtime: st ? st.mtimeMs : null,
    birth: st ? st.birthtimeMs : null,
    ext: isDir ? '' : path.extname(dirent.name).slice(1).toLowerCase(),
    hidden: isHiddenName(dirent.name),
    link: dirent.isSymbolicLink(),
  };
}

ipcMain.handle('fs:list', async (_e, dir) => {
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    // Stat in batches so huge folders don't open thousands of handles at once.
    for (let i = 0; i < dirents.length; i += 256) {
      const batch = dirents.slice(i, i + 256);
      out.push(...await Promise.all(batch.map((d) => statEntry(dir, d))));
    }
    return { ok: true, entries: out };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
});

ipcMain.handle('fs:diskFree', async (_e, dir) => {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch { return null; }
});

ipcMain.handle('fs:folderCount', async (_e, dir) => {
  try { return (await fsp.readdir(dir)).length; } catch { return null; }
});

// ---------- watching ----------
const watchers = new Map();
ipcMain.on('fs:watch', (_e, dirs) => {
  const wanted = new Set(dirs);
  for (const [dir, w] of watchers) {
    if (!wanted.has(dir)) { w.close(); watchers.delete(dir); }
  }
  for (const dir of wanted) {
    if (watchers.has(dir)) continue;
    try {
      let timer = null;
      const w = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => mainWindow?.webContents.send('fs:changed', dir), 120);
      });
      w.on('error', () => { w.close(); watchers.delete(dir); });
      watchers.set(dir, w);
    } catch { /* not watchable */ }
  }
});

// ---------- thumbnails & icons ----------
const thumbCache = new Map();
ipcMain.handle('fs:thumb', async (_e, file, size) => {
  const key = `${file}|${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = null;
  if (isWin || isMac) {
    try {
      const img = await nativeImage.createThumbnailFromPath(file, { width: size, height: size });
      if (!img.isEmpty()) url = img.toDataURL();
    } catch { /* no shell thumbnail */ }
  }
  if (thumbCache.size > 2000) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
});

ipcMain.handle('fs:nativeIcon', async (_e, file) => {
  try {
    const img = await app.getFileIcon(file, { size: 'large' });
    return img.isEmpty() ? null : img.toDataURL();
  } catch { return null; }
});

// ---------- file operations ----------
ipcMain.handle('fs:open', async (_e, file) => shell.openPath(file));
ipcMain.handle('fs:reveal', async (_e, file) => shell.showItemInFolder(file));

ipcMain.handle('fs:trash', async (_e, files) => {
  const failed = [];
  for (const f of files) {
    try { await shell.trashItem(f); } catch { failed.push(f); }
  }
  return failed;
});

ipcMain.handle('fs:rename', async (_e, file, newName) => {
  if (!newName || /[\\/:*?"<>|]/.test(newName)) return { ok: false, error: 'INVALID' };
  const target = path.join(path.dirname(file), newName);
  if (target === file) return { ok: true, path: file };
  const caseOnly = target.toLowerCase() === file.toLowerCase();
  if (!caseOnly && fs.existsSync(target)) return { ok: false, error: 'EXISTS' };
  try {
    await fsp.rename(file, target);
    return { ok: true, path: target };
  } catch (err) { return { ok: false, error: err.code || err.message }; }
});

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = ext && name !== ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base} ${i}${ext && name !== ext ? ext : ''}`);
  }
  return candidate;
}

ipcMain.handle('fs:mkdir', async (_e, dir) => {
  const target = await uniquePath(dir, '未命名資料夾');
  try {
    await fsp.mkdir(target);
    return { ok: true, path: target };
  } catch (err) { return { ok: false, error: err.code || err.message }; }
});

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// op: 'copy' | 'move'
ipcMain.handle('fs:transfer', async (_e, op, files, destDir) => {
  const results = [];
  for (const src of files) {
    try {
      if (isInside(destDir, src)) { results.push({ src, error: 'INTO_SELF' }); continue; }
      const sameDir = path.dirname(src) === destDir;
      if (op === 'move' && sameDir) { results.push({ src, path: src }); continue; }
      const target = await uniquePath(destDir, path.basename(src));
      if (op === 'move') {
        try {
          await fsp.rename(src, target);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fsp.cp(src, target, { recursive: true, errorOnExist: true });
          await fsp.rm(src, { recursive: true, force: true });
        }
      } else {
        await fsp.cp(src, target, { recursive: true, errorOnExist: true });
      }
      results.push({ src, path: target });
    } catch (err) {
      results.push({ src, error: err.code || err.message });
    }
  }
  return results;
});

ipcMain.handle('fs:readText', async (_e, file, maxBytes = 256 * 1024) => {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const slice = buf.subarray(0, bytesRead);
    // Treat NUL bytes as a sign of binary content.
    if (slice.subarray(0, 8000).includes(0)) return { binary: true };
    return { text: slice.toString('utf8'), truncated: bytesRead === maxBytes };
  } catch (err) {
    return { error: err.code || err.message };
  } finally {
    await fh?.close();
  }
});

// ---------- search ----------
let searchToken = 0;
ipcMain.handle('fs:search', async (_e, root, query, showHidden) => {
  const token = ++searchToken;
  const q = query.toLowerCase();
  const results = [];
  const queue = [root];
  const deadline = Date.now() + 6000;
  let visited = 0;
  while (queue.length && results.length < 500 && Date.now() < deadline) {
    if (token !== searchToken) return null; // superseded
    const dir = queue.shift();
    visited++;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (!showHidden && isHiddenName(d.name)) continue;
      if (d.isDirectory() && !d.isSymbolicLink() && d.name !== 'node_modules') queue.push(path.join(dir, d.name));
      if (d.name.toLowerCase().includes(q)) results.push(await statEntry(dir, d));
      if (results.length >= 500) break;
    }
  }
  return { entries: results, partial: queue.length > 0, visited };
});

// ---------- drag out ----------
let dragIcon = null;
function getDragIcon() {
  if (dragIcon) return dragIcon;
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x > 5 && x < 27 && y > 3 && y < 29;
      // BGRA: soft blue document
      buf[i] = inside ? 246 : 0; buf[i + 1] = inside ? 158 : 0; buf[i + 2] = inside ? 60 : 0; buf[i + 3] = inside ? 230 : 0;
    }
  }
  dragIcon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  return dragIcon;
}

ipcMain.on('drag:start', (event, files) => {
  if (!files?.length) return;
  event.sender.startDrag({ file: files[0], files, icon: getDragIcon() });
});
