(() => {
  const api = window.fsApi;
  const P = window.pathApi;
  const W = window.winApi;
  const I = window.Icons;
  const esc = I.esc;

  // Tauri injects __finderEnv; the Electron shell passes the same values as URL params.
  const env = window.__finderEnv || Object.fromEntries(new URLSearchParams(location.search));
  const platform = env.platform;
  const isWin = platform === 'win32';
  const isTauri = !!window.__TAURI__;
  document.body.classList.add(`platform-${platform}`, `material-${env.material || 'none'}`);

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });

  // ---------- preferences ----------
  const PREF_KEY = 'finder-win:prefs';
  const prefs = Object.assign({
    view: 'columns', icon: 72, sidebarW: 220, showHidden: false,
    sort: { key: 'name', dir: 1 }, accent: '#0a84ff', favorites: [], sidebarHidden: false,
    // Settings page
    startup: 'restore', startDir: '', newTab: 'home', theme: 'system', density: 'normal',
    showExt: true, foldersFirst: true, sizeBase: 1000, confirmTrash: false, autoUpdate: true, colPreview: true,
    rememberView: true, folderViews: {}, menuStyle: 'windows', calcSizes: false, smart: [], uiScale: 1, nativePreview: true,
    keepRunning: true, runAtLogin: false,
  }, readPrefs());
  // Like Finder, reopen the last tabs. Earlier versions saved 'home' as the
  // default, so move that over once.
  if (!prefs.sessionV) { if (prefs.startup === 'home') prefs.startup = 'restore'; prefs.sessionV = 1; }
  function readPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ } }

  const ACCENTS = [
    ['#0a84ff', '藍色'], ['#a550a7', '紫色'], ['#f74f9e', '粉紅色'], ['#ff5257', '紅色'],
    ['#f7821b', '橘色'], ['#ffc600', '黃色'], ['#62ba46', '綠色'], ['#8c8c8c', '石墨色'],
  ];

  // ---------- state ----------
  const HOME = '::home';
  // Shared by all tabs.
  const G = { places: null, clip: null, renaming: null, dragging: null, space: new Map(), treeOpen: new Set(prefs.treeOpen || []) };
  // One per tab; `state` always points at the active tab.
  let tabSeq = 0;
  function newTabState() {
    return {
      id: ++tabSeq,
      cwd: null,
      history: [],
      hIndex: -1,
      entries: [],          // what the views show (sorted + filtered)
      homeItems: [],
      sel: new Set(),       // selected paths
      anchor: null,
      focus: null,
      colRoot: null,
      colActive: 0,
      colLists: [],
      search: { query: '', scope: 'folder', results: null, busy: false, filters: {} },
      scroll: 0,
      view: null,           // this tab's view; null = the default (prefs.view)
    };
  }
  let state = newTabState();
  const tabs = [state];
  const dirCache = new Map();
  const thumbCache = new Map();

  const content = $('#content');
  const view = $('#view');

  // ---------- helpers ----------
  const norm = (p) => (isWin ? p.toLowerCase() : p);
  function isUnder(p, root) {
    if (!p || !root) return false;
    const a = norm(p); const b = norm(root);
    if (a === b) return true;
    return a.startsWith(b.endsWith(P.sep) ? b : b + P.sep);
  }
  // One spelling per folder: "C:\Users\me\" and "C:/Users/me" are both
  // "C:\Users\me" (a drive root keeps its separator). Mixed spellings made the
  // column view lose its first column and restart at the drive.
  function canon(p) {
    if (!p || p === HOME) return p;
    let q = isWin ? p.replace(/\//g, '\\') : p;
    const r = P.root(q);
    while (q.length > r.length && q.endsWith(P.sep)) q = q.slice(0, -1);
    return q;
  }
  function ancestors(dir, root) {
    dir = canon(dir);
    root = canon(root);
    const chain = [dir];
    let cur = dir;
    while (norm(cur) !== norm(root)) {
      const parent = P.dirname(cur);
      if (parent === cur) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }
  function baseName(p) { return P.basename(p) || p; }
  function namedPlaces() {
    const g = G.places;
    return g ? [...g.favorites, ...(g.pinned || []), ...(g.cloud || []), ...g.locations] : [];
  }
  function displayName(p) {
    const hit = namedPlaces().find((f) => norm(f.path) === norm(p));
    return hit ? hit.label : baseName(p);
  }
  // Folders pinned in the navigation pane: Explorer's Quick Access list plus
  // any pins kept by this app (used when Explorer's list can't be changed).
  function pinnedPlaces() {
    const list = [...(G.places?.pinned || [])];
    for (const p of prefs.favorites) {
      if (!list.some((f) => norm(f.path) === norm(p))) list.push({ path: p, label: baseName(p), icon: 'folder', custom: true });
    }
    return list;
  }
  function isPinned(p) { return pinnedPlaces().some((f) => norm(f.path) === norm(p)); }
  function specialBadge(p) {
    const fav = G.places?.favorites.find((f) => norm(f.path) === norm(p));
    return fav ? fav.icon : null;
  }

  // Name as shown in the views: without the extension when that's turned off.
  function shownName(e) {
    if (prefs.showExt || e.isDir || !e.ext) return e.name;
    const i = e.name.lastIndexOf('.');
    return i > 0 ? e.name.slice(0, i) : e.name;
  }

  function fmtSize(bytes) {
    if (bytes == null) return '--';
    const base = prefs.sizeBase === 1024 ? 1024 : 1000; // 1024 matches Explorer
    if (bytes < base) return `${bytes} 位元組`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes; let u = -1;
    do { v /= base; u++; } while (v >= base && u < units.length - 1);
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
  }
  const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });
  function fmtDate(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = (today - new Date(d).setHours(0, 0, 0, 0)) / 86400000;
    if (diff === 0) return `今天 ${timeFmt.format(d)}`;
    if (diff === 1) return `昨天 ${timeFmt.format(d)}`;
    return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
  }
  const ERRORS = {
    EACCES: '沒有權限', EPERM: '沒有權限', ENOENT: '找不到項目', EBUSY: '檔案正在使用中',
    EXISTS: '已有相同名稱的項目', INVALID: '名稱包含無效字元', INTO_SELF: '不能把資料夾移到它自己裡面',
    ENOTDIR: '不是資料夾', timeout: '逾時',
    NO_7ZIP: '需要安裝 7-Zip', PASSWORD: '這個壓縮檔有密碼保護', BAD_ARCHIVE: '無法讀取這個壓縮檔',
  };
  const errText = (code) => ERRORS[code] || code;

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- data ----------
  async function listDir(dir, force = false) {
    if (!force && dirCache.has(dir)) return dirCache.get(dir);
    const res = await api.list(dir);
    const value = res.ok ? { entries: res.entries } : { entries: [], error: res.error };
    dirCache.set(dir, value);
    return value;
  }

  // Per-folder view and sort, like Explorer and Finder: a folder keeps the
  // view it was last shown in; others use the defaults.
  function folderPref(dir = state.cwd) {
    return prefs.rememberView && dir && dir !== HOME ? prefs.folderViews[norm(dir)] : null;
  }
  function curView() { return state.view || prefs.view; }
  function curSort() { return (!state.search.results && folderPref()?.sort) || prefs.sort; }
  function rememberFolder(patch) {
    const k = norm(state.cwd);
    const next = { ...prefs.folderViews[k], ...patch };
    delete prefs.folderViews[k];
    prefs.folderViews[k] = next; // most recent last
    const keys = Object.keys(prefs.folderViews);
    if (keys.length > 500) delete prefs.folderViews[keys[0]];
  }
  function setSort(sort) {
    if (folderPref() !== null && !state.search.results) rememberFolder({ sort }); else prefs.sort = sort;
    savePrefs();
    flipIcons(async () => { computeEntries(); await render(); });
  }

  // Icon view (Finder): when the order or the icon size changes, items glide
  // from where they were to where they go instead of jumping.
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  async function flipIcons(change) {
    if (viewMode() !== 'icons' || calm.matches) { await change(); return; }
    const before = new Map();
    for (const el of $$('.gi[data-i]', view)) {
      const e = state.entries[Number(el.dataset.i)];
      if (e) before.set(e.path, el.getBoundingClientRect());
    }
    await change();
    if (viewMode() !== 'icons' || before.size > 600) return;
    for (const el of $$('.gi[data-i]', view)) {
      const e = state.entries[Number(el.dataset.i)];
      const b = e && before.get(e.path);
      if (!b) continue;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left; const dy = b.top - a.top; const k = b.width / a.width;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(k - 1) < 0.01) continue;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${k})`, transformOrigin: 'top left' },
        { transform: 'none', transformOrigin: 'top left' },
      ], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  function sortEntries(list) {
    const { key, dir } = curSort();
    const cmp = {
      name: (a, b) => collator.compare(a.name, b.name),
      date: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      size: (a, b) => sizeOf(a) - sizeOf(b),
      kind: (a, b) => collator.compare(I.kindLabel(a), I.kindLabel(b)),
      created: (a, b) => (a.birth || 0) - (b.birth || 0),
      ext: (a, b) => collator.compare(a.ext || '', b.ext || ''),
    }[key] || ((a, b) => collator.compare(a.name, b.name));
    return list.slice().sort((a, b) => {
      if (prefs.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return (cmp(a, b) || collator.compare(a.name, b.name)) * dir;
    });
  }

  // Folder sizes computed on request (menu or preview pane), by path.
  const dirSizes = new Map();
  function sizeOf(e) { return e.isDir ? dirSizes.get(norm(e.path))?.size ?? -1 : e.size || 0; }

  // Like Explorer: hidden items follow "show hidden"; protected operating
  // system items (hidden + system) have their own, separate switch.
  function isShown(e) {
    if (e.system && !prefs.showSystem) return false;
    return prefs.showHidden || !e.hidden;
  }

  function visibleOf(entries) {
    const list = entries.filter(isShown);
    return sortEntries(list);
  }

  function computeEntries() {
    const q = state.search.query.trim().toLowerCase();
    if (state.cwd === HOME && !state.search.results) {
      state.entries = q ? state.homeItems.filter((e) => e.name.toLowerCase().includes(q)) : state.homeItems.slice();
    } else if (state.search.results) {
      state.entries = sortEntries(state.search.results.filter((e) => isShown(e) && passesFilters(e)));
    } else {
      let list = visibleOf(dirCache.get(state.cwd)?.entries || []);
      if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
      state.entries = list.filter(passesFilters);
    }
    // Grouped views list each group together (stable, so the sort holds inside).
    if (state.cwd !== HOME && curGroup() !== 'none' && ['list', 'icons'].includes(viewMode())) {
      const keyed = state.entries.map((e) => [groupOf(e), e]);
      keyed.sort((a, b) => a[0].order - b[0].order || collator.compare(a[0].label, b[0].label));
      state.entries = keyed.map(([, e]) => e);
    }
  }

  // Search filters (type, size, modified date) from the bar under the toolbar.
  const KIND_FILTER = {
    dir: (e) => e.isDir,
    image: (e) => I.category(e.ext) === 'image',
    video: (e) => I.category(e.ext) === 'video',
    audio: (e) => I.category(e.ext) === 'audio',
    docs: (e) => ['pdf', 'doc', 'sheet', 'slide', 'text'].includes(I.category(e.ext)),
    archive: (e) => I.category(e.ext) === 'archive',
    code: (e) => I.category(e.ext) === 'code',
    app: (e) => ['exe', 'msi', 'lnk', 'bat', 'cmd', 'appref-ms'].includes(e.ext),
  };
  const SIZE_FILTER = { lt100k: (n) => n < 100e3, gt1m: (n) => n > 1e6, gt100m: (n) => n > 100e6, gt1g: (n) => n > 1e9 };
  function passesFilters(e) {
    const f = state.search.filters || {};
    if (state.cwd === HOME && !state.search.results) return true;
    if (f.kind && !KIND_FILTER[f.kind](e)) return false;
    if (f.size && (e.isDir || !SIZE_FILTER[f.size](e.size || 0))) return false;
    if (f.date && (e.mtime || 0) < Date.now() - Number(f.date) * DAY) return false;
    return true;
  }
  function filtersOn() { return Object.values(state.search.filters || {}).some(Boolean); }

  // ---------- grouping (like Explorer's 分組依據) ----------
  function curGroup() { return (!state.search.results && folderPref()?.group) || prefs.groupBy || 'none'; }
  function setGroup(group) {
    if (folderPref() !== null && !state.search.results) rememberFolder({ group }); else prefs.groupBy = group;
    savePrefs();
    flipIcons(async () => { computeEntries(); await render(); });
  }
  const DAY = 86400000;
  function groupOf(e) {
    const g = curGroup();
    if (g === 'kind') return e.isDir ? { order: 0, label: '資料夾' } : { order: 1, label: I.kindLabel(e) };
    if (g === 'size') {
      if (e.isDir) return { order: 0, label: '資料夾' };
      const n = e.size || 0;
      const tiers = [[0, '空白'], [16e3, '微小（16 KB 以下）'], [1e6, '小（1 MB 以下）'], [128e6, '中（128 MB 以下）'], [1e9, '大（1 GB 以下）'], [4e9, '巨大（4 GB 以下）']];
      const i = tiers.findIndex(([max]) => n <= max);
      return i < 0 ? { order: 7, label: '超大（超過 4 GB）' } : { order: i + 1, label: tiers[i][1] };
    }
    // date: newest first, Explorer's buckets
    const t = e.mtime || 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    const weekStart = t0 - ((today.getDay() + 6) % 7) * DAY; // Monday
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime();
    const yearStart = new Date(today.getFullYear(), 0, 1).getTime();
    const buckets = [
      [t >= t0 + DAY, '未來'], [t >= t0, '今天'], [t >= t0 - DAY, '昨天'], [t >= weekStart, '本週稍早'],
      [t >= weekStart - 7 * DAY, '上週'], [t >= monthStart, '本月稍早'], [t >= lastMonth, '上個月'], [t >= yearStart, '今年稍早'],
    ];
    const i = buckets.findIndex(([hit]) => hit);
    return i < 0 ? { order: 9, label: '很久以前' } : { order: i, label: buckets[i][1] };
  }
  // Group header markup to put before item i (empty when the group continues).
  function groupHead(items, i, counts, cls) {
    if (curGroup() === 'none' || state.cwd === HOME) return '';
    const g = groupOf(items[i]);
    if (i > 0 && groupOf(items[i - 1]).label === g.label) return '';
    return `<div class="${cls}">${esc(g.label)}<span>${counts.get(g.label)}</span></div>`;
  }
  function groupCounts(items) {
    const m = new Map();
    if (curGroup() !== 'none') for (const e of items) { const l = groupOf(e).label; m.set(l, (m.get(l) || 0) + 1); }
    return m;
  }

  // ---------- list columns ----------
  const LIST_COLS = {
    date: { label: '修改日期', w: 170, cell: (e) => fmtDate(e.mtime) },
    created: { label: '建立日期', w: 170, cell: (e) => fmtDate(e.birth) },
    size: { label: '大小', w: 96, cell: (e) => (e.isDir ? (dirSizes.has(norm(e.path)) ? fmtSize(dirSizes.get(norm(e.path)).size) : '--') : fmtSize(e.size)) },
    kind: { label: '類型', w: 150, cell: (e) => esc(I.kindLabel(e)) },
    ext: { label: '副檔名', w: 80, cell: (e) => (e.isDir ? '' : esc(e.ext)) },
  };
  function listCols() { return (prefs.listCols || ['date', 'size', 'kind']).filter((k) => LIST_COLS[k]); }
  function listTemplate() {
    const w = prefs.listW || {};
    return [w.name ? `${w.name}px` : 'minmax(200px, 1fr)', ...listCols().map((k) => `${w[k] || LIST_COLS[k].w}px`)].join(' ');
  }
  function toggleListCol(k) {
    const cols = listCols();
    prefs.listCols = cols.includes(k) ? cols.filter((c) => c !== k) : Object.keys(LIST_COLS).filter((c) => c === k || cols.includes(c));
    savePrefs();
    render();
  }
  function listHeaderMenu(x, y) {
    const groups = [['none', '無'], ['kind', '類型'], ['date', '修改日期'], ['size', '大小']];
    openMenu([
      ...(api.dirSize ? [{ label: '計算所有大小', check: !!prefs.calcSizes, action: toggleCalcSizes }, '-'] : []),
      { html: '<div class="mlabel">顯示的欄位</div>' },
      ...Object.entries(LIST_COLS).map(([k, c]) => ({ label: c.label, check: listCols().includes(k), action: () => toggleListCol(k) })),
      '-',
      { html: '<div class="mlabel">分組依據</div>' },
      ...groups.map(([g, l]) => ({ label: l, check: curGroup() === g, action: () => setGroup(g) })),
      '-',
      { label: '還原欄寬', action: () => { prefs.listW = {}; savePrefs(); render(); } },
    ], x, y);
  }

  // Finder's 計算所有大小: the list view fills in folder sizes in the
  // background, two at a time, and stops when the folder is left.
  const sizeJob = { key: null, running: false };
  function sizeFresh(e) { const c = dirSizes.get(norm(e.path)); return c && c.mtime === e.mtime; }
  function queueFolderSizes() {
    const key = viewMode() === 'list' && prefs.calcSizes && api.dirSize && state.cwd !== HOME
      ? `${state.id}|${state.cwd}|${state.search.results ? state.search.query : ''}` : null;
    if (key === sizeJob.key && sizeJob.running) return;
    if (sizeJob.running) api.cancelDirSizes?.();
    sizeJob.key = key;
    sizeJob.running = false;
    if (!key) return;
    const todo = state.entries.filter((e) => e.isDir && !isVirtual(e) && !sizeFresh(e));
    if (!todo.length) return;
    sizeJob.running = true;
    let next = 0;
    let busy = 2;
    const worker = async () => {
      while (sizeJob.key === key && next < todo.length) {
        const e = todo[next++];
        const r = await api.dirSize(e.path, true);
        if (sizeJob.key !== key) return;
        if (r) { dirSizes.set(norm(e.path), { ...r, mtime: e.mtime }); paintSize(e); }
      }
      if (--busy === 0 && sizeJob.key === key) sizeJob.running = false;
    };
    worker(); worker();
  }
  // Fills one row's size cell; a list sorted by size re-sorts once things settle.
  function paintSize(e) {
    const i = listCols().indexOf('size');
    const row = i >= 0 && elForPath(e.path);
    if (row?.classList.contains('lrow')) row.children[i + 1].innerHTML = LIST_COLS.size.cell(e);
    if (curSort().key === 'size') {
      clearTimeout(paintSize.t);
      paintSize.t = setTimeout(() => { if (viewMode() === 'list') { computeEntries(); renderView(false); } }, 400);
    }
    if (state.focus === e.path) updatePane();
  }
  function toggleCalcSizes() {
    prefs.calcSizes = !prefs.calcSizes;
    savePrefs();
    queueFolderSizes();
  }

  function entryOf(p) {
    const parent = dirCache.get(P.dirname(p));
    const found = parent?.entries.find((e) => e.path === p);
    if (found) return found;
    return state.entries.find((e) => e.path === p) || null;
  }

  // What the content area shows: Home has its own page, search results never use columns.
  function viewMode() {
    if (state.cwd === HOME && !state.search.results) return 'home';
    if (state.search.results && curView() === 'columns') return 'list';
    return curView();
  }
  function inColumnsMode() { return viewMode() === 'columns'; }
  const isVirtual = (e) => e.kind === 'pinned' || e.kind === 'drive';

  function selectedEntries() {
    if (inColumnsMode()) {
      const chain = ancestors(state.cwd, state.colRoot);
      if (state.colActive < chain.length - 1) {
        const e = entryOf(chain[state.colActive + 1]);
        return e ? [e] : [];
      }
    }
    return state.entries.filter((e) => state.sel.has(e.path));
  }

  // ---------- navigation ----------
  function guessRoot(dir) {
    let best = null;
    for (const f of [...namedPlaces().filter((f) => !G.places.locations.includes(f)), ...pinnedPlaces()]) {
      if (isUnder(dir, f.path) && (!best || f.path.length > best.length)) best = f.path;
    }
    return best || P.root(dir);
  }

  async function loadHome() {
    const favs = pinnedPlaces().map((f) => ({ path: f.path, name: f.label, badge: f.icon === 'folder' ? null : f.icon, custom: !!f.custom }));
    const pinned = favs.map((f) => ({ ...f, isDir: true, ext: '', kind: 'pinned' }));
    const drives = G.places.locations.map((l) => ({ name: l.label, path: l.path, isDir: true, ext: '', kind: 'drive' }));
    let recent = [];
    try { recent = (await api.recentFiles()).map((e) => ({ ...e, kind: 'recent' })); } catch { /* not available */ }
    state.homeItems = [...pinned, ...drives, ...recent];
  }

  async function navigate(dir, opts = {}) {
    const { push = true, select = null, colActive = null, animate = true, silent = false } = opts;
    dir = canon(dir);
    const root = canon(opts.root || null);
    if (dir === HOME) {
      await loadHome();
    } else {
      // During a drag, use what was read ahead (see startNativeDrag).
      const res = await listDir(dir, !(G.dragActive && dirCache.has(dir)));
      if (res.error) {
        toast(`無法打開「${displayName(dir)}」：${errText(res.error)}`);
        return false;
      }
    }
    if (push && norm(dir) !== norm(state.cwd || '')) {
      state.history = state.history.slice(0, state.hIndex + 1);
      state.history.push(dir);
      state.hIndex = state.history.length - 1;
    }
    const prev = state.cwd;
    const changed = norm(prev || '') !== norm(dir);
    state.cwd = dir;
    if (changed) clearSearch(false, silent);
    if (dir === HOME) state.colRoot = null;
    else if (root) state.colRoot = root;
    else if (!state.colRoot || !isUnder(dir, state.colRoot)) state.colRoot = guessRoot(dir);
    state.colRoot = canon(state.colRoot);

    // Clicking through columns keeps the column view; other navigation shows
    // the folder the way it was last left.
    if (colActive == null && dir !== HOME) state.view = folderPref(dir)?.view || prefs.view;
    const chainLen = dir === HOME ? 1 : ancestors(dir, state.colRoot).length;
    state.colActive = colActive ?? chainLen - 1;

    state.sel.clear();
    let target = select;
    if (!target && prev && prev !== HOME && dir !== HOME && changed && norm(P.dirname(prev)) === norm(dir)) target = prev; // went up: highlight where we came from
    if (target && !inColumnsMode()) { state.sel.add(target); state.anchor = target; state.focus = target; }
    else if (target && inColumnsMode() && state.colActive === chainLen - 1) { state.sel.add(target); state.anchor = target; state.focus = target; }
    else { state.anchor = null; state.focus = null; }

    computeEntries();
    if (dir !== HOME && prefs.lastDir !== dir) { prefs.lastDir = dir; savePrefs(); }
    if (silent) return true;
    await render({ animate: animate && changed });
    watchCurrent();
    return true;
  }

  function goBack() { if (state.hIndex > 0) { state.hIndex--; navigate(state.history[state.hIndex], { push: false }); } }
  function goForward() { if (state.hIndex < state.history.length - 1) { state.hIndex++; navigate(state.history[state.hIndex], { push: false }); } }
  function goUp() {
    if (state.cwd === HOME) return;
    const parent = P.dirname(state.cwd);
    if (parent === state.cwd) { navigate(HOME); return; } // drive root: up goes to Home, like Explorer
    navigate(parent, { select: state.cwd, root: isUnder(parent, state.colRoot) ? null : P.root(parent) });
  }

  function watchCurrent() {
    if (state.cwd === HOME) { api.watch([]); return; }
    const dirs = inColumnsMode() ? ancestors(state.cwd, state.colRoot) : [state.cwd];
    api.watch(dirs);
  }

  let refreshQueued = new Set();
  let refreshTimer = null;
  api.onChanged((dir) => {
    refreshQueued.add(dir);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(flushRefresh, 80);
  });
  async function flushRefresh() {
    if (G.renaming) { refreshTimer = setTimeout(flushRefresh, 400); return; }
    const dirs = [...refreshQueued];
    refreshQueued = new Set();
    await Promise.all(dirs.map((d) => listDir(d, true)));
    await refresh(false);
  }

  async function refresh(reload = true) {
    if (state.cwd === HOME) {
      if (reload) await loadHome();
      computeEntries();
      await render({ animate: false });
      return;
    }
    if (reload) await listDir(state.cwd, true);
    const valid = new Set((dirCache.get(state.cwd)?.entries || []).map((e) => e.path));
    if (!state.search.results) for (const p of [...state.sel]) if (!valid.has(p)) state.sel.delete(p);
    computeEntries();
    await render({ animate: false });
  }

  // ---------- rendering ----------
  let thumbObserver = null;

  async function render({ animate = false } = {}) {
    document.body.className = document.body.className.replace(/\bview-\S+/g, '').trim();
    document.body.classList.add(`view-${viewMode()}`);
    renderTabs();
    renderToolbar();
    renderSidebar();
    await renderView(animate);
    warmPreviews();
    renderPathbar();
    renderStatus();
    updatePane();
    fillShellIcons();
  }

  function renderToolbar() {
    const title = $('#title');
    const text = tabTitle(state);
    if (title.textContent !== text) {
      title.textContent = text;
      title.classList.remove('anim'); void title.offsetWidth; title.classList.add('anim');
    }
    document.title = text;
    $('#btn-back').disabled = state.hIndex <= 0;
    $('#btn-fwd').disabled = state.hIndex >= state.history.length - 1;
    const buttons = $$('#view-seg [data-view]');
    buttons.forEach((b, i) => {
      const on = b.dataset.view === curView();
      b.classList.toggle('active', on);
      if (on) $('#view-seg .seg-pill').style.transform = `translateX(${i * 38}px)`;
    });
  }

  function subdirs(p) {
    const c = dirCache.get(p);
    if (!c || c.error) return null;
    return sortEntries(c.entries.filter((e) => e.isDir && isShown(e)));
  }

  // Explorer-style navigation tree: Home, pinned folders, drives; folders expand in place.
  // Laid out like Explorer's navigation pane: Home, OneDrive, the Quick Access
  // pins, then This PC with its drives.
  const PC = '::pc';
  function renderSidebar() {
    if (!G.places) return;
    const nav = $('#places');
    const scroll = nav.scrollTop;
    const active = state.search.smart ? '' : norm(state.cwd || '');
    const chev = '<svg viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
    const pin = '<svg class="pin" viewBox="0 0 12 12"><path d="M7.6 1.5l2.9 2.9-1.4.5-1.9 1.9.2 2.4-.9.9-2-2-2.6 2.6M3.3 4.4l.9-.9 2.4.2 1.9-1.9z"/></svg>';
    const missing = [];
    const row = (p, label, icon, lvl, extra = '', tail = '') => {
      const open = G.treeOpen.has(p);
      const kids = subdirs(p);
      if (open && !kids) missing.push(p);
      const leaf = kids && kids.length === 0;
      let html = `<div class="place${norm(p) === active ? ' active' : ''}" data-path="${esc(p)}" style="--lvl:${lvl}" ${extra}>
        <span class="twisty${open && !leaf ? ' open' : ''}${leaf ? ' none' : ''}" data-twisty="${esc(p)}">${chev}</span>
        ${winIcons() ? shellIco(p, 16, I.sidebar(icon)) : I.sidebar(icon)}<span>${esc(label)}</span>${tail}</div>`;
      if (open && kids) html += kids.map((k) => row(k.path, k.name, 'folder', lvl + 1)).join('');
      return html;
    };
    const cloud = (G.places.cloud || []).map((c) => row(c.path, c.label, 'cloud', 0)).join('');
    const pinned = pinnedPlaces().map((f) => row(f.path, f.label, f.icon, 0, `data-pinned="1"${f.custom ? ' data-custom="1"' : ''}`, pin)).join('');
    const smart = (prefs.smart || []).map((sf) => `<div class="place${state.search.smart === sf.id ? ' active' : ''}" data-smart="${esc(sf.id)}" style="--lvl:0" title="${esc(smartDesc(sf))}">
        <span class="twisty none"></span>${I.sidebar('smart')}<span>${esc(sf.name)}</span></div>`).join('');
    const pcOpen = !prefs.pcCollapsed;
    const drives = pcOpen ? G.places.locations.map((l) => row(l.path, l.label, 'drive', 1)).join('') : '';
    nav.innerHTML = `
      <div class="place home-row${state.cwd === HOME ? ' active' : ''}" data-path="${HOME}">
        <span class="twisty none"></span>${folderIco(HOME, 16)}<span>常用</span></div>
      ${cloud}
      ${pinned ? `<div class="nav-sep"></div>${pinned}` : ''}
      ${smart ? `<div class="nav-sep"></div>${smart}` : ''}
      <div class="nav-sep"></div>
      <div class="place" data-path="${PC}"><span class="twisty${pcOpen ? ' open' : ''}" data-twisty="${PC}">${chev}</span>${shellIco(SHELL_PC, 16, I.sidebar('pc'))}<span>本機</span></div>
      ${drives}`;
    nav.scrollTop = scroll;
    fillShellIcons(nav);
    if (missing.length) Promise.all(missing.map((p) => listDir(p))).then(renderSidebar);
  }

  function toggleTree(p) {
    if (p === PC) { prefs.pcCollapsed = !prefs.pcCollapsed; savePrefs(); renderSidebar(); return; }
    G.treeOpen.has(p) ? G.treeOpen.delete(p) : G.treeOpen.add(p);
    prefs.treeOpen = [...G.treeOpen];
    savePrefs();
    renderSidebar();
  }

  // Windows look: files, folders and drives show the icon Explorer shows (an
  // app's own icon, file-type icons, special or custom folder icons). Small
  // sizes always use the icon, like Explorer's details view; large views keep
  // thumbnails for photos, videos and documents. The ⋯ menu switches back to
  // the Finder look.
  function winIcons() { return isWin && !!api.shellIcon && prefs.folderIcons !== 'finder'; }
  // Most types share one icon per extension; these carry their own.
  const OWN_ICON = new Set(['exe', 'lnk', 'ico', 'url', 'cur', 'ani', 'scr', 'cpl', 'msc', 'appref-ms', 'website']);
  const shellCache = new Map(); // key -> data URL, or null when Windows has none
  const shellPending = new Map();
  function shellKey(p, px, ext) { return ext && !OWN_ICON.has(ext) ? `.${ext}|${px}` : `${norm(p)}|${px}`; }
  // `ext` is set for files; folders, drives and shell places pass none.
  function shellIco(p, px, fallback, ext = '') {
    if (!winIcons() || !p) return fallback;
    const hit = shellCache.get(shellKey(p, px, ext));
    if (hit) return `<img class="fico" src="${hit}" draggable="false">`;
    if (hit === null) return fallback;
    return `<span class="fpend" data-ficon="${esc(p)}" data-px="${px}" data-ext="${esc(ext)}">${fallback}</span>`;
  }
  function folderIco(p, px, badge = specialBadge(p)) {
    return shellIco(p === HOME ? SHELL_HOME : p, px, p === HOME ? I.sidebar('home') : I.folder(badge));
  }
  function fileIco(e, px) { return e.isDir ? folderIco(e.path, px) : shellIco(e.path, px, I.file(e.ext), e.ext || '.'); }
  const SHELL_HOME = 'shell:::{F874310E-B6B7-47DC-BC84-B9E6B38F5903}';
  const SHELL_PC = 'shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}';
  async function shellIconUrl(p, px, ext = '') {
    const k = shellKey(p, px, ext);
    if (shellCache.has(k)) return shellCache.get(k);
    // Files of one type share a single request.
    if (!shellPending.has(k)) {
      shellPending.set(k, api.shellIcon(p, Math.min(256, px * 2)).then((u) => {
        shellCache.set(k, u || null);
        shellPending.delete(k);
        return u || null;
      }));
    }
    return shellPending.get(k);
  }
  // Swaps placeholders left by shellIco() for the real icons.
  function fillShellIcons(root = document) {
    for (const el of $$('[data-ficon]', root)) {
      const p = el.dataset.ficon;
      el.removeAttribute('data-ficon');
      shellIconUrl(p, Number(el.dataset.px), el.dataset.ext).then((url) => {
        if (url && el.isConnected) el.outerHTML = `<img class="fico" src="${url}" draggable="false">`;
      });
    }
  }

  function iconHtml(e, px) {
    if (!winIcons()) {
      if (e.isDir) return `<span class="tw">${I.folder(specialBadge(e.path))}</span>`;
    } else if (e.isDir || px <= 48 || !canThumb(e)) {
      const ext = e.isDir ? '' : e.ext || '.';
      const hit = shellCache.get(shellKey(e.path, px, ext));
      if (typeof hit === 'string') return `<span class="tw"><img class="fico" src="${hit}" draggable="false"></span>`;
      const fallback = e.isDir ? I.folder(specialBadge(e.path)) : I.file(e.ext);
      return `<span class="tw"${hit === null ? '' : ` data-thumb="${esc(e.path)}" data-px="${px}" data-icon="${esc(ext)}"`}>${fallback}</span>`;
    }
    const key = thumbKey(e, px);
    const cached = thumbCache.get(key);
    if (cached) return `<span class="tw"><img src="${cached}" decoding="async" draggable="false"></span>`;
    const wantsThumb = canThumb(e);
    return `<span class="tw"${wantsThumb ? ` data-thumb="${esc(e.path)}" data-px="${px}"` : ''}>${I.file(e.ext)}</span>`;
  }

  const WEB_IMAGES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
  const SHELL_THUMBS = new Set(['pdf', 'heic', 'heif', 'tif', 'tiff', 'psd', 'mp4', 'mov', 'mkv', 'avi', 'wmv', 'm4v', 'webm', 'docx', 'xlsx', 'pptx', 'raw', 'cr2', 'nef', 'arw', 'dng']);
  function canThumb(e) {
    if (e.isDir) return false;
    if (WEB_IMAGES.has(e.ext)) return true;
    if (platform === 'linux') return false;
    return SHELL_THUMBS.has(e.ext) || I.category(e.ext) === 'video';
  }
  function thumbKey(e, px) { return `${e.path}|${e.mtime}|${px}`; }

  async function loadThumb(el) {
    const p = el.dataset.thumb;
    const px = Number(el.dataset.px);
    if (el.dataset.icon != null) {
      const url = await shellIconUrl(p, px, el.dataset.icon);
      if (url && el.isConnected) el.innerHTML = `<img class="fico" src="${url}" draggable="false">`;
      return;
    }
    const e = entryOf(p);
    if (!e) return;
    const key = thumbKey(e, px);
    let url = thumbCache.get(key);
    if (url === undefined) {
      url = await api.thumb(p, Math.min(512, px * 2));
      if (!url && WEB_IMAGES.has(e.ext) && (e.size || 0) < 40e6) url = P.fileUrl(p);
      thumbCache.set(key, url || null);
    }
    if (!url && winIcons()) {
      const icon = await shellIconUrl(p, px, e.ext || '.');
      if (icon && el.isConnected) el.innerHTML = `<img class="fico" src="${icon}" draggable="false">`;
      return;
    }
    if (url && el.isConnected) el.innerHTML = `<img src="${url}" decoding="async" draggable="false">`;
  }

  function observeThumbs() {
    thumbObserver?.disconnect();
    thumbObserver = new IntersectionObserver((items) => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        thumbObserver.unobserve(it.target);
        loadThumb(it.target);
      }
    }, { root: content, rootMargin: '300px' });
    $$('[data-thumb]', view).forEach((el) => thumbObserver.observe(el));
  }

  // OneDrive (cloud files) status next to the name, with Explorer's icons and wording.
  const CLOUD = {
    online: { label: '僅在線上提供', svg: '<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8 4.1 4.1 0 0 0-7.9-.6 3.2 3.2 0 0 0 .5 6.4z" fill="none" stroke="currentColor" stroke-width="1.3"/>' },
    local: { label: '可在此裝置上使用', svg: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="currentColor" stroke-width="1.4"/>' },
    pinned: { label: '一律在此裝置上提供', svg: '<circle cx="8" cy="8" r="6.6" fill="currentColor"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.5"/>' },
    downloading: { label: '正在同步', svg: '<path d="M12.6 6.5A4.8 4.8 0 0 0 3.7 5.6M3.4 9.5a4.8 4.8 0 0 0 8.9.9" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 3.2v2.9h2.9M12.8 12.8V9.9H9.9" fill="none" stroke="currentColor" stroke-width="1.3"/>' },
  };
  function cloudBadge(e) {
    const c = e.cloud && CLOUD[e.cloud];
    return c ? `<svg class="cloud ${e.cloud}" viewBox="0 0 16 16"><title>${c.label}</title>${c.svg}</svg>` : '';
  }

  // Render folders in slices so the first screen appears immediately; from
  // VIRTUAL_MIN items on, only what is on screen (renderVirtual).
  function renderRows(container, items, rowFn, prefix = '') {
    if (items.length >= VIRTUAL_MIN) { renderVirtual(container, items, rowFn, prefix); return; }
    const first = 600;
    container.innerHTML = prefix + items.slice(0, first).map(rowFn).join('');
    let i = first;
    const token = (container._token = (container._token || 0) + 1);
    const step = () => {
      if (container._token !== token || i >= items.length) { observeThumbs(); return; }
      container.insertAdjacentHTML('beforeend', items.slice(i, i + 1500).map((e, k) => rowFn(e, i + k)).join(''));
      i += 1500;
      requestAnimationFrame(step);
    };
    if (items.length > first) requestAnimationFrame(step);
  }

  // ---------- big folders: draw only what is on screen ----------
  // From VIRTUAL_MIN items on, the list and icon views keep only the rows in
  // and near the viewport in the DOM, between two spacers that hold the full
  // height, and draw the rest as they scroll into view. Rows are "slots": one
  // item in the list, one line of icons in the icon view, plus the group
  // header that starts a slot when grouping is on.
  const VIRTUAL_MIN = 1000;
  const OVERSCAN = 800; // px drawn beyond each edge of the viewport

  // Height of `html` laid out in `container`, margins included.
  function probe(container, html) {
    container.insertAdjacentHTML('beforeend', html);
    const el = container.lastElementChild;
    const cs = getComputedStyle(el);
    const h = el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    el.remove();
    return h;
  }

  function renderVirtual(container, items, rowFn, prefix) {
    const icons = container.classList.contains('grid');
    container.innerHTML = prefix;
    container.classList.add('virtual');
    const keep = container.children.length;
    const cs = getComputedStyle(container);
    const gap = icons ? parseFloat(cs.rowGap) || 0 : 0;
    const perRow = icons ? Math.max(1, cs.gridTemplateColumns.split(' ').length) : 1;
    // Icon cells all get the height of one with a two-line name, so every line is the same height.
    const rowH = icons
      ? probe(container, `<div class="gi item"><div class="thumb"></div><div class="label">${'檔'.repeat(80)}</div></div>`)
      : probe(container, '<div class="lrow item"><div class="name">檔</div></div>');
    if (icons) container.style.setProperty('--vcell', `${rowH}px`);
    const grouped = curGroup() !== 'none' && state.cwd !== HOME;
    const headH = grouped ? probe(container, `<div class="${icons ? 'ggroup' : 'lgroup'}">檔<span>1</span></div>`) : 0;
    const labels = grouped ? items.map((e) => groupOf(e).label) : null;
    const slots = [];
    for (let i = 0; i < items.length;) {
      let end = i + 1;
      while (end < items.length && end - i < perRow && !(grouped && labels[end] !== labels[i])) end++;
      slots.push([i, end, grouped && (i === 0 || labels[i - 1] !== labels[i])]);
      i = end;
    }
    const offs = new Float64Array(slots.length + 1);
    const heads = new Int32Array(slots.length + 1); // group headers before each slot
    slots.forEach(([, , head], k) => {
      offs[k + 1] = offs[k] + (head ? headH + gap : 0) + rowH + gap;
      heads[k + 1] = heads[k] + (head ? 1 : 0);
    });
    container._v = { items, rowFn, slots, offs, heads, gap, rowH, headH, perRow, icons, keep, a: 0, b: 0, base: null };
    paintWindow(true);
  }

  // First slot whose bottom edge is below y (in the slots' own coordinates).
  function slotAt(v, y) {
    let lo = 0; let hi = v.slots.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (v.offs[m + 1] <= y) lo = m + 1; else hi = m; }
    return lo;
  }
  function slotOf(v, i) {
    let lo = 0; let hi = v.slots.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (v.slots[m][0] <= i) lo = m; else hi = m - 1; }
    return lo;
  }

  function paintWindow(force = false) {
    const v = view._v;
    if (!v) return;
    const n = v.slots.length;
    const top = content.scrollTop - (v.base ?? 0);
    const h = content.clientHeight;
    if (!force && slotAt(v, top) >= v.a && Math.min(n, slotAt(v, top + h) + 1) <= v.b) return;
    const a = Math.min(n - 1, slotAt(v, top - OVERSCAN));
    const b = Math.min(n, slotAt(v, top + h + OVERSCAN) + 1);
    const html = [];
    for (let k = a; k < b; k++) for (let i = v.slots[k][0]; i < v.slots[k][1]; i++) html.push(v.rowFn(v.items[i], i));
    const pad = (px) => (px > 0 ? `<div class="vpad" style="height:${px}px"></div>` : '');
    const r = document.createRange();
    r.setStart(view, v.keep ? [...view.childNodes].indexOf(view.children[v.keep - 1]) + 1 : 0);
    r.setEnd(view, view.childNodes.length);
    r.deleteContents();
    let lead = pad(a ? v.offs[a] - v.gap : 0);
    if (!v.icons) {
      // List rows are striped by :nth-child, so keep each one at the same
      // odd/even position it has when the whole folder is drawn.
      const want = v.keep + v.slots[a][0] + v.heads[a];
      lead = `<div class="vpad" style="height:${a ? v.offs[a] : 0}px"></div>${(v.keep + 1) % 2 === want % 2 ? '' : '<div class="vpad"></div>'}`;
    }
    view.insertAdjacentHTML('beforeend', lead + html.join('') + pad(b < n ? v.offs[n] - v.offs[b] - v.gap : 0));
    v.a = a; v.b = b;
    if (!force) view.classList.remove('animate'); // rows drawn while scrolling don't pop in
    if (v.base == null) {
      // Where slot 0 starts in the scroller (below the padding and the list header).
      const first = view.children[v.keep];
      v.base = first ? first.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop : 0;
      paintWindow();
    }
    observeThumbs();
    fillShellIcons(view);
  }
  content.addEventListener('scroll', () => paintWindow(), { passive: true });
  // Icon lines follow the window width; redo them when it changes.
  new ResizeObserver(() => {
    const v = view._v;
    if (!v) return;
    if (v.icons && getComputedStyle(view).gridTemplateColumns.split(' ').length !== v.perRow) { renderView(false); return; }
    paintWindow();
  }).observe(content);

  // Every item's box in the scroller's coordinates (for the rubber band),
  // worked out from the layout rather than from elements that may not exist.
  function virtualRects(origin) {
    const v = view._v;
    const cs = getComputedStyle(view);
    const vr = view.getBoundingClientRect();
    const x0 = vr.left - origin.left + content.scrollLeft + parseFloat(cs.paddingLeft);
    const tracks = v.icons
      ? cs.gridTemplateColumns.split(' ').map(parseFloat)
      : [view.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)];
    const colGap = parseFloat(cs.columnGap) || 0;
    const lefts = tracks.map((_, c) => x0 + tracks.slice(0, c).reduce((x, w) => x + w + colGap, 0));
    const rects = [];
    v.slots.forEach(([start, end, head], k) => {
      const t = v.base + v.offs[k] + (head ? v.headH + v.gap : 0);
      for (let i = start; i < end; i++) {
        const c = i - start;
        rects.push({ i, l: lefts[c], r: lefts[c] + tracks[c], t, b: t + v.rowH });
      }
    });
    return rects;
  }

  // Scrolls an item into view (drawing it first in a big folder) and returns its element.
  function revealPath(p) {
    const v = view._v;
    if (v && !inColumnsMode()) {
      const i = state.entries.findIndex((e) => e.path === p);
      if (i >= 0) {
        const k = slotOf(v, i);
        const t = v.base + v.offs[k + 1] - v.gap - v.rowH;
        const b = t + v.rowH;
        if (t < content.scrollTop) content.scrollTop = t;
        else if (b > content.scrollTop + content.clientHeight) content.scrollTop = b - content.clientHeight;
        paintWindow();
      }
    }
    const el = elForPath(p);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return el;
  }

  // A scroller whose rows (or tiles, `horizontal`) all have the same pitch:
  // the column view's columns and the gallery strip. Keeps only those near
  // the visible part, between two spacers. `lead` is the scroller's padding
  // before the first one; `gap` the flex gap between them.
  function setStrip(box, opts) {
    box._strip = { ...opts, a: 0, b: 0 };
    if (!box._stripScroll) {
      box._stripScroll = true;
      box.addEventListener('scroll', () => { if (box._strip) paintStrip(box); }, { passive: true });
    }
  }
  function paintStrip(box, force = false, pos = null) {
    const s = box._strip;
    const at = pos ?? (s.horizontal ? box.scrollLeft : box.scrollTop);
    const size = (s.horizontal ? box.clientWidth : box.clientHeight) || 1000;
    const first = Math.max(0, Math.floor((at - s.lead) / s.pitch));
    const last = Math.min(s.n, Math.ceil((at - s.lead + size) / s.pitch));
    if (!force && first >= s.a && last <= s.b) return;
    const over = Math.ceil(OVERSCAN / s.pitch);
    const a = Math.max(0, first - over);
    const b = Math.min(s.n, last + over);
    const pad = (k) => (k > 0 ? `<div class="vpad" style="${s.horizontal ? 'width' : 'height'}:${k * s.pitch - s.gap}px"></div>` : '');
    let html = pad(a);
    for (let i = a; i < b; i++) html += s.html(i);
    box.innerHTML = html + pad(s.n - b);
    s.a = a; s.b = b;
    if (!force) { observeThumbs(); fillShellIcons(box); }
  }

  async function renderView(animate) {
    const mode = viewMode();
    view._v = null;
    queueFolderSizes();
    if (mode !== 'columns') { view.className = ''; view.style.minWidth = ''; cancelAnimationFrame(glide); }
    $('#empty').hidden = true;
    const cut = new Set(G.clip?.op === 'move' ? G.clip.paths : []);

    if (mode === 'columns') { await renderColumns(); observeThumbs(); return; }
    if (mode === 'home') { renderHome(); observeThumbs(); return; }

    const items = state.entries;
    if (!items.length) {
      view.innerHTML = '';
      const empty = $('#empty');
      empty.innerHTML = `${I.folder()}<div>${state.search.query ? '沒有符合的項目' : '這個資料夾是空的'}</div>`;
      empty.hidden = false;
      return;
    }

    if (mode === 'icons') {
      view.className = `grid${animate ? ' animate' : ''}`;
      const counts = groupCounts(items);
      renderRows(view, items, (e, i) => `${groupHead(items, i, counts, 'ggroup')}
        <div class="gi item${state.sel.has(e.path) ? ' sel' : ''}${cut.has(e.path) ? ' cut' : ''}" data-i="${i}" style="--i:${Math.min(i, 40)}" draggable="true">
          <div class="thumb">${iconHtml(e, prefs.icon)}</div>
          <div class="label">${esc(shownName(e))}${cloudBadge(e)}</div>
        </div>`);
    } else if (mode === 'list') {
      view.className = 'list';
      view.style.setProperty('--lcols', listTemplate());
      const { key, dir } = curSort();
      const cols = listCols();
      const head = (k, label) => `<div data-sort="${k}" class="${key === k ? 'sorted' : ''}">${label}${key === k ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : ''}<span class="lgrip" data-col="${k}"></span></div>`;
      const header = `<div class="lhead">${head('name', '名稱')}${cols.map((k) => head(k, LIST_COLS[k].label)).join('')}</div>`;
      const counts = groupCounts(items);
      renderRows(view, items, (e, i) => `${groupHead(items, i, counts, 'lgroup')}
        <div class="lrow item${state.sel.has(e.path) ? ' sel' : ''}${cut.has(e.path) ? ' cut' : ''}" data-i="${i}" draggable="true">
          <div class="name">${iconHtml(e, 40)}<span class="nm">${esc(shownName(e))}</span>${cloudBadge(e)}</div>
          ${cols.map((k) => `<div>${LIST_COLS[k].cell(e)}</div>`).join('')}
        </div>`, header);
    } else if (mode === 'gallery') {
      renderGallery();
    }
    observeThumbs();
  }

  // Column widths: a per-folder width wins over the default (prefs.colW).
  const COL_MIN = 120; const COL_MAX = 640;
  function colWidth(dir) { return prefs.colWidths?.[norm(dir)] || prefs.colW || 220; }
  function setColWidth(dir, w) {
    prefs.colWidths = prefs.colWidths || {};
    const k = norm(dir);
    delete prefs.colWidths[k];
    prefs.colWidths[k] = w;
    const keys = Object.keys(prefs.colWidths);
    if (keys.length > 300) delete prefs.colWidths[keys[0]]; // keep the most recent 300
  }

  // Updates the column DOM in place: unchanged columns are kept as-is (scroll
  // position, thumbnails, no entry animation), so selecting a file no longer
  // redraws and re-animates every column.
  async function renderColumns() {
    const chain = ancestors(state.cwd, state.colRoot);
    await Promise.all(chain.map((d) => listDir(d)));
    state.colLists = chain.map((d) => visibleOf(dirCache.get(d)?.entries || []));
    const n = chain.length - 1;
    const fresh = view._colsTab !== state.id || !view.classList.contains('columns') || !$('.col-preview', view);
    if (fresh) { view.innerHTML = '<div class="col-preview"></div>'; view._colsTab = state.id; }
    // Hold the current width while columns change, so removing columns
    // doesn't snap the view; glideTo() lets go once it has moved.
    else view.style.minWidth = `${content.scrollWidth}px`;
    view.className = 'columns';
    const wraps = $$('.colw', view);
    const preview = $('.col-preview', view);
    chain.forEach((dir, j) => {
      const next = chain[j + 1];
      const list = state.colLists[j];
      const classes = list.map((e) => {
        if (next && norm(e.path) === norm(next)) return j === state.colActive ? 'crow item sel' : 'crow item path';
        return j === n && state.sel.has(e.path) ? 'crow item sel' : 'crow item';
      });
      // Thumbnails are left out of the key so a late-loading thumbnail
      // doesn't force the column to be rebuilt.
      const rowsKey = `${j}|${list.map((e) => `${e.path}|${e.mtime}|${e.isDir}|${e.cloud || ''}`).join('\n')}`;
      let w = wraps[j];
      if (w && norm(w.dataset.dir) !== norm(dir)) { wraps.slice(j).forEach((x) => x.remove()); wraps.length = j; w = null; }
      if (!w) {
        w = document.createElement('div');
        w.className = 'colw';
        w.dataset.dir = dir;
        w.innerHTML = `<div class="col" data-dir="${esc(dir)}"></div><div class="col-grip" title="拖曳調整欄寬（Alt：全部欄），按兩下自動調整"></div>`;
        view.insertBefore(w, preview);
        wraps[j] = w;
      }
      w.style.width = `${colWidth(dir)}px`;
      const col = w.firstElementChild;
      const rowHtml = (i) => `<div class="${classes[i]}" data-col="${j}" data-i="${i}" draggable="true">
          ${iconHtml(list[i], 36)}<span class="nm">${esc(shownName(list[i]))}</span>${cloudBadge(list[i])}
          ${list[i].isDir ? '<svg class="chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>' : ''}
        </div>`;
      const big = list.length >= VIRTUAL_MIN;
      if (big) {
        // Big folder: only the rows near the visible part (see setStrip).
        const top = col.scrollTop;
        if (col._rows !== rowsKey || !col._strip) {
          setStrip(col, { n: list.length, pitch: 0, lead: parseFloat(getComputedStyle(col).paddingTop) || 0, gap: 0 });
        }
        col._strip.pitch = probe(col, '<div class="crow item">檔</div>'); // follows the list density
        col._strip.html = rowHtml;
        col._focusRow = classes.findIndex((c, i) => c !== 'crow item' && (j < n || !state.focus || list[i].path === state.focus));
        paintStrip(col, true, top);
        col._rows = rowsKey;
        col.scrollTop = top;
      } else if (col._rows !== rowsKey || col._strip) {
        col._strip = null;
        const top = col.scrollTop;
        col.innerHTML = list.map((_, i) => rowHtml(i)).join('');
        col._rows = rowsKey;
        col.scrollTop = top;
      } else {
        // Same rows: only the highlight changed.
        const els = col.children;
        for (let i = 0; i < els.length; i++) if (els[i].className !== classes[i]) els[i].className = classes[i];
      }
    });
    wraps.slice(chain.length).forEach((x) => x.remove());

    // Preview column (Finder): one file → its preview; several items → a
    // stack and a count. It can be hidden (Alt+P / ⋯ menu), as in Finder.
    const sel = selectedEntries();
    const inLast = state.colActive === n && prefs.colPreview;
    const shown = inLast && sel.length === 1 && !sel[0].isDir ? sel[0] : null;
    const multi = inLast && sel.length > 1 ? sel : null;
    const key = shown ? `${shown.path}|${shown.mtime}|${shown.size}` : multi ? `multi|${multi.map((e) => e.path).join('|')}` : '';
    if (preview._key !== key) {
      preview._key = key;
      nativeHide();
      preview.innerHTML = shown ? previewCard(shown) : multi ? multiCard(multi) : '';
      if (shown) fillPreview($('.cp-media', preview), shown);
      preview.classList.toggle('empty', !shown && !multi);
      fillShellIcons(preview);
    }
    for (const col of $$('.col', view)) {
      // In a big column the highlighted row may not be drawn yet: scroll by position.
      if (!col._strip || col._focusRow < 0) continue;
      const t = col._strip.lead + col._focusRow * col._strip.pitch;
      if (t < col.scrollTop) col.scrollTop = t - 6;
      else if (t + col._strip.pitch > col.scrollTop + col.clientHeight) col.scrollTop = t + col._strip.pitch - col.clientHeight + 6;
      paintStrip(col);
    }
    for (const el of $$('.crow.sel, .crow.path', view)) {
      const col = el.parentElement;
      if (col._strip) continue;
      if (el.offsetTop < col.scrollTop) col.scrollTop = el.offsetTop - 6;
      else if (el.offsetTop + el.offsetHeight > col.scrollTop + col.clientHeight) col.scrollTop = el.offsetTop + el.offsetHeight - col.clientHeight + 6;
    }
    // Like Finder: columns appear in place and the whole view glides sideways
    // to show the newest one (or the preview); when columns go away it glides
    // back. Otherwise it only moves to keep the active column in sight.
    // It moves only when something new doesn't fit, and only as far as
    // needed; when columns go away it stays put (leaving blank space, as
    // Finder does), so what you just clicked stays under the pointer.
    const last = wraps[chain.length - 1];
    const right = last ? last.offsetLeft + last.offsetWidth + (shown || multi ? PREVIEW_MIN : 0) : 0;
    const vw = content.clientWidth;
    let target = fresh ? Math.max(0, right - vw) : content.scrollLeft;
    if (right > target + vw) target = right - vw; // the new column (or preview) is cut off: reveal it
    const active = wraps[state.colActive];
    if (active && active.offsetLeft < target) target = active.offsetLeft; // keyboard moved left out of view
    glideTo(target, Math.max(right, target + vw));
  }

  const PREVIEW_MIN = 160; // .col-preview min-width when it shows a file
  let glide = 0;
  // Scrolls the column view to `target` with an ease-out; `width` is the
  // room to keep afterwards so the position never snaps.
  function glideTo(target, width) {
    cancelAnimationFrame(glide);
    const from = content.scrollLeft;
    const settle = () => { view.style.minWidth = width > content.clientWidth ? `${width}px` : ''; };
    if (Math.abs(target - from) < 1) { settle(); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 300);
      content.scrollLeft = from + (target - from) * (1 - (1 - p) ** 3); // ease-out
      if (p < 1) glide = requestAnimationFrame(step); else settle();
    };
    glide = requestAnimationFrame(step);
  }

  // Width that fits the longest name in a column.
  function fitColumn(w) {
    const col = w.firstElementChild;
    const nm = $('.crow .nm', col);
    if (!nm) return COL_MIN;
    const ctx = (fitColumn.ctx ||= document.createElement('canvas').getContext('2d'));
    const cs = getComputedStyle(nm);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let max = 0;
    for (const e of state.colLists[$$('.colw', view).indexOf(w)] || []) max = Math.max(max, ctx.measureText(e.name).width);
    // row padding + icon + gaps + chevron + column padding + scrollbar
    return Math.round(Math.max(COL_MIN, Math.min(COL_MAX, max + 16 + 18 + 14 + 10 + 12 + 14)));
  }

  view.addEventListener('mousedown', (ev) => {
    const grip = ev.target.closest('.col-grip');
    if (!grip || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const w = grip.parentElement;
    const all = ev.altKey;
    const startX = ev.clientX; const startW = w.offsetWidth;
    document.body.classList.add('col-resizing');
    const move = (e) => {
      const width = Math.max(COL_MIN, Math.min(COL_MAX, startW + e.clientX - startX));
      if (all) { prefs.colW = width; prefs.colWidths = {}; $$('.colw', view).forEach((x) => { x.style.width = `${width}px`; }); }
      else { setColWidth(w.dataset.dir, width); w.style.width = `${width}px`; }
    };
    const up = () => {
      document.body.classList.remove('col-resizing');
      savePrefs();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, true);

  // List column widths: drag the edge of a header cell.
  view.addEventListener('mousedown', (ev) => {
    const grip = ev.target.closest('.lgrip');
    if (!grip || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const k = grip.dataset.col;
    const cell = grip.parentElement;
    const startX = ev.clientX; const startW = cell.getBoundingClientRect().width;
    document.body.classList.add('col-resizing');
    const move = (e) => {
      prefs.listW = { ...prefs.listW, [k]: Math.round(Math.max(k === 'name' ? 140 : 50, Math.min(900, startW + e.clientX - startX))) };
      view.style.setProperty('--lcols', listTemplate());
    };
    const up = () => {
      document.body.classList.remove('col-resizing');
      savePrefs();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, true);

  view.addEventListener('dblclick', (ev) => {
    const grip = ev.target.closest('.col-grip');
    if (!grip) return;
    ev.stopPropagation();
    const targets = ev.altKey ? $$('.colw', view) : [grip.parentElement];
    for (const w of targets) {
      const width = fitColumn(w);
      setColWidth(w.dataset.dir, width);
      w.style.width = `${width}px`;
    }
    savePrefs();
  }, true);

  function multiCard(items) {
    const files = items.filter((e) => !e.isDir);
    const total = files.reduce((n, e) => n + (e.size || 0), 0);
    return `
      <div class="cp-media" data-kind="info"><div class="pv-stack">${items.slice(0, 3).map((e, i) => `<span style="--k:${i}">${fileIco(e, 128)}</span>`).join('')}</div></div>
      <div class="pv-name">已選取 ${items.length} 個項目</div>
      <div class="pv-kind">${files.length ? `檔案大小合計 ${fmtSize(total)}` : ''}</div>`;
  }

  // Column view's preview column: the same live preview as the pane (images,
  // video, Word/Excel/PowerPoint, PDF, text), zoomable, then the details.
  function previewCard(e) {
    return `
      <div class="cp-media"></div>
      <div class="pv-name">${esc(e.name)}</div>
      <div class="pv-kind">${esc(I.kindLabel(e))}${e.isDir ? '' : ` — ${fmtSize(e.size)}`}</div>
      <div class="pv-table">
        <div><span>建立日期</span><span>${fmtDate(e.birth)}</span></div>
        <div><span>修改日期</span><span>${fmtDate(e.mtime)}</span></div>
        ${e.isDir ? '' : `<div><span>大小</span><span>${e.size?.toLocaleString() ?? '--'} 位元組</span></div>`}
        ${CLOUD[e.cloud] ? `<div><span>狀態</span><span>${CLOUD[e.cloud].label}</span></div>` : ''}
      </div>`;
  }

  // ---------- Explorer's preview handlers (Windows) ----------
  // The column view's preview column and the preview pane show what Explorer's
  // preview pane shows:
  // the file type's registered preview handler (Office, PDF, text, PowerToys…)
  // in a native window over the preview area, for Office files and other types
  // the built-in previews can't show. Images, video, audio, PDF, text and code
  // keep the built-in previews: they appear at once and zoom, while those
  // handlers (Edge's PDF engine, PowerToys' code viewer…) take a second to
  // start. Types without a handler fall back to them too. A native window draws over the page, so it steps aside while a
  // menu, dialog or Quick Look is open and is clipped to the visible area.
  const native = { el: null, gen: 0, rect: '', raf: 0, avail: new Map() };
  const BUILTIN_FIRST = new Set(['image', 'video', 'audio', 'pdf', 'text', 'code', 'font', 'archive']);
  function nativeWanted(e) {
    return !!api.previewShow && prefs.nativePreview && !e.isDir && e.ext && !BUILTIN_FIRST.has(I.category(e.ext)) && !['csv', 'tsv'].includes(e.ext);
  }
  function nativeAvailable(ext) {
    if (!native.avail.has(ext)) native.avail.set(ext, api.previewAvailable(ext));
    return native.avail.get(ext);
  }
  // The built-in preview shows at once; when the file's handler has drawn its
  // preview (prevhost keeps it hidden until then), that is laid over it. If
  // the handler fails, the built-in one is already there.
  async function fillPreview(media, e) {
    prefetchAround(e);
    const wanted = nativeWanted(e) && await nativeAvailable(e.ext);
    if (!media.isConnected) return;
    window.Preview.fill(media, e, { helpers: previewHelpers });
    if (!wanted) return;
    const gen = ++native.gen;
    native.el = media;
    native.rect = '';
    const r = nativeRects(media);
    const res = r ? await api.previewShow(e.path, gen, r.host, r.inner, isDark()) : 'HIDDEN';
    if (gen !== native.gen) return; // another file took over
    if (res !== true) { native.el = null; return; }
    media._tok = (media._tok || 0) + 1; // a built-in preview still loading must not change the box now
    media.dataset.kind = 'native';
    trackNative();
  }
  // Starts the handlers for the commonest previewable types in the folder
  // before the first click; starting one is most of a first preview's wait.
  const warmed = new Set();
  async function warmPreviews() {
    if (!api.previewWarm || !prefs.nativePreview || !(inColumnsMode() ? prefs.colPreview : prefs.previewPane)) return;
    const list = (inColumnsMode() ? state.colLists[state.colLists.length - 1] : state.entries) || [];
    const counts = new Map();
    for (const e of list) if (nativeWanted(e)) counts.set(e.ext, (counts.get(e.ext) || 0) + 1);
    const exts = [];
    for (const [ext] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      if (warmed.has(ext)) continue;
      warmed.add(ext);
      if (await nativeAvailable(ext)) exts.push(ext);
    }
    if (exts.length) api.previewWarm(exts);
  }
  // While one file is looked at, the ones before and after it get their
  // previews ready, so the arrow keys show them at once.
  let prefetchTimer = 0;
  function prefetchAround(e) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const list = (inColumnsMode() ? state.colLists[state.colActive] : state.entries) || [];
      const i = list.findIndex((x) => x.path === e.path);
      if (i >= 0) for (const k of [i + 1, i - 1]) window.Preview.prefetch(list[k], previewHelpers);
    }, 150);
  }
  function nativeHide() {
    if (!native.el) return;
    native.el = null;
    native.gen++;
    cancelAnimationFrame(native.raf);
    api.previewHide(native.gen);
  }
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  // Physical-pixel rectangles for the native window: `host` is the part of
  // the preview area that's on screen, `inner` the whole area relative to it.
  function nativeRects(el) {
    const b = el.getBoundingClientRect();
    const col = el.closest('.col-preview');
    const clips = (col ? [content, col] : [el.closest('#preview-pane') || el]).map((x) => x.getBoundingClientRect());
    const x0 = Math.max(b.left, ...clips.map((c) => c.left)); const y0 = Math.max(b.top, ...clips.map((c) => c.top));
    const x1 = Math.min(b.right, ...clips.map((c) => c.right)); const y1 = Math.min(b.bottom, ...clips.map((c) => c.bottom));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const d = devicePixelRatio;
    const px = (v) => Math.round(v * d);
    return {
      host: { x: px(x0), y: px(y0), w: px(x1) - px(x0), h: px(y1) - px(y0) },
      inner: { x: px(b.left) - px(x0), y: px(b.top) - px(y0), w: px(b.width), h: px(b.height) },
      box: { left: x0, top: y0, right: x1, bottom: y1 },
    };
  }
  function nativeCovered(box) {
    if (!$('#dlg').hidden || !$('#ql').hidden) return true;
    return ['#menu', '#toast', '#update', '#progress'].some((sel) => {
      const el = $(sel);
      if (!el || el.hidden) return false;
      const r = el.getBoundingClientRect();
      return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    });
  }
  // Follows the preview area every frame (column glides, resizes, scrolling).
  function trackNative() {
    cancelAnimationFrame(native.raf);
    const step = () => {
      if (!native.el) return;
      if (!native.el.isConnected) { nativeHide(); return; }
      const r = nativeRects(native.el);
      const show = r && !nativeCovered(r.box) && !document.hidden;
      const key = show ? JSON.stringify(r) : 'off';
      if (key !== native.rect) {
        native.rect = key;
        api.previewMove(show ? r.host : null, show ? r.inner : null);
      }
      native.raf = requestAnimationFrame(step);
    };
    native.raf = requestAnimationFrame(step);
  }

  // Gallery (Finder): the selected item's full preview on the stage — PDFs,
  // Word/Excel/PowerPoint, text, images, video — with the strip below. The
  // stage is kept while the same file stays selected, so a refresh doesn't
  // reload it (or lose a PDF's scroll position).
  function renderGallery() {
    const items = state.entries;
    let cur = selectedEntries()[0];
    if (!cur) { cur = items[0]; state.sel = new Set([cur.path]); state.focus = cur.path; state.anchor = cur.path; }
    const key = `${cur.path}|${cur.mtime}|${cur.size}`;
    const kept = view._gKey === key ? $('.g-stage', view) : null;
    view._gKey = key;
    view.className = 'gallery';
    view.innerHTML = `
      <div class="g-stage">${cur.isDir ? `<div class="hero">${fileIco(cur, 128)}</div>` : '<div class="cp-media g-media"></div>'}</div>
      <div class="g-caption"><b>${esc(shownName(cur))}</b><small>${esc(I.kindLabel(cur))}${cur.isDir ? '' : ` · ${fmtSize(cur.size)}`} · ${fmtDate(cur.mtime)}</small></div>
      <div class="g-strip"></div>`;
    const tile = (i) => `<div class="g-item item${state.sel.has(items[i].path) ? ' sel' : ''}" data-i="${i}" draggable="true" title="${esc(items[i].name)}">${iconHtml(items[i], 64)}</div>`;
    const strip = $('.g-strip', view);
    if (items.length >= VIRTUAL_MIN) {
      // Big folder: only the tiles near the visible part, starting around the current one.
      const cs = getComputedStyle(strip);
      const gap = parseFloat(cs.columnGap) || 0;
      const lead = parseFloat(cs.paddingLeft) || 0;
      const pitch = probe(strip, '<div class="g-item item"></div>') + gap;
      setStrip(strip, { n: items.length, pitch, lead, gap, horizontal: true, html: tile });
      const at = Math.max(0, lead + items.indexOf(cur) * pitch - strip.clientWidth / 2);
      paintStrip(strip, true, at);
      strip.scrollLeft = at;
    } else {
      strip.innerHTML = items.map((_, i) => tile(i)).join('');
    }
    if (kept) $('.g-stage', view).replaceWith(kept);
    else if (!cur.isDir) { window.Preview.fill($('.g-media', view), cur, { helpers: previewHelpers }); prefetchAround(cur); }
    fillShellIcons(view);
    $('.g-item.sel', view)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // Explorer-like Home: pinned folders, drives with capacity, recent files.
  function renderHome() {
    view.className = 'home';
    const items = state.entries;
    const cut = new Set(G.clip?.op === 'move' ? G.clip.paths : []);
    const sel = (e) => (state.sel.has(e.path) ? ' sel' : '');
    const at = (e) => items.indexOf(e);
    const chev = '<svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg>';
    const sec = (key, title, body) => {
      const closed = prefs.homeCollapsed?.[key];
      return `<section class="h-sec${closed ? ' collapsed' : ''}" data-hsec="${key}"><button class="h-title">${chev}${title}</button><div class="h-body">${body}</div></section>`;
    };
    const pinned = items.filter((e) => e.kind === 'pinned');
    const drives = items.filter((e) => e.kind === 'drive');
    const recent = items.filter((e) => e.kind === 'recent');
    const where = (p) => (G.places.favorites.some((f) => norm(f.path) === norm(p)) ? '本機' : P.dirname(p));
    const qa = pinned.map((e) => `
      <div class="qa item${sel(e)}" data-i="${at(e)}">${folderIco(e.path, 48, e.badge)}<div><b>${esc(e.name)}</b><small>${esc(where(e.path))}</small></div></div>`).join('');
    const drv = drives.map((e) => `
      <div class="drv item${sel(e)}" data-i="${at(e)}" data-drive="${esc(e.path)}">${shellIco(e.path, 48, I.drive())}<div><b>${esc(e.name)}</b>
        <div class="bar"><i style="width:0%"></i></div><small class="space">&nbsp;</small></div></div>`).join('');
    const rec = recent.map((e) => `
      <div class="lrow item${sel(e)}${cut.has(e.path) ? ' cut' : ''}" data-i="${at(e)}" draggable="true">
        <div class="name">${iconHtml(e, 40)}<span class="nm">${esc(shownName(e))}</span>${cloudBadge(e)}</div>
        <div>${fmtDate(e.mtime)}</div><div>${esc(P.dirname(e.path))}</div></div>`).join('');
    view.innerHTML =
      sec('pinned', '快速存取', pinned.length ? `<div class="qa-grid">${qa}</div>` : '<div class="h-empty">沒有釘選的資料夾</div>') +
      sec('drives', '裝置與磁碟機', `<div class="drv-grid">${drv}</div>`) +
      sec('recent', '最近使用的檔案', recent.length ? `<div class="list">${rec}</div>` : '<div class="h-empty">沒有最近使用的檔案</div>');
    for (const el of $$('[data-drive]', view)) fillDriveSpace(el);
  }

  async function fillDriveSpace(el) {
    const p = el.dataset.drive;
    if (!G.space.has(p)) G.space.set(p, await api.diskSpace(p).catch(() => null));
    const sp = G.space.get(p);
    if (!sp || !sp.total || !el.isConnected) { if (el.isConnected) $('.space', el).textContent = ''; return; }
    const used = (sp.total - sp.free) / sp.total;
    const bar = $('.bar i', el);
    requestAnimationFrame(() => { bar.style.width = `${Math.round(used * 100)}%`; });
    bar.classList.toggle('full', used > 0.9);
    $('.space', el).textContent = `${fmtSize(sp.free)} 可用，共 ${fmtSize(sp.total)}`;
  }

  // ---------- tabs ----------
  function tabTitle(t) {
    if (t.search.smart) return smartById(t.search.smart)?.name || '智慧型資料夾';
    if (t.search.results) return `搜尋「${t.search.query}」`;
    if (t.cwd === HOME || !t.cwd) return '常用';
    return displayName(t.cwd);
  }

  // Only tabs that weren't on screen before get the entry animation; redrawing
  // the bar on every navigation used to make all tabs jump.
  const shownTabs = new Set();
  function renderTabs() {
    $('#tabs').innerHTML = tabs.map((t) => `
      <div class="tab${t === state ? ' active' : ''}${shownTabs.has(t.id) ? '' : ' new'}" data-tab="${t.id}" title="${esc(t.cwd === HOME ? '常用' : t.cwd || '')}">
        ${t.search.smart ? I.sidebar('smart') : !t.cwd ? I.sidebar('home') : folderIco(t.cwd, 16)}<span>${esc(tabTitle(t))}</span>
      </div>`).join('');
    saveSession();
    shownTabs.clear();
    tabs.forEach((t) => shownTabs.add(t.id));
    fillShellIcons($('#tabs'));
  }

  async function switchTab(t) {
    if (t === state) return;
    lastBg = null;
    state.scroll = content.scrollTop;
    state = t;
    syncSearchUi();
    if (t.cwd === HOME) await loadHome();
    else await listDir(t.cwd, true);
    computeEntries();
    await render();
    content.scrollTop = t.scroll;
    watchCurrent();
    if (t.search.smart && !t.search.results && t.search.scope !== 'folder') runDeepSearch(); // restored or opened in the background
  }

  // Reopens the last session's tabs (Settings > 啟動時打開).
  function saveSession() {
    if (G.booting) return;
    prefs.session = {
      active: tabs.indexOf(state),
      tabs: tabs.map((t) => (t.search.smart ? { dir: t.cwd || HOME, smart: t.search.smart } : { dir: t.cwd || HOME })),
    };
    savePrefs();
  }
  async function restoreSession() {
    const saved = prefs.session?.tabs || [];
    const restored = [];
    let active = null;
    for (const [i, s] of saved.entries()) {
      state = newTabState();
      const sf = s.smart && smartById(s.smart);
      const ok = sf ? await openSmart(sf, { silent: true }) : await navigate(s.dir, { root: s.dir, silent: true });
      if (!ok) continue; // folder gone or unreachable
      restored.push(state);
      if (i === prefs.session.active) active = state;
    }
    if (!restored.length) return false;
    tabs.splice(0, tabs.length, ...restored);
    const show = active || restored[0];
    state = { ...show, id: -1 };
    await switchTab(show);
    return true;
  }

  let lastBg = null; // keeps background tabs in the order they were opened, like browsers
  async function openTab(dir = HOME, { activate = true, smart = null } = {}) {
    const t = newTabState();
    const go = (silent) => (smart ? openSmart(smart, { silent }) : navigate(dir, { root: dir, silent }));
    let at = tabs.indexOf(state) + 1;
    if (!activate && lastBg?.opener === state && tabs.includes(lastBg.tab)) at = tabs.indexOf(lastBg.tab) + 1;
    tabs.splice(at, 0, t);
    lastBg = activate ? null : { opener: state, tab: t };
    if (activate) {
      state.scroll = content.scrollTop;
      state = t;
      syncSearchUi();
      if (!(await go(false))) await navigate(HOME);
    } else {
      // Background tab: load it without touching the visible one.
      const cur = state;
      state = t;
      const ok = await go(true);
      if (!ok) await navigate(HOME, { silent: true });
      state = cur;
      renderTabs();
    }
  }

  async function closeTab(t) {
    if (tabs.length === 1) { // keep the window open: the last tab becomes Home
      t.history = []; t.hIndex = -1;
      await navigate(HOME);
      return;
    }
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    if (t === state) {
      state = { ...state, id: -1 }; // detached so switchTab doesn't early-return
      await switchTab(tabs[Math.min(i, tabs.length - 1)]);
    } else {
      renderTabs();
    }
  }

  function cycleTab(step) {
    const i = tabs.indexOf(state);
    switchTab(tabs[(i + step + tabs.length) % tabs.length]);
  }

  function paintSelection() {
    const mode = viewMode();
    if (mode === 'gallery' || mode === 'columns') { renderView(false).then(() => { renderStatus(); }); return; }
    for (const el of $$('.item[data-i]', view)) {
      const e = state.entries[Number(el.dataset.i)];
      el.classList.toggle('sel', !!e && state.sel.has(e.path));
    }
    renderStatus();
    updatePane();
  }

  function renderPathbar() {
    const bar = $('#pathbar');
    if (state.search.results || state.search.smart) {
      const label = state.search.smart ? tabTitle(state) : '搜尋結果';
      bar.innerHTML = `<span class="crumb">${I.sidebar(state.search.smart ? 'smart' : 'recent')}<span>${esc(label)}：${state.entries.length} 個項目</span></span>`;
      return;
    }
    if (state.cwd === HOME) { bar.innerHTML = `<span class="crumb">${folderIco(HOME, 16)}<span>常用</span></span>`; return; }
    const chain = ancestors(state.cwd, P.root(state.cwd));
    const sep = '<svg class="crumb-sep" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
    bar.innerHTML = chain.map((p, i) => `
      <button class="crumb" data-path="${esc(p)}">${i === 0 ? shellIco(p, 16, I.drive()) : folderIco(p, 16)}<span>${esc(displayName(p))}</span></button>`).join(sep);
    bar.scrollLeft = bar.scrollWidth;
  }

  const freeCache = new Map();
  async function renderStatus() {
    const n = state.entries.length;
    const s = selectedEntries().length;
    let text = s ? `已選取 ${s} 個項目，共 ${n} 個` : `${n} 個項目`;
    if (state.search.busy) text += '，搜尋中…';
    if (state.cwd === HOME) { $('#status-text').textContent = text; return; }
    const root = P.root(state.cwd || '/');
    $('#status-text').textContent = text + (freeCache.has(root) && freeCache.get(root) != null ? `，可用空間 ${fmtSize(freeCache.get(root))}` : '');
    if (!freeCache.has(root)) {
      freeCache.set(root, null);
      freeCache.set(root, await api.diskFree(root));
      renderStatus();
    }
  }

  // ---------- selection ----------
  function setSelection(paths, focus = paths[paths.length - 1]) {
    state.sel = new Set(paths);
    state.focus = focus || null;
    state.anchor = state.anchor && state.sel.has(state.anchor) ? state.anchor : state.focus;
    paintSelection();
    if (ql.isOpen) ql.update();
  }

  function itemFromEl(el) {
    const item = el?.closest?.('.item');
    if (!item) return null;
    if (item.dataset.col != null) {
      const col = Number(item.dataset.col);
      return { entry: state.colLists[col]?.[Number(item.dataset.i)], col, el: item };
    }
    return { entry: state.entries[Number(item.dataset.i)], el: item };
  }

  function elForPath(p) {
    if (inColumnsMode()) {
      for (const el of $$('.crow', view)) {
        const it = itemFromEl(el);
        if (it?.entry?.path === p) return el;
      }
      return null;
    }
    const i = state.entries.findIndex((e) => e.path === p);
    return i < 0 ? null : $(`.item[data-i="${i}"]`, view);
  }

  function clickSelect(entry, ev) {
    const paths = state.entries.map((e) => e.path);
    if (ev.shiftKey && state.anchor && paths.includes(state.anchor)) {
      const a = paths.indexOf(state.anchor); const b = paths.indexOf(entry.path);
      const range = paths.slice(Math.min(a, b), Math.max(a, b) + 1);
      const keep = ev.ctrlKey || ev.metaKey ? [...state.sel] : [];
      state.sel = new Set([...keep, ...range]);
      state.focus = entry.path;
      paintSelection();
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(state.sel);
      next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
      state.sel = next; state.anchor = entry.path; state.focus = entry.path;
      paintSelection();
    } else {
      state.anchor = entry.path;
      setSelection([entry.path]);
    }
  }

  async function columnClick(entry, col) {
    const chain = ancestors(state.cwd, state.colRoot);
    if (entry.isDir) {
      await navigate(entry.path, { colActive: col, animate: false });
    } else if (norm(chain[col]) === norm(state.cwd)) {
      state.colActive = col;
      state.anchor = entry.path;
      setSelection([entry.path]);
    } else {
      await navigate(chain[col], { select: entry.path, colActive: col, animate: false, push: true });
    }
    if (ql.isOpen) ql.update();
  }

  // Selection inside one column (Finder): several items, the whole column, or
  // nothing. Columns to the right of it close, as in Finder.
  async function selectInColumn(j, paths, { focus = paths[paths.length - 1] ?? null, anchor = null } = {}) {
    const chain = ancestors(state.cwd, state.colRoot);
    const dir = chain[j];
    if (!dir) return;
    const list = state.colLists[j] || [];
    if (paths.length === 1) {
      const e = list.find((x) => x.path === paths[0]);
      if (e?.isDir) { await columnClick(e, j); return; } // one folder: open it
    }
    if (norm(dir) !== norm(state.cwd)) await navigate(dir, { colActive: j, animate: false });
    state.colActive = j;
    state.sel = new Set(paths);
    state.focus = focus;
    state.anchor = anchor ?? focus;
    paintSelection();
    if (ql.isOpen) ql.update();
  }
  // What is selected in column j right now.
  function columnSelection(j) {
    const chain = ancestors(state.cwd, state.colRoot);
    const n = chain.length - 1;
    if (j === n) return [...state.sel];
    return j < n ? [chain[j + 1]] : [];
  }
  // Ctrl+click toggles, Shift+click selects a range (Ctrl+Shift adds one).
  function columnModifierClick(entry, j, ev) {
    const list = (state.colLists[j] || []).map((e) => e.path);
    const current = columnSelection(j);
    if (ev.shiftKey) {
      const n = ancestors(state.cwd, state.colRoot).length - 1;
      const anchor = (j === n && state.anchor && list.includes(state.anchor)) ? state.anchor : current[0] || entry.path;
      const a = list.indexOf(anchor); const b = list.indexOf(entry.path);
      const range = a < 0 ? [entry.path] : list.slice(Math.min(a, b), Math.max(a, b) + 1);
      const next = ev.ctrlKey || ev.metaKey ? [...new Set([...current, ...range])] : range;
      return selectInColumn(j, next, { focus: entry.path, anchor });
    }
    const next = current.includes(entry.path) ? current.filter((p) => p !== entry.path) : [...current, entry.path];
    return selectInColumn(j, next, { focus: entry.path, anchor: entry.path });
  }

  // Finder's slow click: click the name of the item that is already the only
  // one selected, wait a moment, and it goes into rename. A double-click, a
  // drag or any other click cancels it.
  let slowRename = null;
  function cancelSlowRename() { clearTimeout(slowRename?.timer); slowRename = null; }
  function armSlowRename(entry, ev) {
    cancelSlowRename();
    const sel = selectedEntries();
    const onName = ev.target.closest('.nm, .label');
    if (!onName || ev.ctrlKey || ev.shiftKey || ev.metaKey || ev.detail > 1) return;
    if (sel.length === 1 && sel[0].path === entry.path && !isVirtual(entry)) slowRename = { path: entry.path, timer: null };
  }
  document.addEventListener('mouseup', () => {
    if (!slowRename || slowRename.timer) return;
    const { path } = slowRename;
    slowRename.timer = setTimeout(() => {
      slowRename = null;
      const e = selectedEntries();
      if (!G.renaming && e.length === 1 && e[0].path === path) startRename(e[0]);
    }, 600);
  });
  document.addEventListener('dblclick', cancelSlowRename, true);
  document.addEventListener('keydown', cancelSlowRename, true);

  // ---------- opening ----------
  // A shortcut to a folder opens the folder here (like a Finder alias), not in Explorer.
  async function linkTarget(e) {
    return e && !e.isDir && e.ext === 'lnk' && api.resolveLink ? api.resolveLink(e.path) : null;
  }
  // Finder's 顯示原始項目: go to the folder holding the target and select it.
  async function showOriginal(e) {
    const t = await linkTarget(e);
    if (!t) { toast(`找不到「${e.name}」指向的項目`); return; }
    const dir = P.dirname(t.path);
    await navigate(dir, { root: guessRoot(dir), select: t.path });
  }

  async function openEntry(e) {
    if (!e) return;
    const target = await linkTarget(e);
    if (target?.isDir) { await navigate(target.path, { root: guessRoot(target.path) }); return; }
    if (e.isDir) {
      if (isVirtual(e)) await navigate(e.path, { root: e.path });
      else if (state.search.results || state.cwd === HOME) await navigate(e.path, { root: guessRoot(e.path) });
      else await navigate(e.path);
    } else {
      const err = await api.open(e.path);
      if (err) toast(`無法打開「${e.name}」：${err}`);
    }
  }

  // ---------- content events ----------
  let pendingSingle = null;
  let pendingCol = null;
  content.addEventListener('mousedown', async (ev) => {
    if (ev.button !== 0 || G.renaming) return;
    closeMenu();
    G.dragging = null;
    const it = itemFromEl(ev.target);
    if (ev.target.closest('.lhead')) return;
    if (!it?.entry) {
      cancelSlowRename();
      if (ev.target.closest('.g-stage, .col-preview, .g-caption')) return;
      const colw = ev.target.closest('.colw');
      if (colw && !ev.target.closest('.col-grip')) {
        // Empty part of a column (Finder): clear its selection, close the
        // columns after it, and allow a rubber-band selection in it.
        const j = $$('.colw', view).indexOf(colw);
        if (!ev.ctrlKey && !ev.shiftKey) await selectInColumn(j, []);
        startMarquee(ev, $$('.colw', view)[j]);
        return;
      }
      startMarquee(ev);
      return;
    }
    if (it.col != null) {
      // A double-click's second press must not hit whatever slid under the
      // pointer after the first one opened a column: only the first counts.
      if (ev.detail > 1) { cancelSlowRename(); return; }
      G.colDown = it.entry;
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { cancelSlowRename(); columnModifierClick(it.entry, it.col, ev); return; }
      // Keep a multi-selection until mouseup so it can be dragged as a whole.
      if (state.sel.size > 1 && state.sel.has(it.entry.path)) { pendingCol = { entry: it.entry, col: it.col }; return; }
      armSlowRename(it.entry, ev);
      columnClick(it.entry, it.col);
      return;
    }
    armSlowRename(it.entry, ev);
    // Keep a multi-selection intact until mouseup so it can be dragged.
    if (state.sel.has(it.entry.path) && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey) {
      pendingSingle = it.entry.path;
      state.focus = it.entry.path;
      return;
    }
    clickSelect(it.entry, ev);
  });
  content.addEventListener('mouseup', () => {
    if (pendingCol) { const { entry, col } = pendingCol; pendingCol = null; columnClick(entry, col); }
    if (pendingSingle) { state.anchor = pendingSingle; setSelection([pendingSingle]); pendingSingle = null; }
  });
  content.addEventListener('dblclick', (ev) => {
    const it = itemFromEl(ev.target);
    if (it?.col != null || (inColumnsMode() && ev.target.closest('.colw'))) {
      // Column view (like Finder): a folder already opened on the first click;
      // a file opens in its app. Use what the first click hit.
      const e = G.colDown;
      if (e && !e.isDir) openEntry(e);
      return;
    }
    if (it?.entry) openEntry(it.entry);
  });
  content.addEventListener('click', (ev) => {
    const h = ev.target.closest('.lhead [data-sort]');
    if (!h || ev.target.closest('.lgrip')) return;
    const k = h.dataset.sort;
    const cur = curSort();
    setSort(cur.key === k ? { key: k, dir: -cur.dir } : { key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 });
  });

  // rubber-band selection
  // `scope`: one column of the column view (its rows index state.entries,
  // since selectInColumn made that column the current folder).
  function startMarquee(ev, scope = null) {
    const mode = viewMode();
    if (!scope && mode !== 'icons' && mode !== 'list') { if (!ev.ctrlKey) setSelection([]); return; }
    const base = ev.ctrlKey || ev.shiftKey ? new Set(state.sel) : new Set();
    if (!scope && !ev.ctrlKey && !ev.shiftKey) setSelection([]);
    const box = $('#marquee');
    const origin = content.getBoundingClientRect();
    const sx = ev.clientX - origin.left + content.scrollLeft;
    const sy = ev.clientY - origin.top + content.scrollTop;
    const rects = view._v && !scope ? virtualRects(origin) : $$('.item', scope || view).map((el) => {
      const r = el.getBoundingClientRect();
      return { i: Number(el.dataset.i), l: r.left - origin.left + content.scrollLeft, t: r.top - origin.top + content.scrollTop, r: r.right - origin.left + content.scrollLeft, b: r.bottom - origin.top + content.scrollTop };
    });
    let moved = false;
    const move = (e) => {
      const x = e.clientX - origin.left + content.scrollLeft;
      const y = e.clientY - origin.top + content.scrollTop;
      if (!moved && Math.hypot(x - sx, y - sy) < 4) return;
      moved = true;
      const l = Math.min(sx, x); const t = Math.min(sy, y); const w = Math.abs(x - sx); const h = Math.abs(y - sy);
      Object.assign(box.style, { left: `${l - content.scrollLeft}px`, top: `${t - content.scrollTop}px`, width: `${w}px`, height: `${h}px` });
      box.hidden = false;
      const next = new Set(base);
      for (const it of rects) {
        if (it.r > l && it.l < l + w && it.b > t && it.t < t + h) next.add(state.entries[it.i].path);
      }
      state.sel = next;
      paintSelection();
      // auto-scroll near edges
      if (e.clientY > origin.bottom - 20) content.scrollTop += 16;
      else if (e.clientY < origin.top + 20) content.scrollTop -= 16;
    };
    const up = () => {
      box.hidden = true;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved && state.sel.size) { const last = [...state.sel].pop(); state.focus = last; state.anchor = last; }
      if (moved) cancelSlowRename();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- drag and drop ----------
  content.addEventListener('dragstart', (ev) => {
    const it = itemFromEl(ev.target);
    ev.preventDefault();
    if (!it?.entry || isVirtual(it.entry)) return;
    pendingSingle = null;
    if (it.col == null && !state.sel.has(it.entry.path)) setSelection([it.entry.path]);
    cancelSlowRename();
    pendingCol = null;
    const multiInColumn = it.col != null && state.sel.size > 1 && state.sel.has(it.entry.path);
    const paths = it.col != null && !multiInColumn ? [it.entry.path] : selectedEntries().map((e) => e.path);
    G.dragging = paths;
    startNativeDrag(paths);
  });

  // While Windows runs a drag the app gets no answers from its back end until
  // the drop, so spring-loaded folders couldn't list what they open. Read the
  // visible folders (and the level below) first, then drag from that cache.
  async function startNativeDrag(paths) {
    if (api.listMany) {
      const shown = inColumnsMode() ? state.colLists.flat() : state.entries;
      const dirs = [...new Set(shown.filter((e) => e.isDir && !isVirtual(e)).map((e) => e.path))].slice(0, 300);
      const ahead = await Promise.race([api.listMany(dirs, 3), new Promise((r) => setTimeout(() => r([]), 400))]);
      for (const [dir, entries] of ahead) dirCache.set(dir, { entries });
    }
    G.dragActive = true;
    try { await api.startDrag(paths); } finally { G.dragActive = false; }
  }

  function dropTargetFor(target) {
    if (!target?.closest) return null;
    const place = target.closest('.place, .crumb');
    if (place) return place.dataset.path ? { dir: place.dataset.path, el: place } : null;
    // A tab takes files into the folder it shows.
    const tabEl = target.closest('.tab');
    if (tabEl) {
      const t = tabs.find((x) => x.id === Number(tabEl.dataset.tab));
      return t?.cwd && t.cwd !== HOME && !t.search.results ? { dir: t.cwd, el: tabEl } : null;
    }
    const it = itemFromEl(target);
    if (it?.entry?.isDir) return { dir: it.entry.path, el: it.el };
    if (target.closest('.col')) { const dir = target.closest('.col').dataset.dir; return { dir, el: target.closest('.col') }; }
    if (target.closest('#content') && !state.search.results && state.cwd !== HOME) return { dir: state.cwd, el: content };
    return null;
  }
  let dropEl = null;
  function setDropEl(el) {
    if (dropEl === el) return;
    dropEl?.classList.remove('drop-target', 'drop-here');
    dropEl = el;
    if (el) el.classList.add(el === content ? 'drop-here' : 'drop-target');
  }
  function dropPaths(ev) {
    const files = [...(ev.dataTransfer?.files || [])].map((f) => { try { return api.pathForFile(f); } catch { return ''; } }).filter(Boolean);
    return files.length ? files : (G.dragging || []);
  }
  async function dropInto(target, rawPaths, ctrl) {
    const t = dropTargetFor(target);
    setDropEl(null);
    if (!t) return;
    const paths = rawPaths.filter((p) => norm(p) !== norm(t.dir));
    G.dragging = null;
    if (!paths.length) return;
    // Same drive moves, another drive copies; Ctrl forces a copy (Windows Explorer rules).
    const sameRoot = paths.every((p) => norm(P.root(p)) === norm(P.root(t.dir)));
    const op = ctrl || !sameRoot ? 'copy' : 'move';
    if (op === 'move' && paths.every((p) => norm(P.dirname(p)) === norm(t.dir))) return;
    await transfer(op, paths, t.dir);
  }
  document.addEventListener('dragover', (ev) => {
    const t = dropTargetFor(ev.target);
    if (!t) { setDropEl(null); return; }
    ev.preventDefault();
    const sameRoot = (G.dragging || []).every((p) => norm(P.root(p)) === norm(P.root(t.dir)));
    ev.dataTransfer.dropEffect = ev.ctrlKey || !sameRoot ? 'copy' : 'move';
    setDropEl(t.el);
  });
  document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) setDropEl(null); });
  document.addEventListener('drop', (ev) => {
    if (!dropTargetFor(ev.target)) return;
    ev.preventDefault();
    dropInto(ev.target, dropPaths(ev), ev.ctrlKey);
  });
  // Tauri delivers native drag-and-drop with window coordinates instead of DOM events.
  let ctrlHeld = false;
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Control') ctrlHeld = true; });
  window.addEventListener('keyup', (ev) => { if (ev.key === 'Control') ctrlHeld = false; });
  window.addEventListener('blur', () => { ctrlHeld = false; });
  // Holding a drag over a tab for a moment switches to it, as in browsers.
  let tabHover = { el: null, timer: null };
  function hoverTab(target) {
    const el = target?.closest?.('.tab') || null;
    if (el === tabHover.el) return;
    clearTimeout(tabHover.timer);
    tabHover = { el, timer: el && setTimeout(() => switchTab(tabs.find((t) => t.id === Number(el.dataset.tab))), 700) };
  }
  // Spring-loaded folders (Finder): hold a drag over a folder and it blinks
  // and opens, so files can be carried down several levels in one drag.
  const spring = { el: null, timer: null };
  function springOver(target) {
    const t = target ? dropTargetFor(target) : null;
    const el = t && t.el !== content && !t.el.classList.contains('col') && !t.el.closest('.tab') ? t.el : null;
    if (el === spring.el) return;
    clearTimeout(spring.timer);
    spring.el?.classList.remove('springing');
    spring.el = el;
    // Not into a folder that is itself being dragged, nor the one already open.
    if (!el || (G.dragging || []).some((p) => isUnder(t.dir, p)) || norm(t.dir) === norm(state.cwd || '')) return;
    el.classList.add('springing');
    spring.timer = setTimeout(async () => {
      el.classList.remove('springing');
      el.classList.add('sprung');
      await new Promise((r) => setTimeout(r, 320)); // the double blink
      el.classList.remove('sprung');
      spring.el = null;
      const it = itemFromEl(el);
      if (it?.col != null) await columnClick(it.entry, it.col);
      else if (el.closest('#places')) await navigate(t.dir, { root: t.dir });
      else await navigate(t.dir);
    }, 700);
  }
  document.addEventListener('dragover', (ev) => { hoverTab(ev.target); springOver(ev.target); });
  document.addEventListener('drop', () => springOver(null), true);
  document.addEventListener('dragend', () => springOver(null));
  window.__finderDnd = {
    over: (x, y) => {
      const target = document.elementFromPoint(x, y);
      hoverTab(target);
      springOver(target);
      setDropEl(dropTargetFor(target)?.el || null);
    },
    drop: (x, y, paths) => {
      springOver(null);
      dropInto(document.elementFromPoint(x, y), paths.length ? paths : (G.dragging || []), ctrlHeld);
    },
    leave: () => { springOver(null); setDropEl(null); },
  };

  function conflictDialog(op, clash, dest) {
    return new Promise((resolve) => {
      let answer = null;
      const list = clash.slice(0, 5).map((p) => `<li>${esc(P.basename(p))}</li>`).join('') + (clash.length > 5 ? `<li>…還有 ${clash.length - 5} 個</li>` : '');
      const w = openDialog(`
        <div class="dlg-title">「${esc(displayName(dest))}」已有 ${clash.length} 個同名的項目</div>
        <ul class="dlg-list">${list}</ul>
        <div class="dlg-actions">
          <button data-act="cancel">取消</button>
          <button data-act="skip">略過這些項目</button>
          <button data-act="keep">保留兩者</button>
          <button class="primary" data-act="replace">取代</button>
        </div>`, { cls: 'conflict', onClose: () => resolve(answer) });
      $('[data-act="replace"]', w).focus();
      w.onclick = (ev) => {
        const a = ev.target.closest('[data-act]')?.dataset.act;
        if (!a) return;
        answer = a === 'cancel' ? null : a;
        closeDialog();
      };
    });
  }

  // Shown for copies that take a moment; cancellable.
  const progress = {
    timer: null,
    start(op) {
      clearTimeout(this.timer);
      $('#prog-title').textContent = op === 'move' ? '正在搬移…' : '正在拷貝…';
      $('#prog-sub').textContent = '';
      $('#progress .up-bar i').style.width = '0%';
      this.timer = setTimeout(() => { $('#progress').hidden = false; }, 400);
    },
    update([done, total, name]) {
      if (!total) return;
      $('#progress .up-bar i').style.width = `${Math.min(100, (done / total) * 100)}%`;
      $('#prog-sub').textContent = `${name ? `${name}　` : ''}${fmtSize(done)} / ${fmtSize(total)}`;
    },
    end() { clearTimeout(this.timer); $('#progress').hidden = true; },
  };
  api.onTransferProgress?.((p) => progress.update(p));
  $('#prog-cancel').addEventListener('click', () => api.cancelTransfer?.());

  // ---------- undo ----------
  // Each entry puts one action back; `run` resolves to false if that only
  // partly worked.
  const undoStack = [];
  function pushUndo(label, run) {
    undoStack.push({ label, run });
    if (undoStack.length > 50) undoStack.shift();
  }
  async function undo() {
    const u = undoStack.pop();
    if (!u) { toast('沒有可以復原的動作'); return; }
    let ok = false;
    try { ok = (await u.run()) !== false; } catch { ok = false; }
    dirCache.clear();
    await refresh(true);
    toast(ok ? `已復原${u.label}` : `無法完全復原${u.label}`);
  }
  const trashUndo = (paths) => async () => (await api.trash(paths)).length === 0;

  async function transfer(op, paths, dest) {
    // Name clashes: ask once, like Explorer (duplicates in the same folder never ask).
    let conflict = 'keep';
    const incoming = paths.filter((p) => norm(P.dirname(p)) !== norm(dest));
    if (incoming.length) {
      const there = await api.list(dest);
      const names = new Set((there.ok ? there.entries : []).map((e) => e.name.toLowerCase()));
      const clash = incoming.filter((p) => names.has(P.basename(p).toLowerCase()));
      if (clash.length) {
        conflict = await conflictDialog(op, clash, dest);
        if (!conflict) return;
      }
    }
    progress.start(op);
    let results;
    try { results = await api.transfer(op, paths, dest, conflict); } finally { progress.end(); }
    const failed = results.filter((r) => r.error && r.error !== 'SKIPPED' && r.error !== 'CANCELLED');
    const done = results.filter((r) => !r.error);
    const skipped = results.filter((r) => r.error === 'SKIPPED').length;
    const verb = op === 'move' ? '搬移' : '拷貝';
    if (results.some((r) => r.error === 'CANCELLED')) toast(`已取消，完成 ${done.length} 個項目`);
    else if (failed.length) toast(`${failed.length} 個項目失敗：${errText(failed[0].error)}`);
    else if (!done.length && skipped) toast(`已略過 ${skipped} 個同名的項目`);
    else toast(`已${verb} ${done.length} 個項目到「${displayName(dest)}」${skipped ? `，略過 ${skipped} 個` : ''}`);
    // Replacing overwrote files, so there's nothing safe to undo then.
    const moved = done.filter((r) => r.path !== r.src);
    if (moved.length && conflict !== 'replace') {
      pushUndo(verb, op === 'move'
        ? async () => {
          let ok = true;
          for (const r of moved.reverse()) {
            const [back] = await api.transfer('move', [r.path], P.dirname(r.src));
            if (back?.error) { ok = false; continue; }
            if (norm(P.basename(back.path)) !== norm(P.basename(r.src))) ok = (await api.rename(back.path, P.basename(r.src))).ok && ok;
          }
          return ok;
        }
        : async () => (await api.trash(moved.map((r) => r.path))).length === 0);
    }
    await Promise.all([listDir(dest, true), ...paths.map((p) => listDir(P.dirname(p), true))]);
    if (norm(dest) === norm(state.cwd)) state.sel = new Set(done.map((r) => r.path));
    await refresh(false);
  }

  // ---------- file actions ----------
  async function newFolder() {
    if (state.search.results || state.cwd === HOME) return;
    const res = await api.mkdir(state.cwd);
    if (!res.ok) { toast(`無法新增資料夾：${errText(res.error)}`); return; }
    pushUndo('新增資料夾', trashUndo([res.path]));
    await listDir(state.cwd, true);
    state.sel = new Set([res.path]); state.focus = res.path; state.anchor = res.path;
    if (inColumnsMode()) state.colActive = ancestors(state.cwd, state.colRoot).length - 1;
    computeEntries();
    await render();
    startRename(entryOf(res.path));
  }

  async function newFile() {
    if (state.search.results || state.cwd === HOME || !api.newFile) return;
    const res = await api.newFile(state.cwd);
    if (!res.ok) { toast(`無法新增檔案：${errText(res.error)}`); return; }
    pushUndo('新增文字文件', trashUndo([res.path]));
    await listDir(state.cwd, true);
    state.sel = new Set([res.path]); state.focus = res.path; state.anchor = res.path;
    if (inColumnsMode()) state.colActive = ancestors(state.cwd, state.colRoot).length - 1;
    computeEntries();
    await render();
    startRename(entryOf(res.path));
  }

  async function openTerminal(dir) {
    const err = await api.openTerminal(dir);
    if (err) toast(`無法開啟終端機：${err}`);
  }

  async function calcSize(e) {
    toast(`正在計算「${e.name}」的大小…`);
    const r = await api.dirSize(e.path);
    if (!r) { toast('無法計算大小'); return null; }
    dirSizes.set(norm(e.path), { ...r, mtime: e.mtime });
    toast(`「${e.name}」：${fmtSize(r.size)}，${r.files.toLocaleString()} 個檔案、${r.dirs.toLocaleString()} 個資料夾`);
    if (viewMode() === 'list') renderView(false);
    updatePane();
    return r;
  }

  async function compressSelected(entries) {
    const items = entries.filter((e) => !isVirtual(e));
    if (!items.length) return;
    toast('正在壓縮…');
    const res = await api.compress(items.map((e) => e.path));
    if (!res.ok) { toast(`無法壓縮：${errText(res.error)}`); return; }
    pushUndo('壓縮', trashUndo([res.path]));
    await afterCreate(res.path, `已建立「${P.basename(res.path)}」`);
  }

  // Extracted with the zip crate, or 7-Zip / Windows' tar for the rest (archive.rs).
  const ARCHIVES = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'iso', 'cab']);
  const archiveStem = (name) => name.replace(/\.[^.]+$/, '').replace(/\.tar$/i, '');
  async function extractZip(e) {
    toast('正在解壓縮…');
    const res = await api.extract(e.path);
    if (!res.ok) { toast(`無法解壓縮：${errText(res.error)}`); return; }
    pushUndo('解壓縮', trashUndo([res.path]));
    await afterCreate(res.path, `已解壓縮到「${P.basename(res.path)}」`);
  }

  // Refreshes the folder a new item landed in and selects it.
  async function afterCreate(path, msg) {
    toast(msg);
    const dir = P.dirname(path);
    await listDir(dir, true);
    if (norm(dir) === norm(state.cwd)) {
      state.sel = new Set([path]); state.focus = path; state.anchor = path;
      if (inColumnsMode()) state.colActive = ancestors(state.cwd, state.colRoot).length - 1;
    }
    await refresh(false);
  }

  async function trashSelected() {
    const items = selectedEntries().filter((e) => !isVirtual(e));
    if (!items.length) return;
    if (prefs.confirmTrash && !(await confirmDialog(
      items.length === 1 ? `要將「${items[0].name}」丟到資源回收筒嗎？` : `要將 ${items.length} 個項目丟到資源回收筒嗎？`, '丟到資源回收筒'))) return;
    const failed = await api.trash(items.map((e) => e.path));
    const ok = items.length - failed.length;
    const gone = items.map((e) => e.path).filter((p) => !failed.includes(p));
    if (gone.length && api.restoreTrash) pushUndo('丟到資源回收筒', async () => (await api.restoreTrash(gone)).length === 0);
    if (ok) toast(`已將 ${ok} 個項目丟到資源回收筒`);
    if (failed.length) toast(`有 ${failed.length} 個項目無法刪除`);
    if (inColumnsMode() && state.colActive < ancestors(state.cwd, state.colRoot).length - 1) {
      await navigate(P.dirname(state.cwd), { push: false });
      return;
    }
    state.sel.clear();
    await refresh();
  }

  function copySelected(op) {
    const items = selectedEntries().filter((e) => op === 'copy' || !isVirtual(e));
    if (!items.length) return;
    G.clip = { op, paths: items.map((e) => e.path) };
    api.clipboardWrite?.(G.clip.paths, op === 'move'); // shared with Explorer and the desktop
    toast(op === 'move' ? `已剪下 ${items.length} 個項目` : `已拷貝 ${items.length} 個項目`);
    if (op === 'move') render();
  }

  // Files on the clipboard: on Windows the system clipboard (so files copied
  // in Explorer paste here and the other way round), elsewhere our own.
  async function clipboardFiles() {
    if (!api.clipboardRead) return G.clip;
    const c = await api.clipboardRead();
    return c?.paths?.length ? { op: c.cut ? 'move' : 'copy', paths: c.paths } : null;
  }

  async function paste() {
    if (state.search.results || state.cwd === HOME) return;
    const clip = await clipboardFiles();
    if (!clip) return;
    if (clip.op === 'move') { G.clip = null; api.clipboardClear?.(); }
    await transfer(clip.op, clip.paths, state.cwd);
  }

  async function duplicateSelected() {
    const items = selectedEntries().filter((e) => !isVirtual(e));
    for (const dir of new Set(items.map((e) => P.dirname(e.path)))) {
      await transfer('copy', items.filter((e) => P.dirname(e.path) === dir).map((e) => e.path), dir);
    }
  }

  function copyPath() {
    const items = selectedEntries();
    const text = (items.length ? items.map((e) => e.path) : [state.cwd === HOME ? '' : state.cwd]).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('已拷貝路徑'), () => toast('無法存取剪貼簿'));
  }

  // Pins go to Explorer's Quick Access when possible, so both apps stay in sync.
  async function toggleFavorite(p) {
    const own = prefs.favorites.findIndex((f) => norm(f) === norm(p));
    const pin = !isPinned(p);
    if (own >= 0) prefs.favorites.splice(own, 1);
    else if (G.places.pinnedLive && api.pinHome && await api.pinHome(p, pin).then(() => true, () => false)) {
      G.places = await api.places();
    } else if (pin) prefs.favorites.push(p);
    else toast('無法從快速存取取消釘選，請在檔案總管中操作');
    savePrefs();
    if (state.cwd === HOME) refresh(true); else renderSidebar();
  }

  function startRename(e) {
    if (!e || isVirtual(e)) return;
    const el = revealPath(e.path);
    if (!el) return;
    const label = $('.label, .nm', el);
    if (!label) return;
    G.renaming = e.path;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = e.name;
    input.spellcheck = false;
    label.replaceWith(input);
    input.focus();
    const dot = e.isDir ? -1 : e.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : e.name.length);
    el.draggable = false;
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      G.renaming = null;
      // Put the name back now: the column view keeps unchanged rows as they
      // are, so it wouldn't redraw this one and the box would stay behind.
      if (input.isConnected) input.replaceWith(label);
      el.draggable = true;
      const name = input.value.trim();
      if (commit && name && name !== e.name) {
        const res = await api.rename(e.path, name);
        if (!res.ok) toast(`無法重新命名：${errText(res.error)}`);
        else {
          pushUndo('重新命名', async () => (await api.rename(res.path, e.name)).ok);
          await listDir(P.dirname(e.path), true);
          if (inColumnsMode() && e.isDir && isUnder(state.cwd, e.path)) { await navigate(res.path, { push: false, colActive: state.colActive }); return; }
          state.sel = new Set([res.path]); state.focus = res.path; state.anchor = res.path;
        }
      }
      await refresh(false);
      content.focus();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  }

  // ---------- menus ----------
  const menuEl = $('#menu');
  let menuActions = [];
  function openMenu(items, x, y) {
    menuActions = [];
    menuEl.innerHTML = items.map((it) => {
      if (it === '-') return '<div class="msep"></div>';
      if (it.html) return it.html;
      const idx = menuActions.push(it.action) - 1;
      return `<div class="mi${it.disabled ? ' disabled' : ''}" data-a="${idx}">
        <span class="check">${it.check ? '✓' : ''}</span><span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}
      </div>`;
    }).join('');
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    const left = Math.min(x, innerWidth - r.width - 8);
    const top = Math.min(y, innerHeight - r.height - 8);
    menuEl.style.left = `${Math.max(8, left)}px`;
    menuEl.style.top = `${Math.max(8, top)}px`;
    menuEl.style.transformOrigin = `${x - left}px ${y - top}px`;
  }
  function closeMenu() { menuEl.hidden = true; }
  menuEl.addEventListener('mousedown', (ev) => ev.stopPropagation());
  menuEl.addEventListener('click', (ev) => {
    const sw = ev.target.closest('[data-accent]');
    if (sw) { setAccent(sw.dataset.accent); closeMenu(); return; }
    const mi = ev.target.closest('.mi');
    if (!mi || mi.classList.contains('disabled')) return;
    closeMenu();
    menuActions[Number(mi.dataset.a)]?.();
  });
  document.addEventListener('mousedown', (ev) => { if (!menuEl.contains(ev.target)) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  const viewItems = () => [
    { label: '以圖像顯示', kbd: 'Ctrl+1', check: curView() === 'icons', action: () => setView('icons') },
    { label: '以列表顯示', kbd: 'Ctrl+2', check: curView() === 'list', action: () => setView('list') },
    { label: '以直欄顯示', kbd: 'Ctrl+3', check: curView() === 'columns', action: () => setView('columns') },
    { label: '以圖庫顯示', kbd: 'Ctrl+4', check: curView() === 'gallery', action: () => setView('gallery') },
  ];
  const sortItems = () => [['name', '名稱'], ['kind', '類型'], ['date', '修改日期'], ['size', '大小']].map(([k, l]) => ({
    label: `依${l}排序`, check: curSort().key === k,
    action: () => setSort({ key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 }),
  }));

  function itemMenu(entries, x, y) {
    const one = entries.length === 1 ? entries[0] : null;
    const isFav = one?.isDir && isPinned(one.path);
    const virt = entries.some(isVirtual);
    openMenu([
      { label: '打開', kbd: 'Enter', action: () => entries.forEach(openEntry) },
      ...(one?.isDir ? [{ label: '在新分頁中打開', kbd: '滑鼠中鍵', action: () => openTab(one.path, { activate: false }) }] : []),
      { label: one ? `快速查看「${one.name}」` : `快速查看 ${entries.length} 個項目`, kbd: 'Space', action: () => ql.open() },
      '-',
      one
        ? { label: '重新命名', kbd: 'F2', disabled: virt, action: () => startRename(one) }
        : { label: `批次重新命名 ${entries.length} 個項目…`, kbd: 'F2', disabled: virt, action: () => batchRename(entries) },
      { label: '製作副本', kbd: 'Ctrl+D', disabled: virt, action: duplicateSelected },
      { label: '拷貝', kbd: 'Ctrl+C', action: () => copySelected('copy') },
      { label: '剪下', kbd: 'Ctrl+X', disabled: virt, action: () => copySelected('move') },
      { label: '拷貝路徑', kbd: 'Ctrl+Alt+C', action: copyPath },
      '-',
      ...(api.compress && !virt ? [{ label: '壓縮成 ZIP 檔', action: () => compressSelected(entries) }] : []),
      ...(one && ARCHIVES.has(one.ext) && api.extract ? [{ label: `解壓縮到「${archiveStem(one.name)}」`, action: () => extractZip(one) }] : []),
      ...(one?.isDir && !isVirtual(one) && api.dirSize ? [{ label: '計算大小', action: () => calcSize(one) }] : []),
      ...(one?.isDir && !isVirtual(one) && api.openTerminal ? [{ label: '在終端機中開啟', action: () => openTerminal(one.path) }] : []),
      ...cloudItems(entries),
      '-',
      ...(one?.isDir && one.kind !== 'drive' ? [{ label: isFav ? '從快速存取取消釘選' : '釘選到快速存取', action: () => toggleFavorite(one.path) }] : []),
      ...(one?.ext === 'lnk' && api.resolveLink ? [{ label: '顯示原始項目', action: () => showOriginal(one) }] : []),
      { label: isWin ? '在檔案總管中顯示' : '在系統檔案管理員中顯示', action: () => api.reveal(entries[0].path) },
      '-',
      { label: '丟到資源回收筒', kbd: 'Delete', disabled: virt, action: trashSelected },
      ...(api.nativeMenu ? ['-',
        { label: '內容', kbd: 'Alt+Enter', disabled: virt, action: () => showProperties(entries.map((e) => e.path)) },
        { label: '顯示更多選項', kbd: 'Shift+F10', disabled: virt, action: () => nativeMenu(entries) }] : []),
    ], x, y);
  }

  // OneDrive's two commands, as in Explorer's menu (which has them itself).
  function cloudItems(entries) {
    if (!api.cloudPin || !entries.some((e) => e.cloud)) return [];
    const pinned = entries.every((e) => e.cloud === 'pinned');
    return ['-',
      { label: '一律保留在此裝置', check: pinned, action: () => setPinState(entries, pinned ? 'unspecified' : 'pinned') },
      { label: '釋放空間', action: () => setPinState(entries, 'unpinned') }];
  }
  async function setPinState(entries, pinState) {
    const failed = await api.cloudPin(entries.map((e) => e.path), pinState);
    if (failed.length) toast(failed.length === 1 ? `無法變更「${P.basename(failed[0])}」的同步狀態` : `有 ${failed.length} 個項目無法變更同步狀態`);
    refresh(true);
  }

  // Explorer's own context menu (7-Zip, VS Code, Git, OneDrive… entries).
  // Our menu items (with actions) -> the plain list the native side inserts.
  function toExtras(items) {
    const actions = [];
    const conv = (list) => list.filter(Boolean).map((it) => {
      if (it === '-') return { label: '-' };
      if (it.children) return { label: it.label, children: conv(it.children) };
      return { id: actions.push(it.action) - 1, label: it.label, checked: !!it.check, disabled: !!it.disabled };
    });
    return { extras: conv(items), actions };
  }

  // What Explorer's menu lacks, shown above its own items.
  function appItemsFor(entries) {
    const one = entries.length === 1 ? entries[0] : null;
    return [
      one?.isDir && { label: '在新分頁中打開', action: () => openTab(one.path, { activate: false }) },
      { label: one ? '快速查看' : `快速查看 ${entries.length} 個項目`, action: () => ql.open() },
      entries.length > 1 && { label: `批次重新命名 ${entries.length} 個項目…`, action: () => batchRename(entries) },
      { label: '拷貝路徑', action: copyPath },
      one?.isDir && api.dirSize && { label: '計算大小', action: () => calcSize(one) },
      one?.ext === 'lnk' && api.resolveLink && { label: '顯示原始項目', action: () => showOriginal(one) },
    ];
  }
  function appItemsForBackground() {
    const views = [['icons', '圖像'], ['list', '列表'], ['columns', '直欄'], ['gallery', '圖庫']];
    const sorts = [['name', '名稱'], ['date', '修改日期'], ['size', '大小'], ['kind', '類型']];
    const groups = [['none', '（無）'], ['kind', '類型'], ['date', '修改日期'], ['size', '大小']];
    return [
      { label: '檢視', children: views.map(([v, l]) => ({ label: l, check: curView() === v, action: () => setView(v) })) },
      { label: '排序方式', children: sorts.map(([k, l]) => ({ label: l, check: curSort().key === k, action: () => setSort({ key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 }) })) },
      ['list', 'icons'].includes(viewMode()) && { label: '分組依據', children: groups.map(([g, l]) => ({ label: l, check: curGroup() === g, action: () => setGroup(g) })) },
      { label: '重新整理', action: () => refresh(true) },
      '-',
      undoStack.length && { label: `復原${undoStack[undoStack.length - 1].label}`, action: undo },
      { label: '顯示隱藏的項目', check: prefs.showHidden, action: toggleHidden },
      api.openTerminal && { label: '在終端機中開啟', action: () => openTerminal(state.cwd) },
    ];
  }
  // Right-click on Windows shows Explorer's own menu unless Settings say otherwise.
  function useWinMenu() { return !!api.nativeMenu && prefs.menuStyle !== 'finder'; }

  async function nativeMenu(entries, { background = false, shift = false, items = null } = {}) {
    if (!api.nativeMenu) return false;
    let paths = [state.cwd];
    if (!background) {
      const items = entries.filter((e) => !isVirtual(e));
      if (!items.length) return false;
      // The shell builds one menu per folder.
      const dir = norm(P.dirname(items[0].path));
      paths = items.filter((e) => norm(P.dirname(e.path)) === dir).map((e) => e.path);
    } else if (state.cwd === HOME || state.search.results) return false;
    closeMenu();
    const { extras, actions } = toExtras(items || []);
    let verb = '';
    try { verb = await api.nativeMenu(paths, background, shift, extras); } catch (err) { toast(`無法顯示選單：${err}`); return true; }
    if (verb.startsWith('app:')) { await actions[Number(verb.slice(4))]?.(); return true; }
    if (verb === 'rename') {
      const items = entries.filter((e) => paths.includes(e.path));
      if (items.length === 1) startRename(items[0]); else batchRename(items);
      return true;
    }
    // Copy/Cut in that menu fill the shared clipboard; other commands may
    // change files, which the folder watcher picks up.
    setTimeout(() => refresh(true), 500);
    return true;
  }

  async function showProperties(paths) {
    if (!api.properties || !paths.length) return;
    const dir = norm(P.dirname(paths[0]));
    try { await api.properties(paths.filter((p) => norm(P.dirname(p)) === dir)); } catch (err) { toast(`無法顯示內容：${err}`); }
  }

  async function backgroundMenu(x, y) {
    const clip = state.cwd === HOME ? null : await clipboardFiles();
    if (state.cwd === HOME) {
      openMenu([
        { label: '新分頁', kbd: 'Ctrl+T', action: () => openTab(newTabDir()) },
        { label: '重新整理', kbd: 'F5', action: () => refresh(true) },
      ], x, y);
      return;
    }
    openMenu([
      { label: '新增資料夾', kbd: 'Ctrl+Shift+N', disabled: !!state.search.results, action: newFolder },
      ...(api.newFile ? [{ label: '新增文字文件', kbd: 'Ctrl+Alt+N', disabled: !!state.search.results, action: newFile }] : []),
      { label: clip ? `貼上 ${clip.paths.length} 個項目` : '貼上', kbd: 'Ctrl+V', disabled: !clip || !!state.search.results, action: paste },
      ...(undoStack.length ? [{ label: `復原${undoStack[undoStack.length - 1].label}`, kbd: 'Ctrl+Z', action: undo }] : []),
      '-',
      ...viewItems(),
      '-',
      ...sortItems(),
      '-',
      { label: '顯示隱藏的項目', kbd: 'Ctrl+Shift+.', check: prefs.showHidden, action: toggleHidden },
      ...(api.openTerminal ? [{ label: '在終端機中開啟', action: () => openTerminal(state.cwd) }] : []),
      { label: isWin ? '在檔案總管中打開' : '在系統檔案管理員中打開', action: () => api.open(state.cwd) },
      ...(api.nativeMenu ? ['-',
        { label: '內容', kbd: 'Alt+Enter', disabled: !!state.search.results, action: () => showProperties([state.cwd]) },
        { label: '顯示更多選項', kbd: 'Shift+F10', disabled: !!state.search.results, action: () => nativeMenu([], { background: true }) }] : []),
    ], x, y);
  }

  content.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    if (ev.target.closest('.lhead')) { listHeaderMenu(ev.clientX, ev.clientY); return; }
    const it = itemFromEl(ev.target);
    // Windows: Explorer's menu (Shift adds its extended items); otherwise ours.
    const native = useWinMenu() || (ev.shiftKey && api.nativeMenu);
    if (it?.entry) {
      if (it.col != null) await columnClick(it.entry, it.col);
      else if (!state.sel.has(it.entry.path)) { state.anchor = it.entry.path; setSelection([it.entry.path]); }
      const entries = it.col != null ? [it.entry] : selectedEntries();
      if (!(native && await nativeMenu(entries, { shift: ev.shiftKey, items: appItemsFor(entries) }))) itemMenu(entries, ev.clientX, ev.clientY);
    } else if (!(native && await nativeMenu([], { background: true, shift: ev.shiftKey, items: appItemsForBackground() }))) {
      backgroundMenu(ev.clientX, ev.clientY);
    }
  });

  $('#btn-more').addEventListener('click', (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    openMenu([
      ...viewItems(),
      '-',
      ...sortItems(),
      '-',
      { label: '顯示隱藏的項目', kbd: 'Ctrl+Shift+.', check: prefs.showHidden, action: toggleHidden },
      { label: prefs.sidebarHidden ? '顯示側邊欄' : '隱藏側邊欄', kbd: 'Ctrl+Alt+S', action: toggleSidebar },
      { label: inColumnsMode() ? '顯示預覽欄' : '預覽窗格', kbd: 'Alt+P', check: inColumnsMode() ? !!prefs.colPreview : !!prefs.previewPane, action: togglePane },
      ...(viewMode() === 'list' && api.dirSize ? [{ label: '計算所有大小', check: !!prefs.calcSizes, action: toggleCalcSizes }] : []),
      { label: '重新整理', kbd: 'F5', action: () => refresh(true) },
      '-',
      { label: '設定…', kbd: 'Ctrl+,', action: () => openSettings() },
      ...(api.quit && prefs.keepRunning ? [{ label: '結束 Finder', action: () => api.quit() }] : []),
    ], r.right - 230, r.bottom + 6);
  });

  // sidebar
  $('#places').addEventListener('click', (ev) => {
    const tw = ev.target.closest('[data-twisty]');
    if (tw && !tw.classList.contains('none')) { toggleTree(tw.dataset.twisty); return; }
    const sec = ev.target.closest('[data-sec]');
    if (sec) {
      prefs.secCollapsed = { ...prefs.secCollapsed, [sec.dataset.sec]: !prefs.secCollapsed?.[sec.dataset.sec] };
      savePrefs();
      renderSidebar();
      return;
    }
    const p = ev.target.closest('.place');
    if (p?.dataset.smart) { const sf = smartById(p.dataset.smart); if (sf) openSmart(sf); return; }
    if (p?.dataset.path === PC) { toggleTree(PC); return; }
    if (p) navigate(p.dataset.path, { root: p.dataset.path });
  });
  $('#places').addEventListener('dblclick', (ev) => {
    const p = ev.target.closest('.place');
    if (p?.dataset.path && p.dataset.path !== HOME && p.dataset.path !== PC && !ev.target.closest('[data-twisty]')) toggleTree(p.dataset.path);
  });
  $('#places').addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const p = ev.target.closest('.place');
    if (!p) return;
    if (p.dataset.smart) { smartMenu(smartById(p.dataset.smart), ev.clientX, ev.clientY); return; }
    const path = p.dataset.path;
    if (path === PC) return;
    if (path === HOME) {
      openMenu([{ label: '在新分頁中打開', action: () => openTab(HOME, { activate: false }) }], ev.clientX, ev.clientY);
      return;
    }
    const pinnedRow = !!p.dataset.pinned;
    openMenu([
      { label: '打開', action: () => navigate(path, { root: path }) },
      { label: '在新分頁中打開', kbd: '滑鼠中鍵', action: () => openTab(path, { activate: false }) },
      { label: G.treeOpen.has(path) ? '摺疊' : '展開', action: () => toggleTree(path) },
      '-',
      { label: isWin ? '在檔案總管中打開' : '在系統檔案管理員中打開', action: () => api.open(path) },
      '-',
      { label: pinnedRow || isPinned(path) ? '從快速存取取消釘選' : '釘選到快速存取', action: () => toggleFavorite(path) },
    ], ev.clientX, ev.clientY);
  });

  // ---------- tab bar & middle-click ----------
  // Middle-click: close a tab, or open a folder in a new background tab.
  document.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); }); // no autoscroll
  document.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return;
    const tab = ev.target.closest('.tab');
    if (tab) { closeTab(tabs.find((t) => t.id === Number(tab.dataset.tab))); return; }
    const place = ev.target.closest('.place, .crumb');
    if (place?.dataset.smart) { const sf = smartById(place.dataset.smart); if (sf) openTab(sf.root, { activate: false, smart: sf }); return; }
    if (place?.dataset.path) { openTab(place.dataset.path, { activate: false }); return; }
    const it = itemFromEl(ev.target);
    if (it?.entry?.isDir) openTab(it.entry.path, { activate: false });
  });
  // Click a tab to switch to it; drag it sideways to reorder.
  $('#tabs').addEventListener('mousedown', (ev) => {
    const tab = ev.target.closest('.tab');
    if (ev.button !== 0 || !tab) return;
    const t = tabs.find((x) => x.id === Number(tab.dataset.tab));
    switchTab(t);
    const startX = ev.clientX;
    let dragging = false;
    let el = null;
    const move = (e) => {
      if (!dragging && Math.abs(e.clientX - startX) < 6) return;
      el ||= $(`.tab[data-tab="${t.id}"]`);
      if (!el) return;
      dragging = true;
      el.classList.add('dragging');
      el.style.transform = `translateX(${e.clientX - startX}px)`;
    };
    const up = (e) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragging) return;
      // Drop position: before the first tab whose middle is right of the pointer.
      const others = $$('.tab', $('#tabs')).filter((x) => x !== el);
      let idx = others.findIndex((x) => { const r = x.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
      if (idx < 0) idx = others.length;
      tabs.splice(tabs.indexOf(t), 1);
      tabs.splice(idx, 0, t);
      renderTabs();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  $('#tabs').addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const el = ev.target.closest('.tab');
    if (!el) return;
    const t = tabs.find((x) => x.id === Number(el.dataset.tab));
    openMenu([
      { label: '新分頁', kbd: 'Ctrl+T', action: () => openTab(newTabDir()) },
      { label: '複製分頁', action: () => openTab(t.cwd || HOME, { smart: smartById(t.search.smart) }) },
      '-',
      { label: '關閉分頁', kbd: '滑鼠中鍵', action: () => closeTab(t) },
      { label: '關閉其他分頁', disabled: tabs.length < 2, action: async () => { tabs.splice(0, tabs.length, t); await switchTab(t); renderTabs(); } },
    ], ev.clientX, ev.clientY);
  });
  $('#tab-new').addEventListener('click', () => openTab(newTabDir()));
  $('#tabbar').addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.tab, button')) return;
    if (!isTauri) W.toggleMaximize(); // Tauri drag regions maximize on their own
  });
  // Address bar: click the empty part of the path bar (or Ctrl+L / Alt+D / F4)
  // to type a path, like Explorer and OneCommander.
  function editPath() {
    if (state.search.results) return;
    const bar = $('#pathbar');
    bar.classList.add('editing');
    bar.innerHTML = `<input id="path-input" spellcheck="false" placeholder="輸入路徑，按 Enter 前往" value="${esc(state.cwd === HOME ? '' : state.cwd)}">`;
    const input = $('#path-input');
    input.focus();
    input.select();
    let done = false;
    const finish = (go) => {
      if (done) return;
      done = true;
      bar.classList.remove('editing');
      renderPathbar();
      if (go) goToPath(input.value); else content.focus();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(false));
  }

  async function goToPath(raw) {
    let p = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!p) return;
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = G.places.home + p.slice(1);
    if (isWin) {
      p = p.replace(/\//g, '\\');
      if (/^[a-z]:$/i.test(p)) p += '\\';
    }
    if ((await api.list(p)).ok) { await navigate(p, { root: guessRoot(p) }); content.focus(); return; }
    // A file: open its folder with the file selected.
    const parent = P.dirname(p);
    const res = parent && parent !== p ? await api.list(parent) : null;
    const hit = res?.ok && res.entries.find((e) => norm(e.path) === norm(p));
    if (hit) { await navigate(parent, { root: guessRoot(parent), select: hit.path }); content.focus(); return; }
    toast(`找不到「${p}」`);
  }

  $('#pathbar').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) { editPath(); return; }
    const c = ev.target.closest('.crumb');
    if (c?.dataset.path) navigate(c.dataset.path);
  });

  // ---------- view / prefs ----------
  // `asDefault` (from Settings) changes the default view instead of this folder's.
  function setView(v, { asDefault = false } = {}) {
    if (asDefault) { prefs.view = v; savePrefs(); }
    if (curView() === v) return;
    state.view = v;
    if (!asDefault) {
      if (folderPref() !== null && !state.search.results) rememberFolder({ view: v });
      else prefs.view = v;
      savePrefs();
    }
    if (v === 'columns' && state.cwd !== HOME) state.colActive = ancestors(state.cwd, state.colRoot).length - 1;
    computeEntries();
    render({ animate: true });
    watchCurrent();
  }
  function toggleHidden() {
    prefs.showHidden = !prefs.showHidden;
    savePrefs();
    toast(prefs.showHidden ? '顯示隱藏的項目' : '不顯示隱藏的項目');
    computeEntries();
    render();
  }
  function toggleSidebar() {
    prefs.sidebarHidden = !prefs.sidebarHidden;
    savePrefs();
    document.body.classList.toggle('sidebar-hidden', !!prefs.sidebarHidden);
  }
  function setAccent(c) {
    prefs.accent = c;
    savePrefs();
    applyAccent();
  }
  function applyAccent() {
    const c = prefs.accent;
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(', ');
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent-rgb', rgb);
  }
  function setIconSize(v) {
    prefs.icon = Math.max(48, Math.min(160, v));
    savePrefs();
    flipIcons(() => document.documentElement.style.setProperty('--icon', `${prefs.icon}px`));
    $('#zoom').value = prefs.icon;
    clearTimeout(setIconSize.t);
    setIconSize.t = setTimeout(() => { if (viewMode() === 'icons') renderView(false); }, 250);
  }

  $('#view-seg').addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#btn-back').addEventListener('click', goBack);
  $('#btn-fwd').addEventListener('click', goForward);
  $('#btn-newfolder').addEventListener('click', newFolder);
  $('#zoom').addEventListener('input', (ev) => setIconSize(Number(ev.target.value)));

  // ---------- search ----------
  const searchInput = $('#search');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    state.search.query = searchInput.value;
    $('#search-box').classList.toggle('has-text', !!searchInput.value);
    $('#search-scope').hidden = !searchInput.value && !filtersOn();
    $('[data-scope="folder"]').textContent = `「${tabTitle({ ...state, search: { results: null } })}」`;
    clearTimeout(searchTimer);
    if (state.search.scope !== 'folder') searchTimer = setTimeout(runDeepSearch, 300);
    else { state.search.results = null; computeEntries(); renderView(false).then(() => { renderStatus(); renderPathbar(); renderToolbar(); }); }
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { setScope('deep'); }
    else if (ev.key === 'Escape') { clearSearch(true); content.focus(); }
    else if (ev.key === 'ArrowDown') { content.focus(); moveSelection('down', ev); ev.preventDefault(); }
  });
  $('#search-clear').addEventListener('click', () => clearSearch(true));
  $('#search-save').addEventListener('click', saveSmart);
  $('#search-scope').addEventListener('click', (ev) => { const b = ev.target.closest('[data-scope]'); if (b) setScope(b.dataset.scope); });
  $('#search-scope').addEventListener('change', (ev) => {
    const sel = ev.target.closest('.sf');
    if (!sel) return;
    state.search.filters = { ...state.search.filters, [sel.id.slice(3)]: sel.value };
    sel.classList.toggle('on', !!sel.value);
    // Searches below this folder filter while walking (so the result limit counts only matches).
    if (state.search.scope !== 'folder') { runDeepSearch(); return; }
    computeEntries();
    render();
  });
  // Everything (whole-PC search) shows up when its command-line client is installed.
  api.everythingAvailable?.().then((ok) => { $('[data-scope="pc"]').hidden = !ok; });
  $('[data-scope="content"]').hidden = !api.contentSearch;

  function setScope(scope) {
    state.search.scope = scope;
    $$('#search-scope [data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
    if (scope !== 'folder') runDeepSearch();
    else { state.search.results = null; $('#search-status').textContent = ''; computeEntries(); render(); }
  }

  // The type / size / date filters in the form the search backends take.
  const KIND_CATS = { image: ['image'], video: ['video'], audio: ['audio'], docs: ['pdf', 'doc', 'sheet', 'slide', 'text'], archive: ['archive'], code: ['code'] };
  function kindExts(kind) {
    if (kind === 'app') return ['exe', 'msi', 'lnk', 'bat', 'cmd', 'appref-ms'];
    return (KIND_CATS[kind] || []).flatMap((c) => I.CATS[c].exts.split(' '));
  }
  const SIZE_RANGE = { lt100k: { smaller: 100e3 }, gt1m: { larger: 1e6 }, gt100m: { larger: 100e6 }, gt1g: { larger: 1e9 } };
  function searchFilter(f) {
    const out = {};
    if (f.kind === 'dir') out.dirs = true;
    else if (f.kind) out.exts = kindExts(f.kind);
    if (f.size) Object.assign(out, SIZE_RANGE[f.size]);
    if (f.date) out.after = Date.now() - Number(f.date) * DAY;
    return out;
  }
  // Everything takes the same filters as search modifiers.
  function everythingQuery(q, f) {
    const parts = [q];
    if (f.kind === 'dir') parts.push('folder:');
    else if (f.kind) parts.push(`ext:${kindExts(f.kind).join(';')}`);
    if (f.size) parts.push({ lt100k: 'size:<100kb', gt1m: 'size:>1mb', gt100m: 'size:>100mb', gt1g: 'size:>1gb' }[f.size]);
    return parts.filter(Boolean).join(' ');
  }

  async function runDeepSearch() {
    const q = state.search.query.trim();
    if (!q && !filtersOn()) return;
    state.search.busy = true;
    $('#search-status').textContent = '搜尋中…';
    renderStatus();
    const tab = state;
    const pc = state.search.scope === 'pc';
    const inside = state.search.scope === 'content';
    const f = state.search.filters || {};
    const root = state.cwd === HOME ? G.places.home : state.cwd;
    let res;
    if (pc) res = await api.everything(everythingQuery(q, f));
    else if (inside && api.contentSearch) res = q ? await api.contentSearch(root, q, searchFilter(f)) : { entries: [], indexed: true };
    else res = await api.search(root, q, prefs.showHidden, searchFilter(f));
    if (tab !== state || state.search.query.trim() !== q) return;
    if (!res || res.error || res.indexed === false) {
      state.search.busy = false;
      $('#search-status').textContent = pc ? '無法使用 Everything（請確認它正在執行）'
        : res?.indexed === false ? '這個資料夾沒有 Windows 搜尋索引，無法搜尋內容（可在 Windows 設定 →「搜尋 Windows」加入）'
          : res?.error ? `無法搜尋內容：${res.error}` : '';
      if (inside) { state.search.results = []; computeEntries(); render(); } else renderStatus();
      return;
    }
    state.search.busy = false;
    state.search.results = res.entries;
    $('#search-status').textContent = res.partial ? `顯示前 ${res.entries.length} 個結果` : `${res.entries.length} 個結果`;
    state.sel.clear();
    computeEntries();
    render({ animate: true });
  }

  // ---------- smart folders (Finder's saved searches) ----------
  function smartById(id) { return (id && (prefs.smart || []).find((x) => x.id === id)) || null; }
  function smartDesc(sf) {
    const f = sf.filters || {};
    const opt = (id, v) => (v ? $(`#sf-${id} option[value="${v}"]`)?.textContent : null);
    const where = sf.scope === 'pc' ? '整台電腦' : `${displayName(sf.root)}${{ deep: '（包含子資料夾）', content: '（檔案內容）' }[sf.scope] || ''}`;
    return [sf.query && `「${sf.query}」`, opt('kind', f.kind), opt('size', f.size), opt('date', f.date), `位置：${where}`].filter(Boolean).join('，');
  }
  async function openSmart(sf, { silent = false } = {}) {
    if (!(await navigate(sf.root, { root: sf.root, silent: true }))) return false;
    state.search = { query: sf.query, scope: sf.scope, results: null, busy: false, filters: { ...sf.filters }, smart: sf.id };
    if (silent) return true;
    syncSearchUi();
    computeEntries();
    await render({ animate: true });
    watchCurrent();
    if (sf.scope !== 'folder') runDeepSearch();
    return true;
  }
  // 儲存 in the search bar: a new smart folder, or saves the criteria of the open one.
  async function saveSmart() {
    const crit = { root: state.cwd, query: state.search.query.trim(), scope: state.search.scope, filters: { ...state.search.filters } };
    if (!crit.query && !filtersOn()) return;
    const cur = smartById(state.search.smart);
    if (cur) {
      Object.assign(cur, crit);
      savePrefs();
      renderSidebar();
      toast(`已更新「${cur.name}」`);
      return;
    }
    const name = await promptDialog('儲存為智慧型資料夾', crit.query || '智慧型資料夾', '加入側邊欄');
    if (!name) return;
    const sf = { id: Date.now().toString(36), name, ...crit };
    prefs.smart = [...(prefs.smart || []), sf];
    savePrefs();
    state.search.smart = sf.id;
    render();
    toast(`已將「${name}」加入側邊欄`);
  }
  function smartMenu(sf, x, y) {
    if (!sf) return;
    openMenu([
      { label: '打開', action: () => openSmart(sf) },
      { label: '在新分頁中打開', kbd: '滑鼠中鍵', action: () => openTab(sf.root, { activate: false, smart: sf }) },
      '-',
      { label: '重新命名…', action: async () => {
        const name = await promptDialog('重新命名智慧型資料夾', sf.name, '重新命名');
        if (!name) return;
        sf.name = name;
        savePrefs();
        render();
      } },
      { label: '從側邊欄移除', action: () => {
        prefs.smart = prefs.smart.filter((x) => x !== sf);
        tabs.forEach((t) => { if (t.search.smart === sf.id) delete t.search.smart; });
        savePrefs();
        render();
      } },
    ], x, y);
  }

  function clearSearch(rerender, silent = false) {
    const had = state.search.query || state.search.results;
    state.search = { query: '', scope: 'folder', results: null, busy: false, filters: {} };
    if (silent) return; // background tab: leave the visible search box alone
    syncSearchUi();
    if (rerender && had) { computeEntries(); render(); }
  }

  // The search box shows the active tab's search.
  function syncSearchUi() {
    const q = state.search.query;
    searchInput.value = q;
    $('#search-box').classList.toggle('has-text', !!q);
    $('#search-scope').hidden = !q && !filtersOn();
    $('#search-status').textContent = '';
    $('[data-scope="folder"]').textContent = `「${tabTitle({ ...state, search: { results: null } })}」`;
    for (const sel of $$('#search-scope .sf')) {
      sel.value = state.search.filters?.[sel.id.slice(3)] || '';
      sel.classList.toggle('on', !!sel.value);
    }
    $$('#search-scope [data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.search.scope));
  }

  // ---------- keyboard ----------
  let typeBuf = ''; let typeTimer = null;

  function moveSelection(dir, ev) {
    const mode = viewMode();
    if (mode === 'columns') { moveColumns(dir); return; }
    const list = state.entries;
    if (!list.length) return;
    let idx = list.findIndex((e) => e.path === state.focus);
    let step = 0;
    if (mode === 'icons') {
      const items = $$('.gi', view);
      const top0 = items[0]?.offsetTop;
      let perRow = view._v?.perRow || items.findIndex((el) => el.offsetTop !== top0);
      if (perRow < 1) perRow = items.length;
      step = { left: -1, right: 1, up: -perRow, down: perRow }[dir];
    } else if (mode === 'gallery') {
      step = { left: -1, right: 1, up: -1, down: 1 }[dir];
    } else if (mode === 'home') {
      step = { left: -1, right: 1, up: -1, down: 1 }[dir];
    } else {
      if (dir === 'left' || dir === 'right') return;
      step = dir === 'up' ? -1 : 1;
    }
    let next = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + step));
    const target = list[next];
    if (ev?.shiftKey && state.anchor) {
      const paths = list.map((e) => e.path);
      const a = paths.indexOf(state.anchor);
      state.sel = new Set(paths.slice(Math.min(a, next), Math.max(a, next) + 1));
      state.focus = target.path;
      paintSelection();
    } else {
      state.anchor = target.path;
      setSelection([target.path]);
    }
    revealPath(target.path);
    if (ql.isOpen) ql.update();
  }

  async function moveColumns(dir) {
    const chain = ancestors(state.cwd, state.colRoot);
    const n = chain.length - 1;
    const a = state.colActive;
    if (dir === 'up' || dir === 'down') {
      const list = state.colLists[a] || [];
      if (!list.length) return;
      const curPath = a === n ? state.focus : chain[a + 1];
      let idx = list.findIndex((e) => e.path === curPath);
      idx = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + (dir === 'up' ? -1 : 1)));
      await columnClick(list[idx], a);
    } else if (dir === 'right') {
      if (a === n - 1 || (a === n && state.focus && entryOf(state.focus)?.isDir)) {
        const list = state.colLists[n] || [];
        if (a === n) return;
        if (list[0]) await columnClick(list[0], n);
      }
    } else if (dir === 'left') {
      if (a === n && n > 0) {
        state.colActive = n - 1;
        state.sel.clear(); state.focus = null;
        await render();
      } else if (a < n && a > 0) {
        await navigate(chain[a], { colActive: a - 1, animate: false });
      } else if (a === 0 && n > 0) {
        // Already at the leftmost column: widen the root to its parent.
        const parent = P.dirname(state.colRoot);
        if (parent !== state.colRoot) { state.colRoot = parent; await navigate(chain[a + 1] ? chain[1] : chain[0], { colActive: 0, animate: false }); }
      }
    }
    if (ql.isOpen) ql.update();
  }

  document.addEventListener('keydown', async (ev) => {
    if (G.renaming) return;
    const inInput = ev.target.matches?.('input, textarea, select');
    const ctrl = ev.ctrlKey || ev.metaKey;
    const k = ev.key;
    if (!dlg.el.hidden) { if (k === 'Escape') closeDialog(); return; } // dialogs handle their own keys

    if (k === 'Escape') {
      if (!menuEl.hidden) { closeMenu(); return; }
      if (ql.isOpen) { ql.close(); return; }
      if (state.search.query) { clearSearch(true); return; }
      return;
    }
    if (ctrl && k.toLowerCase() === 'f') { ev.preventDefault(); searchInput.focus(); searchInput.select(); return; }
    if (ctrl && k === ',') { ev.preventDefault(); openSettings(); return; }
    if (inInput) return;
    if ((ctrl && k.toLowerCase() === 'l') || (ev.altKey && k.toLowerCase() === 'd') || k === 'F4') { ev.preventDefault(); editPath(); return; }
    if (ctrl && ev.altKey && k.toLowerCase() === 'n') { ev.preventDefault(); newFile(); return; }
    if (ev.altKey && !ctrl && k.toLowerCase() === 'p') { ev.preventDefault(); togglePane(); return; }
    if (ctrl && k.toLowerCase() === 't') { ev.preventDefault(); openTab(newTabDir()); return; }
    if (ctrl && k.toLowerCase() === 'w') { ev.preventDefault(); closeTab(state); return; }
    if (ctrl && k === 'Tab') { ev.preventDefault(); cycleTab(ev.shiftKey ? -1 : 1); return; }
    if (ctrl && ['1', '2', '3', '4'].includes(k)) { ev.preventDefault(); setView(['icons', 'list', 'columns', 'gallery'][Number(k) - 1]); return; }
    if (ctrl && ev.shiftKey && k.toLowerCase() === 'n') { ev.preventDefault(); newFolder(); return; }
    if (ctrl && ev.shiftKey && (k === '.' || k === '>')) { ev.preventDefault(); toggleHidden(); return; }
    if (ctrl && ev.altKey && k.toLowerCase() === 's') { ev.preventDefault(); toggleSidebar(); return; }
    if (ctrl && ev.altKey && k.toLowerCase() === 'c') { ev.preventDefault(); copyPath(); return; }
    if (ctrl && k.toLowerCase() === 'a') {
      ev.preventDefault();
      if (!inColumnsMode()) setSelection(state.entries.map((e) => e.path));
      else selectInColumn(state.colActive, (state.colLists[state.colActive] || []).map((e) => e.path));
      return;
    }
    if (ctrl && k.toLowerCase() === 'c') { copySelected('copy'); return; }
    if (ctrl && k.toLowerCase() === 'x') { copySelected('move'); return; }
    if (ctrl && k.toLowerCase() === 'v') { paste(); return; }
    if (ctrl && !ev.shiftKey && k.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
    if (ev.altKey && k === 'Enter') {
      ev.preventDefault();
      const s = selectedEntries().filter((e) => !isVirtual(e));
      showProperties(s.length ? s.map((e) => e.path) : state.cwd !== HOME ? [state.cwd] : []);
      return;
    }
    if ((ev.shiftKey && k === 'F10') || k === 'ContextMenu') {
      ev.preventDefault();
      const s = selectedEntries();
      if (s.length) nativeMenu(s, { items: appItemsFor(s) }); else nativeMenu([], { background: true, items: appItemsForBackground() });
      return;
    }
    if (ctrl && k.toLowerCase() === 'd') { ev.preventDefault(); duplicateSelected(); return; }
    // Quick Look zoom: Ctrl+= / Ctrl+- / Ctrl+0 (also plain + and -).
    if (ql.isOpen && $('#ql-body')._zoom && ((ctrl && ['=', '+', '-', '0'].includes(k)) || (!ctrl && ['+', '-', '='].includes(k)))) {
      ev.preventDefault();
      $('#ql-body')._zoom.step(k === '0' ? 0 : k === '-' ? -1 : 1);
      return;
    }
    if (ctrl && (k === '=' || k === '+')) { ev.preventDefault(); setIconSize(prefs.icon + 8); return; }
    if (ctrl && k === '-') { ev.preventDefault(); setIconSize(prefs.icon - 8); return; }
    if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) { ev.preventDefault(); refresh(true); return; }
    if (k === 'F2') {
      ev.preventDefault();
      const s = selectedEntries().filter((e) => !isVirtual(e));
      if (s.length === 1) startRename(s[0]); else if (s.length > 1) batchRename(s);
      return;
    }
    if (k === 'Delete' || (ctrl && k === 'Backspace')) { ev.preventDefault(); trashSelected(); return; }
    if (k === ' ') { ev.preventDefault(); ql.isOpen ? ql.close() : ql.open(); return; }
    if (k === 'Enter' || (ctrl && k === 'ArrowDown')) {
      ev.preventDefault();
      const s = selectedEntries();
      if (ql.isOpen) ql.close();
      if (s.length === 1) openEntry(s[0]); else s.filter((e) => !e.isDir).forEach(openEntry);
      return;
    }
    if ((ev.altKey && k === 'ArrowLeft') || k === 'BrowserBack' || (k === 'Backspace' && !ctrl)) { ev.preventDefault(); goBack(); return; }
    if ((ev.altKey && k === 'ArrowRight') || k === 'BrowserForward') { ev.preventDefault(); goForward(); return; }
    if ((ev.altKey || ctrl) && k === 'ArrowUp') { ev.preventDefault(); goUp(); return; }
    const arrows = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (arrows[k]) { ev.preventDefault(); moveSelection(arrows[k], ev); return; }

    // type-to-select
    if (k.length === 1 && !ctrl && !ev.altKey) {
      typeBuf += k.toLowerCase();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typeBuf = ''; }, 800);
      const list = inColumnsMode() ? state.colLists[state.colActive] || [] : state.entries;
      const hit = list.find((e) => e.name.toLowerCase().startsWith(typeBuf));
      if (hit) {
        if (inColumnsMode()) await columnClick(hit, state.colActive);
        else { state.anchor = hit.path; setSelection([hit.path]); revealPath(hit.path); }
      }
    }
  });

  window.addEventListener('mouseup', (ev) => {
    if (ev.button === 3) goBack();
    if (ev.button === 4) goForward();
  });

  // ---------- preview pane ----------
  const previewHelpers = {
    fileUrl: (p) => P.fileUrl(p), fmtSize, fmtDate, badge: specialBadge,
    icon: (e) => (winIcons() ? fileIco(e, 128) : null),
    canThumb,
    after: (el) => fillShellIcons(el),
  };
  const pane = $('#preview-pane');
  let paneTimer = null;
  let paneShown = null;

  function paneVisible() {
    const mode = viewMode();
    return prefs.previewPane && (mode === 'icons' || mode === 'list' || mode === 'home');
  }

  // Debounced so holding an arrow key doesn't load every file on the way.
  function updatePane() {
    const on = !!paneVisible();
    document.body.classList.toggle('pane-open', on);
    $('#btn-preview').classList.toggle('on', inColumnsMode() ? !!prefs.colPreview : !!prefs.previewPane);
    if (!on) { if (paneShown) { if (native.el === $('#pv-media')) nativeHide(); $('#pv-media').innerHTML = ''; paneShown = null; } return; }
    clearTimeout(paneTimer);
    paneTimer = setTimeout(renderPane, 90);
  }

  function infoRows(rows) {
    return `<div class="pv-table">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div><span>${k}</span><span>${esc(v)}</span></div>`).join('')}</div>`;
  }

  async function renderPane() {
    const sel = selectedEntries();
    const media = $('#pv-media');
    const info = $('#pv-info');
    if (sel.length === 1) {
      const e = sel[0];
      const key = `${e.path}|${e.mtime}`;
      if (paneShown !== key) {
        paneShown = key;
        nativeHide();
        fillPreview(media, e);
      }
      info.innerHTML = `
        <div class="pv-name">${esc(e.name)}</div>
        <div class="pv-kind">${esc(I.kindLabel(e))}</div>
        ${infoRows([
          ['大小', e.isDir ? null : e.size == null ? null : e.size < 1000 ? fmtSize(e.size) : `${fmtSize(e.size)}（${e.size.toLocaleString()} 位元組）`],
          ['建立日期', e.birth ? fmtDate(e.birth) : null],
          ['修改日期', e.mtime ? fmtDate(e.mtime) : null],
          ['位置', isVirtual(e) ? null : P.dirname(e.path)],
          ['狀態', CLOUD[e.cloud]?.label],
        ])}
        ${e.isDir && !isVirtual(e) && api.dirSize ? `<div class="pv-table"><div><span>大小</span><span>${dirSizes.has(norm(e.path))
          ? esc(`${fmtSize(dirSizes.get(norm(e.path)).size)}，${dirSizes.get(norm(e.path)).files.toLocaleString()} 個檔案`)
          : '<button class="pv-calc">計算</button>'}</span></div></div>` : ''}
        <button class="pv-open">${e.isDir ? '打開' : '以預設 App 打開'}</button>`;
      $('.pv-open', info).onclick = () => openEntry(e);
      const calc = $('.pv-calc', info);
      if (calc) calc.onclick = () => { calc.disabled = true; calc.textContent = '計算中…'; calcSize(e); };
      return;
    }
    paneShown = null;
    nativeHide();
    if (sel.length > 1) {
      const files = sel.filter((e) => !e.isDir);
      const total = files.reduce((n, e) => n + (e.size || 0), 0);
      setTimeout(() => fillShellIcons(media));
      media.innerHTML = `<div class="pv-stack">${sel.slice(0, 3).map((e, i) => `<span style="--k:${i}">${fileIco(e, 128)}</span>`).join('')}</div>`;
      media.dataset.kind = 'info';
      info.innerHTML = `<div class="pv-name">已選取 ${sel.length} 個項目</div>${infoRows([['檔案大小合計', files.length ? fmtSize(total) : null]])}`;
      return;
    }
    media.dataset.kind = 'info';
    if (state.cwd === HOME) {
      media.innerHTML = `<div class="ql-info">${I.sidebar('home')}</div>`;
      info.innerHTML = '<div class="pv-name">常用</div><div class="pv-kind">選取檔案即可預覽</div>';
      return;
    }
    media.innerHTML = `<div class="ql-info">${folderIco(state.cwd, 128)}</div>`;
      fillShellIcons(media);
    info.innerHTML = `<div class="pv-name">${esc(displayName(state.cwd))}</div><div class="pv-kind">${state.entries.length} 個項目</div>
      <div class="pv-hint">選取檔案即可預覽</div>`;
  }

  // Alt+P: the preview column in the column view (Finder's Show Preview),
  // the preview pane elsewhere.
  function togglePane() {
    if (inColumnsMode()) {
      prefs.colPreview = !prefs.colPreview;
      savePrefs();
      renderView(false);
      updatePane();
      return;
    }
    prefs.previewPane = !prefs.previewPane;
    savePrefs();
    if (prefs.previewPane && !paneVisible()) toast('預覽窗格在圖像、列表與常用頁中顯示');
    updatePane();
  }
  $('#btn-preview').addEventListener('click', togglePane);

  $('#pane-resizer').addEventListener('mousedown', (ev) => {
    const startX = ev.clientX; const startW = prefs.paneW || 320;
    const move = (e) => {
      prefs.paneW = Math.max(240, Math.min(720, startW - (e.clientX - startX)));
      document.documentElement.style.setProperty('--pane-w', `${prefs.paneW}px`);
    };
    const up = () => { savePrefs(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------- quick look ----------
  // Where an item's icon is on screen: Quick Look grows out of it and shrinks
  // back into it, like Finder (the whole row would be far too wide).
  function iconRect(path) {
    const el = elForPath(path);
    if (!el) return null;
    const icon = $('.thumb, .tw, img, svg', el) || el;
    const r = icon.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }

  const ql = {
    isOpen: false,
    current: null,
    async open() {
      const s = selectedEntries();
      const e = s[0];
      if (!e) return;
      this.isOpen = true;
      const root = $('#ql');
      root.hidden = false;
      root.classList.remove('closing');
      await this.show(e);
      const win = $('#ql-window');
      const from = iconRect(e.path);
      const to = win.getBoundingClientRect();
      const kf = from
        ? [{ transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${Math.max(0.05, from.width / to.width)})`, opacity: 0.2 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }];
      win.animate(kf, { duration: 320, easing: 'cubic-bezier(.2,.9,.25,1.05)' });
    },
    async update() {
      const e = selectedEntries()[0];
      if (e && e.path !== this.current?.path) await this.show(e);
    },
    async show(e) {
      this.current = e;
      $('#ql-title').textContent = e.name;
      prefetchAround(e);
      await window.Preview.fill($('#ql-body'), e, { autoplay: true, helpers: previewHelpers });
    },
    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      const root = $('#ql');
      const win = $('#ql-window');
      root.classList.add('closing');
      const from = this.current && iconRect(this.current.path);
      const to = win.getBoundingClientRect();
      const end = from
        ? { transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${Math.max(0.05, from.width / to.width)})`, opacity: 0 }
        : { transform: 'scale(.92)', opacity: 0 };
      const anim = win.animate([{ transform: 'none', opacity: 1 }, end], { duration: 220, easing: 'cubic-bezier(.4,0,.6,1)' });
      anim.onfinish = () => {
        if (this.isOpen) return;
        root.hidden = true;
        $('#ql-body').innerHTML = ''; // stops playing media
        this.current = null;
      };
    },
  };
  $('#ql-close').addEventListener('click', () => ql.close());
  $('#ql-backdrop').addEventListener('mousedown', () => ql.close());
  $('#ql-open').addEventListener('click', () => { if (ql.current) { const e = ql.current; ql.close(); openEntry(e); } });

  // ---------- updates ----------
  const updater = {
    busy: false,
    async check(manual = false) {
      if (!api.checkUpdate || this.busy) { if (manual && !api.checkUpdate) toast('這個版本不支援自動更新'); return; }
      this.busy = true;
      try {
        const info = await api.checkUpdate();
        if (info) this.offer(info);
        else if (manual) toast(`已是最新版本（${await api.appVersion()}）`);
      } catch (err) {
        if (manual) toast(/release JSON|404/i.test(String(err)) ? '目前還沒有發布的新版本' : `無法檢查更新：${err}`);
      } finally {
        this.busy = false;
      }
    },
    offer(info) {
      if (!manual && prefs.skipVersion === info.version) return;
      $('#up-title').textContent = `有新版本 ${info.version}`;
      $('#up-sub').textContent = info.notes?.trim() || `目前版本 ${info.current}`;
      $('#update .up-bar').hidden = true;
      $('#up-go').disabled = false;
      $('#up-later').disabled = false;
      $('#update').hidden = false;
      this.info = info;
    },
    async install() {
      $('#up-go').disabled = true;
      $('#up-later').disabled = true;
      $('#up-title').textContent = `正在下載 ${this.info.version}…`;
      $('#up-sub').textContent = '完成後會自動安裝並重新啟動';
      $('#update .up-bar').hidden = false;
      try {
        await api.installUpdate();
      } catch (err) {
        $('#up-title').textContent = '更新失敗';
        $('#up-sub').textContent = String(err);
        $('#up-later').disabled = false;
      }
    },
  };
  let manual = false;
  api.onUpdateProgress?.(([got, total]) => {
    if (total) $('#update .up-bar i').style.width = `${Math.min(100, (got / total) * 100)}%`;
  });
  $('#up-go').addEventListener('click', () => updater.install());
  $('#up-later').addEventListener('click', () => {
    $('#update').hidden = true;
    if (updater.info) { prefs.skipVersion = updater.info.version; savePrefs(); }
  });
  function checkUpdates(isManual) { manual = isManual; updater.check(isManual); }

  // ---------- dialogs ----------
  const dlg = { el: $('#dlg'), win: $('#dlg-window'), onClose: null };
  function openDialog(html, { cls = '', onClose = null } = {}) {
    // A fresh element per dialog, so listeners from the previous one go away.
    const fresh = dlg.win.cloneNode(false);
    dlg.win.replaceWith(fresh);
    dlg.win = fresh;
    dlg.win.className = `glass ${cls}`;
    dlg.win.innerHTML = html;
    dlg.el.hidden = false;
    closeMenu();
    dlg.onClose = onClose;
    return dlg.win;
  }
  function closeDialog() {
    if (dlg.el.hidden) return;
    dlg.el.hidden = true;
    dlg.win.innerHTML = '';
    const f = dlg.onClose;
    dlg.onClose = null;
    f?.();
    content.focus();
  }
  $('#dlg-backdrop').addEventListener('mousedown', closeDialog);

  function confirmDialog(message, okLabel) {
    return new Promise((resolve) => {
      let answer = false;
      const w = openDialog(`
        <div class="dlg-msg">${esc(message)}</div>
        <div class="dlg-actions"><button data-act="cancel">取消</button><button class="primary" data-act="ok">${esc(okLabel)}</button></div>`,
      { cls: 'small', onClose: () => resolve(answer) });
      $('[data-act="ok"]', w).focus();
      w.onclick = (ev) => {
        const a = ev.target.closest('[data-act]')?.dataset.act;
        if (a === 'ok') answer = true;
        if (a) closeDialog();
      };
      w.onkeydown = (ev) => { if (ev.key === 'Enter') { answer = true; closeDialog(); } };
    });
  }

  function promptDialog(title, value, okLabel) {
    return new Promise((resolve) => {
      let answer = null;
      const w = openDialog(`
        <div class="dlg-title">${esc(title)}</div>
        <input class="dlg-input" value="${esc(value)}" spellcheck="false">
        <div class="dlg-actions"><button data-act="cancel">取消</button><button class="primary" data-act="ok">${esc(okLabel)}</button></div>`,
      { cls: 'small', onClose: () => resolve(answer) });
      const input = $('input', w);
      input.focus();
      input.select();
      const ok = () => { answer = input.value.trim() || null; closeDialog(); };
      w.onclick = (ev) => { const a = ev.target.closest('[data-act]')?.dataset.act; if (a === 'ok') ok(); else if (a) closeDialog(); };
      w.onkeydown = (ev) => { if (ev.key === 'Enter') ok(); };
    });
  }

  // ---------- batch rename ----------
  function batchRename(entries) {
    const items = entries.filter((e) => !isVirtual(e));
    if (items.length < 2) { if (items[0]) startRename(items[0]); return; }
    const opt = { mode: 'replace', find: '', repl: '', cs: false, re: false, base: '', start: 1, digits: 2, keepExt: true };
    const w = openDialog(`
      <div class="dlg-title">批次重新命名 ${items.length} 個項目</div>
      <div class="br-modes">
        <label><input type="radio" name="br-mode" value="replace" checked> 尋找與取代</label>
        <label><input type="radio" name="br-mode" value="number"> 名稱加上編號</label>
      </div>
      <div class="br-fields" data-for="replace">
        <input data-k="find" placeholder="尋找" spellcheck="false">
        <input data-k="repl" placeholder="取代為" spellcheck="false">
        <label><input type="checkbox" data-k="cs"> 區分大小寫</label>
        <label><input type="checkbox" data-k="re"> 正規表示式</label>
      </div>
      <div class="br-fields" data-for="number" hidden>
        <input data-k="base" placeholder="名稱，例如：照片" spellcheck="false">
        <label>起始 <input data-k="start" type="number" value="1" min="0"></label>
        <label>位數 <input data-k="digits" type="number" value="2" min="1" max="6"></label>
        <label><input type="checkbox" data-k="keepExt" checked> 保留副檔名</label>
      </div>
      <div class="br-preview"></div>
      <div class="dlg-actions"><span class="br-note"></span><button data-act="cancel">取消</button><button class="primary" data-act="ok">重新命名</button></div>`, { cls: 'wide' });
    const names = () => items.map((e, i) => {
      if (opt.mode === 'number') {
        const dot = e.isDir ? -1 : e.name.lastIndexOf('.');
        const ext = opt.keepExt && dot > 0 ? e.name.slice(dot) : '';
        const n = String(Number(opt.start || 0) + i).padStart(Number(opt.digits) || 1, '0');
        return `${opt.base || '未命名'} ${n}${ext}`;
      }
      if (!opt.find) return e.name;
      try {
        const pat = opt.re ? opt.find : opt.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return e.name.replace(new RegExp(pat, opt.cs ? 'g' : 'gi'), opt.repl);
      } catch { return null; }
    });
    const bad = /[\\/:*?"<>|]/;
    const update = () => {
      const next = names();
      const seen = new Map();
      next.forEach((n, i) => { const k = `${P.dirname(items[i].path)}|${(n || '').toLowerCase()}`; seen.set(k, (seen.get(k) || 0) + 1); });
      let changes = 0; let errors = 0;
      const rows = items.slice(0, 300).map((e, i) => {
        const n = next[i];
        const dup = n != null && seen.get(`${P.dirname(e.path)}|${n.toLowerCase()}`) > 1;
        const err = n == null ? '規則錯誤' : !n.trim() || bad.test(n) ? '名稱無效' : dup ? '名稱重複' : '';
        if (err) errors++; else if (n !== e.name) changes++;
        return `<div class="br-row${err ? ' err' : n !== e.name ? ' chg' : ''}"><span>${esc(e.name)}</span><span>→</span><span>${esc(n ?? '')}${err ? ` <em>${err}</em>` : ''}</span></div>`;
      });
      $('.br-preview', w).innerHTML = rows.join('');
      $('.br-note', w).textContent = errors ? `${errors} 個名稱有問題` : `${changes} 個項目會改名`;
      $('[data-act="ok"]', w).disabled = !!errors || !changes;
    };
    w.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.name === 'br-mode') {
        opt.mode = t.value;
        $$('.br-fields', w).forEach((f) => { f.hidden = f.dataset.for !== opt.mode; });
      } else if (t.dataset.k) opt[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
      update();
    });
    w.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-act]')?.dataset.act;
      if (a === 'cancel') closeDialog();
      if (a !== 'ok') return;
      const next = names();
      closeDialog();
      const done = []; const renamed = []; let failed = 0;
      for (const [i, e] of items.entries()) {
        if (next[i] === e.name) { done.push(e.path); continue; }
        const res = await api.rename(e.path, next[i]);
        if (res.ok) { done.push(res.path); renamed.push([res.path, e.name]); } else failed++;
      }
      if (renamed.length) {
        pushUndo('批次重新命名', async () => {
          let ok = true;
          for (const [p, old] of renamed.reverse()) ok = (await api.rename(p, old)).ok && ok;
          return ok;
        });
      }
      await Promise.all([...new Set(items.map((e) => P.dirname(e.path)))].map((d) => listDir(d, true)));
      state.sel = new Set(done);
      await refresh(false);
      toast(failed ? `${failed} 個項目無法重新命名` : `已重新命名 ${items.length} 個項目`);
    });
    update();
    $('[data-k="find"]', w).focus();
  }

  // ---------- settings ----------
  function newTabDir() { return prefs.newTab === 'current' && state.cwd ? state.cwd : HOME; }
  function startupDir() {
    if (prefs.startup === 'last' && prefs.lastDir) return prefs.lastDir;
    if (prefs.startup === 'custom' && prefs.startDir) return prefs.startDir;
    return HOME;
  }
  function applyTheme(initial = false) {
    if (prefs.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = prefs.theme;
    // The window opens in the saved theme (see save_theme); only a change
    // needs to reach it.
    if (!initial) W.setTheme?.(prefs.theme);
    api.saveTheme?.(prefs.theme);
  }
  function applyDensity() {
    document.body.classList.toggle('density-compact', prefs.density === 'compact');
    document.body.classList.toggle('density-roomy', prefs.density === 'roomy');
  }
  // Re-renders everything that depends on how items are listed.
  function rerenderItems() {
    view._colsTab = null;
    computeEntries();
    render();
  }

  let settingsSec = 'general';
  const SHORTCUTS = [
    ['Ctrl+T／Ctrl+W', '新分頁／關閉分頁'], ['Ctrl+1～4', '圖像／列表／直欄／圖庫'], ['Ctrl+L、Alt+D、F4', '輸入路徑'],
    ['Ctrl+Shift+N', '新增資料夾'], ['Ctrl+Alt+N', '新增文字文件'], ['F2', '重新命名（多選時批次重新命名）'],
    ['空白鍵', '快速查看'], ['Alt+P', '預覽窗格'], ['Ctrl+Shift+.', '顯示隱藏的項目'], ['Ctrl+F', '搜尋'],
    ['Ctrl+Alt+C', '拷貝路徑'], ['Alt+←／→／↑', '上一頁／下一頁／上層'], ['Ctrl+,', '設定'],
    ['Ctrl+Z', '復原'], ['Alt+Enter', '內容'], ['Shift+F10、Shift+右鍵', 'Windows 原生右鍵選單'],
  ];
  function settingsSections() {
    const sel = (key, options) => `<select data-pref="${key}">${options.map(([v, l]) => `<option value="${v}"${String(prefs[key]) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const sw = (key, invert = false) => `<label class="sw"><input type="checkbox" data-pref="${key}"${invert ? ' data-invert="1"' : ''}${!prefs[key] !== !invert ? ' checked' : ''}><i></i></label>`;
    const swatches = `<div class="mrow">${ACCENTS.map(([c, n]) => `<button class="swatch${prefs.accent === c ? ' on' : ''}" style="background:${c};color:${c}" data-accent="${c}" title="${n}"></button>`).join('')}</div>`;
    return [
      { id: 'general', title: '一般', rows: [
        ['啟動時打開', null, sel('startup', [['restore', '上次的所有分頁'], ['home', '常用'], ['last', '上次的位置'], ['custom', '指定的資料夾']])],
        prefs.startup === 'custom' && ['指定的資料夾', null, `<div class="set-path"><input data-pref="startDir" value="${esc(prefs.startDir)}" placeholder="例如 D:\\Projects" spellcheck="false"><button data-act="use-cwd"${state.cwd === HOME ? ' disabled' : ''}>使用目前的資料夾</button></div>`],
        ['新分頁打開', null, sel('newTab', [['home', '常用'], ['current', '目前的資料夾']])],
        ['預設檢視', '沒有記住檢視方式的資料夾使用這個', sel('view', [['icons', '圖像'], ['list', '列表'], ['columns', '直欄'], ['gallery', '圖庫']])],
        ['每個資料夾記住自己的檢視方式', `改變檢視或排序只套用到那個資料夾（目前記住 ${Object.keys(prefs.folderViews).length} 個）`, sw('rememberView')],
        Object.keys(prefs.folderViews).length && ['', null, '<button data-act="reset-views">全部改回預設檢視</button>'],
        ['丟到資源回收筒前先確認', null, sw('confirmTrash')],
        api.checkUpdate && ['自動檢查更新', '啟動後在背景檢查一次', sw('autoUpdate')],
        api.setKeepRunning && ['關閉視窗後在背景執行', '按 × 只把視窗藏起來，程式留在通知區域，再打開就不用等待；要完全結束請在通知區域的圖示上按右鍵 →「結束」', sw('keepRunning')],
        api.setRunAtLogin && ['登入 Windows 時在背景啟動', '開機後第一次打開也不用等待', sw('runAtLogin')],
      ] },
      { id: 'look', title: '外觀', rows: [
        ['主題', null, sel('theme', [['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']])],
        ['強調色', null, swatches],
        api.nativeMenu && ['右鍵選單', 'Windows：檔案總管的選單（含 7-Zip、VS Code 等加入的項目），上方加上本程式的功能', sel('menuStyle', [['windows', 'Windows'], ['finder', 'Finder 風格']])],
        isWin && api.shellIcon && ['使用 Windows 圖示', '應用程式、檔案類型、資料夾與磁碟機都用檔案總管的圖示', sw('folderIcons')],
        api.setUiScale && ['介面與字體大小', '整個視窗的文字、按鈕與圖示一起放大或縮小', sel('uiScale', [[0.9, '90%'], [1, '100%（預設）'], [1.1, '110%'], [1.25, '125%'], [1.4, '140%'], [1.5, '150%'], [1.75, '175%']])],
        ['列表密度', '列表與直欄的行高', sel('density', [['compact', '精簡'], ['normal', '標準'], ['roomy', '寬鬆']])],
        ['顯示側邊欄', null, sw('sidebarHidden', true)],
        ['預覽窗格', '在圖像、列表與常用頁的右側顯示', sw('previewPane')],
        api.previewShow && ['使用檔案總管的預覽', '直欄的預覽欄與預覽窗格：Office 等檔案用 Windows 註冊的預覽處理常式，跟檔案總管一樣；圖片、影片、PDF、文字與程式碼用內建預覽，比較快', sw('nativePreview')],
      ] },
      { id: 'files', title: '檔案與資料夾', rows: [
        ['顯示隱藏的項目', null, sw('showHidden')],
        ['顯示受保護的作業系統檔案', '例如「Application Data」「My Documents」這類無法打開的相容性捷徑（檔案總管預設也隱藏）', sw('showSystem')],
        ['顯示副檔名', null, sw('showExt')],
        ['資料夾排在檔案前面', null, sw('foldersFirst')],
        api.dirSize && ['計算所有大小', '列表檢視在背景算出每個資料夾的大小（Finder 的「計算所有大小」）', sw('calcSizes')],
        ['檔案大小單位', null, sel('sizeBase', [[1000, '1 KB = 1000 位元組（macOS）'], [1024, '1 KB = 1024 位元組（Windows）']])],
        ['直欄寬度', '目前記住了 ' + Object.keys(prefs.colWidths || {}).length + ' 個資料夾的欄寬', '<button data-act="reset-cols">全部還原為預設寬度</button>'],
      ] },
      { id: 'about', title: '關於', rows: [
        ['版本', null, '<span class="set-version">…</span>'],
        api.checkUpdate && ['更新', null, '<button data-act="check-update">檢查更新</button>'],
        ['重設', '把所有設定還原為預設值', '<button data-act="reset-all">重設所有設定…</button>'],
      ], extra: `<h3>快捷鍵</h3><div class="set-keys">${SHORTCUTS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>` },
    ];
  }
  // prefs.folderIcons is stored as 'finder' / 'windows'; the switch shows it as on/off.
  const PREF_GET = { folderIcons: () => winIcons() };
  function renderSettings(w) {
    const saved = { ...prefs };
    Object.entries(PREF_GET).forEach(([k, f]) => { prefs[k] = f(); });
    const secs = settingsSections();
    const sec = secs.find((x) => x.id === settingsSec) || secs[0];
    w.innerHTML = `
      <nav class="set-nav"><div class="set-head">設定</div>${secs.map((x) => `<button data-sec="${x.id}" class="${x === sec ? 'on' : ''}">${x.title}</button>`).join('')}</nav>
      <div class="set-main">
        <h2>${sec.title}</h2>
        ${sec.rows.filter(Boolean).map(([label, hint, ctl]) => `
          <div class="set-row"><div class="set-text"><div>${label}</div>${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="set-ctl">${ctl}</div></div>`).join('')}
        ${sec.extra || ''}
      </div>
      <button class="set-close" data-act="close" title="關閉 (Esc)"><svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9"/></svg></button>`;
    Object.keys(PREF_GET).forEach((k) => { prefs[k] = saved[k]; });
    const v = $('.set-version', w);
    if (v) (api.appVersion ? api.appVersion() : Promise.resolve('開發版')).then((x) => { v.textContent = x; });
  }
  function setPref(key, value) {
    if (key === 'view') { setView(value, { asDefault: true }); return; }
    if (key === 'folderIcons') value = value ? 'windows' : 'finder';
    prefs[key] = value;
    savePrefs();
    if (key === 'theme') applyTheme();
    else if (key === 'density') applyDensity();
    else if (key === 'sidebarHidden') document.body.classList.toggle('sidebar-hidden', !!value);
    else if (key === 'previewPane') updatePane();
    else if (key === 'calcSizes') queueFolderSizes();
    else if (key === 'uiScale') api.setUiScale?.(value);
    else if (key === 'keepRunning') api.setKeepRunning?.(value);
    else if (key === 'runAtLogin') api.setRunAtLogin?.(value).then((err) => { if (err) toast(`無法設定登入時啟動：${err}`); });
    else if (key === 'nativePreview') { nativeHide(); paneShown = null; rerenderItems(); }
    else if (['folderIcons', 'showHidden', 'showSystem', 'showExt', 'foldersFirst', 'sizeBase'].includes(key)) rerenderItems();
  }
  function openSettings(section) {
    if (section) settingsSec = section;
    const w = openDialog('', { cls: 'settings' });
    renderSettings(w);
    w.addEventListener('change', (ev) => {
      const t = ev.target;
      const key = t.dataset.pref;
      if (!key) return;
      let value = t.type === 'checkbox' ? t.checked !== !!t.dataset.invert : t.value;
      if (key === 'sizeBase' || key === 'uiScale') value = Number(value);
      setPref(key, value);
      if (t.tagName === 'SELECT') renderSettings(w); // rows can depend on a choice
    });
    w.addEventListener('click', async (ev) => {
      const sec = ev.target.closest('[data-sec]');
      if (sec) { settingsSec = sec.dataset.sec; renderSettings(w); return; }
      const sw = ev.target.closest('[data-accent]');
      if (sw) { setAccent(sw.dataset.accent); renderSettings(w); return; }
      const a = ev.target.closest('[data-act]')?.dataset.act;
      if (a === 'close') closeDialog();
      else if (a === 'use-cwd') { setPref('startDir', state.cwd); renderSettings(w); }
      else if (a === 'reset-views') { prefs.folderViews = {}; savePrefs(); state.view = null; rerenderItems(); renderSettings(w); toast('所有資料夾已改回預設檢視'); }
      else if (a === 'reset-cols') { prefs.colWidths = {}; prefs.colW = 220; savePrefs(); rerenderItems(); renderSettings(w); toast('已還原所有直欄寬度'); }
      else if (a === 'check-update') checkUpdates(true);
      else if (a === 'reset-all') {
        if (!(await confirmDialog('要把所有設定還原為預設值嗎？釘選的資料夾不受影響。', '重設'))) return;
        const keep = { favorites: prefs.favorites, treeOpen: prefs.treeOpen };
        await api.setUiScale?.(1);
        try { localStorage.setItem(PREF_KEY, JSON.stringify(keep)); } catch { /* storage unavailable */ }
        location.reload();
      }
    });
  }

  // ---------- window chrome ----------
  $('#caption').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act !== 'max') document.body.classList.add('caption-idle');
    ({ close: W.close, min: W.minimize, max: W.toggleMaximize })[b.dataset.act]();
  });
  window.addEventListener('pointermove', () => document.body.classList.remove('caption-idle'));
  W.onState((s) => document.body.classList.toggle('maximized', !!s.maximized));
  // Tauri drag regions already maximize on double-click.
  if (!isTauri) $('#toolbar').addEventListener('dblclick', (ev) => { if (!ev.target.closest('button, input')) W.toggleMaximize(); });
  window.addEventListener('blur', () => document.body.classList.add('blurred'));
  window.addEventListener('focus', () => document.body.classList.remove('blurred'));

  // sidebar resize
  $('#sidebar-resizer').addEventListener('mousedown', (ev) => {
    const startX = ev.clientX; const startW = prefs.sidebarW;
    const sidebar = $('#sidebar');
    sidebar.style.transition = 'none';
    const move = (e) => {
      prefs.sidebarW = Math.max(160, Math.min(360, startW + e.clientX - startX));
      document.documentElement.style.setProperty('--sidebar-w', `${prefs.sidebarW}px`);
    };
    const up = () => {
      sidebar.style.transition = '';
      savePrefs();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------- boot ----------
  (async function boot() {
    applyAccent();
    applyTheme(true);
    applyDensity();
    document.documentElement.style.setProperty('--icon', `${prefs.icon}px`);
    document.documentElement.style.setProperty('--sidebar-w', `${prefs.sidebarW}px`);
    document.documentElement.style.setProperty('--pane-w', `${prefs.paneW || 320}px`);
    document.body.classList.toggle('sidebar-hidden', !!prefs.sidebarHidden);
    $('#zoom').value = prefs.icon;
    api.setUiScale?.(prefs.uiScale); // the window opens at the saved size already (lib.rs); this keeps the two in step
    api.setKeepRunning?.(prefs.keepRunning);
    if (prefs.runAtLogin) api.setRunAtLogin?.(true); // keeps the path right after the app moves or updates
    // Launching the app again shows this window; a folder it was given opens in a new tab.
    api.onOpenDir?.((dir) => openTab(dir || newTabDir()));
    api.onHidden?.(() => { ql.close(); closeMenu(); document.body.classList.add('caption-idle'); });
    try {
      G.places = await api.places();
      // A folder passed in wins; otherwise the startup setting.
      G.booting = true;
      const restored = !env.dir && prefs.startup === 'restore' && await restoreSession();
      G.booting = false;
      const start = env.dir || startupDir();
      if (!restored && !(await navigate(start, { root: start }))) await navigate(HOME);
      saveSession();
      content.focus();
    } finally {
      window.__finderReady?.();
    }
    // Quietly look for a new version once the window is up.
    if (prefs.autoUpdate) setTimeout(() => checkUpdates(false), 4000);
  })();
})();
