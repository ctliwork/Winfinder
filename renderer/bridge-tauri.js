// Maps the UI's fsApi / pathApi / winApi onto Tauri commands.
// Under Electron the preload script provides these instead and this file does nothing.
(() => {
  const T = window.__TAURI__;
  if (!T) return;
  const { invoke, convertFileSrc, Channel } = T.core;
  const env = window.__finderEnv || {};
  const sep = env.sep || '/';
  const isWin = sep === '\\';

  // ---------- paths ----------
  function root(p) {
    if (isWin) {
      const drive = /^[A-Za-z]:\\?/.exec(p);
      if (drive) return drive[0].endsWith('\\') ? drive[0] : `${drive[0]}\\`;
      const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(p);
      if (unc) return unc[0].endsWith('\\') ? unc[0] : `${unc[0]}\\`;
      return '';
    }
    return p.startsWith('/') ? '/' : '';
  }
  function trimEnd(p) {
    const r = root(p);
    let q = p;
    while (q.length > r.length && q.endsWith(sep)) q = q.slice(0, -1);
    return q;
  }
  function dirname(p) {
    const q = trimEnd(p);
    const r = root(q);
    if (q === r) return q;
    const i = q.lastIndexOf(sep);
    return i < r.length ? r : q.slice(0, i);
  }
  function basename(p) {
    const q = trimEnd(p);
    return q === root(q) ? '' : q.slice(q.lastIndexOf(sep) + 1);
  }
  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
  }
  const join = (...parts) => parts.reduce((a, b) => (!a ? b : a.endsWith(sep) ? a + b : a + sep + b), '');

  window.pathApi = { sep, join, dirname, basename, extname, root, fileUrl: (p) => convertFileSrc(p) };

  // ---------- drag out ----------
  let dragImage = null;
  function makeDragImage() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 8, 0, 56);
    grad.addColorStop(0, '#8fd0ff');
    grad.addColorStop(1, '#3d9cf3');
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(6, 12, 52, 42, 7);
    g.fill();
    return c.toDataURL('image/png');
  }

  // ---------- files ----------
  const ok = (key) => (value) => ({ ok: true, [key]: value });
  const fail = (error) => ({ ok: false, error: String(error) });

  window.fsApi = {
    places: () => invoke('places').then((p) => ({ ...p, pinnedLive: p.pinned_live })),
    pinHome: (path, pin) => invoke('pin_home', { path, pin }),
    list: (dir) => invoke('list_dir', { dir }).then(ok('entries'), fail),
    diskFree: (path) => invoke('disk_free', { path }),
    diskSpace: (path) => invoke('disk_space', { path }),
    recentFiles: () => invoke('recent_files'),
    folderCount: (dir) => invoke('folder_count', { dir }),
    thumb: (path, size) => invoke('thumbnail', { path, size: Math.round(size) }).catch(() => null),
    nativeIcon: (path) => invoke('thumbnail', { path, size: 96 }).catch(() => null),
    folderIcon: (path, size) => invoke('thumbnail', { path, size: Math.round(size), icon: true }).catch(() => null),
    open: (path) => invoke('open_path', { path }).then(() => '', (e) => String(e)),
    reveal: (path) => invoke('reveal', { path }),
    trash: (paths) => invoke('trash', { paths }),
    rename: (path, newName) => invoke('rename', { path, newName }).then(ok('path'), fail),
    mkdir: (dir) => invoke('mkdir', { dir }).then(ok('path'), fail),
    transfer: (op, files, dest) => invoke('transfer', { op, files, dest }),
    readText: (path) => invoke('read_text', { path }),
    richPreview: (path) => invoke('rich_preview', { path }),
    appVersion: () => T.app.getVersion(),
    checkUpdate: () => invoke('check_update'),
    installUpdate: () => invoke('install_update'),
    onUpdateProgress: (cb) => T.event.listen('update-progress', (e) => cb(e.payload)),
    search: (root, query, showHidden) => invoke('search', { root, query, showHidden }),
    watch: (dirs) => { invoke('watch', { dirs }).catch(() => {}); },
    onChanged: (cb) => T.event.listen('fs-changed', (e) => cb(e.payload)),
    startDrag: (files) => {
      dragImage ||= makeDragImage();
      invoke('plugin:drag|start_drag', { item: files, image: dragImage, options: { mode: 'copy' }, onEvent: new Channel() })
        .catch((e) => console.warn('drag failed', e));
    },
    pathForFile: () => '',
  };

  // ---------- window ----------
  const win = T.window.getCurrentWindow();
  window.winApi = {
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    onState: (cb) => {
      const update = async () => cb({ maximized: await win.isMaximized() });
      win.onResized(update);
      update();
    },
  };
  window.__finderReady = () => win.show();

  // Native drag regions: Tauri only honours the attribute on the element itself.
  for (const sel of ['#sidebar', '.sb-top', '#tabbar', '#tabs', '.tb-drag', '#toolbar', '#title-wrap', '#title', '#toolbar .spacer']) {
    document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-tauri-drag-region', ''));
  }

  // ---------- drops (OS files and our own drags) ----------
  T.webview.getCurrentWebview().onDragDropEvent((event) => {
    const d = window.__finderDnd;
    if (!d) return;
    const p = event.payload;
    const pos = p.position ? { x: p.position.x / devicePixelRatio, y: p.position.y / devicePixelRatio } : null;
    if (p.type === 'enter' || p.type === 'over') d.over(pos.x, pos.y);
    else if (p.type === 'drop') d.drop(pos.x, pos.y, p.paths || []);
    else d.leave();
  });
})();
