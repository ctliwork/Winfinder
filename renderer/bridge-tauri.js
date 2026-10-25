// Maps the UI's fsApi / pathApi / winApi onto Tauri commands.
// Under Electron the preload script provides these instead and this file does nothing.
(() => {
  const T = window.__TAURI__;
  if (!T) return;
  const { invoke, convertFileSrc, Channel } = T.core;
  const env = window.__finderEnv || {};
  const listen = (name, cb) => T.event.listen(name, cb);
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
    resolveLink: (path) => invoke('resolve_link', { path }).catch(() => null),
    folderCount: (dir) => invoke('folder_count', { dir }),
    thumb: (path, size) => invoke('thumbnail', { path, size: Math.round(size) }).catch(() => null),
    nativeIcon: (path) => invoke('thumbnail', { path, size: 96 }).catch(() => null),
    shellIcon: (path, size) => invoke('thumbnail', { path, size: Math.round(size), icon: true }).catch(() => null),
    open: (path) => invoke('open_path', { path }).then(() => '', (e) => String(e)),
    reveal: (path) => invoke('reveal', { path }),
    trash: (paths) => invoke('trash', { paths }),
    rename: (path, newName) => invoke('rename', { path, newName }).then(ok('path'), fail),
    mkdir: (dir) => invoke('mkdir', { dir }).then(ok('path'), fail),
    newFile: (dir) => invoke('new_file', { dir }).then(ok('path'), fail),
    dirSize: (path, background = false) => invoke('dir_size', { path, background }).catch(() => null),
    cancelDirSizes: () => invoke('cancel_dir_sizes').catch(() => {}),
    compress: (paths) => invoke('compress', { paths }).then(ok('path'), fail),
    extract: (path) => invoke('extract', { path }).then(ok('path'), fail),
    ...(isWin ? {
      nativeMenu: (paths, background, shift, extras) => invoke('native_menu', { paths, background, shift, extras }),
      properties: (paths) => invoke('properties', { paths }),
      clipboardWrite: (paths, cut) => invoke('clipboard_write', { paths, cut }).catch(() => {}),
      clipboardRead: () => invoke('clipboard_read').catch(() => null),
      clipboardClear: () => invoke('clipboard_clear').catch(() => {}),
    } : {}),
    ...(isWin ? {
      previewAvailable: (ext) => invoke('preview_available', { ext }).catch(() => false),
      previewShow: (path, gen, host, inner, dark) => invoke('preview_show', { path, gen, host, inner, dark }).then(() => true, (e) => String(e)),
      previewMove: (host, inner) => invoke('preview_move', { host, inner }).catch(() => {}),
      previewHide: (gen) => invoke('preview_hide', { gen }).catch(() => {}),
      previewWarm: (exts) => invoke('preview_warm', { exts }).catch(() => {}),
    } : {}),
    openTerminal: (dir) => invoke('open_terminal', { dir }).then(() => '', (e) => String(e)),
    transfer: (op, files, dest, conflict) => invoke('transfer', { op, files, dest, conflict }),
    cancelTransfer: () => invoke('cancel_transfer'),
    onTransferProgress: (cb) => listen('transfer-progress', (e) => cb(e.payload)),
    restoreTrash: (paths) => invoke('restore_trash', { paths }).catch(() => paths),
    readText: (path) => invoke('read_text', { path }),
    richPreview: (path) => invoke('rich_preview', { path }),
    mediaInfo: (path) => invoke('media_info', { path }).catch(() => []),
    setKeepRunning: (on) => invoke('set_keep_running', { on }).catch(() => {}),
    setRunAtLogin: (on) => invoke('set_run_at_login', { on }).then(() => '', (e) => String(e)),
    quit: () => invoke('quit'),
    // Another launch asked for a folder (null: just a new tab), or the window was closed into the background.
    onOpenDir: (cb) => listen('open-dir', (e) => cb(e.payload)),
    onHidden: (cb) => listen('window-hidden', () => cb()),
    cloudPin: (paths, state) => invoke('cloud_pin', { paths, state }).catch(() => paths),
    appVersion: () => T.app.getVersion(),
    saveTheme: (theme) => invoke('save_theme', { theme }).catch(() => {}),
    setUiScale: (scale) => invoke('set_ui_scale', { scale }).catch(() => {}),
    checkUpdate: () => invoke('check_update'),
    installUpdate: () => invoke('install_update'),
    onUpdateProgress: (cb) => listen('update-progress', (e) => cb(e.payload)),
    search: (root, query, showHidden, filter) => invoke('search', { root, query, showHidden, filter }),
    everythingAvailable: () => invoke('everything_available').catch(() => false),
    everything: (query) => invoke('everything', { query }).catch(() => null),
    ...(isWin ? { contentSearch: (root, query, filter) => invoke('content_search', { root, query, filter }).catch((e) => ({ error: String(e) })) } : {}),
    watch: (dirs) => { invoke('watch', { dirs }).catch(() => {}); },
    onChanged: (cb) => listen('fs-changed', (e) => cb(e.payload)),
    // Resolves when the drag is over (dropped anywhere or cancelled).
    startDrag: (files) => {
      dragImage ||= makeDragImage();
      return invoke('plugin:drag|start_drag', { item: files, image: dragImage, options: { mode: 'copy' }, onEvent: new Channel() })
        .catch((e) => console.warn('drag failed', e));
    },
    listMany: (dirs, depth) => invoke('list_many', { dirs, depth }).catch(() => []),
    pathForFile: () => '',
  };

  // ---------- window ----------
  const win = T.window.getCurrentWindow();
  window.winApi = {
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    snapLayouts: () => invoke('snap_layouts').catch(() => {}),
    close: () => win.close(),
    setTheme: (theme) => win.setTheme(theme === 'system' ? null : theme).catch(() => {}),
    onState: (cb) => {
      const update = async () => cb({ maximized: await win.isMaximized() });
      win.onResized(update);
      update();
    },
  };
  // Started at sign-in: stay hidden until opened from the notification area or launched again.
  window.__finderReady = () => { if (!env.background) win.show(); };

  // Native drag regions: Tauri only honours the attribute on the element itself.
  for (const sel of ['#sidebar', '.sb-top', '#tabbar', '#tabs', '.tb-drag', '#toolbar', '#title-wrap', '#title', '#toolbar .spacer']) {
    document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-tauri-drag-region', ''));
  }

  // ---------- drops (OS files and our own drags) ----------
  T.webview.getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    const d = window.__finderDnd;
    if (!d) return;
    if (p.type === 'leave') { d.leave(); return; }
    const pos = p.position ? { x: p.position.x / devicePixelRatio, y: p.position.y / devicePixelRatio } : null;
    if (p.type === 'enter' || p.type === 'over') d.over(pos.x, pos.y);
    else if (p.type === 'drop') d.drop(pos.x, pos.y, p.paths || []);
  });
})();
