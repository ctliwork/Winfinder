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
  }, readPrefs());
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
      search: { query: '', scope: 'folder', results: null, busy: false },
      scroll: 0,
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
  function ancestors(dir, root) {
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
  function displayName(p) {
    const fav = G.places?.favorites.find((f) => norm(f.path) === norm(p));
    if (fav) return fav.label;
    const loc = G.places?.locations.find((l) => norm(l.path) === norm(p));
    if (loc) return loc.label;
    return baseName(p);
  }
  function specialBadge(p) {
    const fav = G.places?.favorites.find((f) => norm(f.path) === norm(p));
    return fav ? fav.icon : null;
  }

  function fmtSize(bytes) {
    if (bytes == null) return '--';
    if (bytes < 1000) return `${bytes} 位元組`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes; let u = -1;
    do { v /= 1000; u++; } while (v >= 1000 && u < units.length - 1);
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

  function sortEntries(list) {
    const { key, dir } = prefs.sort;
    const cmp = {
      name: (a, b) => collator.compare(a.name, b.name),
      date: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      kind: (a, b) => collator.compare(I.kindLabel(a), I.kindLabel(b)),
    }[key];
    return list.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return (cmp(a, b) || collator.compare(a.name, b.name)) * dir;
    });
  }

  function visibleOf(entries) {
    let list = prefs.showHidden ? entries : entries.filter((e) => !e.hidden);
    return sortEntries(list);
  }

  function computeEntries() {
    const q = state.search.query.trim().toLowerCase();
    if (state.cwd === HOME && !state.search.results) {
      state.entries = q ? state.homeItems.filter((e) => e.name.toLowerCase().includes(q)) : state.homeItems.slice();
    } else if (state.search.results) {
      state.entries = sortEntries(state.search.results);
    } else {
      let list = visibleOf(dirCache.get(state.cwd)?.entries || []);
      if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
      state.entries = list;
    }
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
    if (state.search.results && prefs.view === 'columns') return 'list';
    return prefs.view;
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
    for (const f of [...(G.places?.favorites || []), ...prefs.favorites.map((p) => ({ path: p }))]) {
      if (isUnder(dir, f.path) && (!best || f.path.length > best.length)) best = f.path;
    }
    return best || P.root(dir);
  }

  async function loadHome() {
    const favs = [
      ...G.places.favorites.map((f) => ({ path: f.path, name: f.label, badge: f.icon })),
      ...prefs.favorites.map((p) => ({ path: p, name: baseName(p), badge: null, custom: true })),
    ];
    const pinned = favs.map((f) => ({ ...f, isDir: true, ext: '', kind: 'pinned' }));
    const drives = G.places.locations.map((l) => ({ name: l.label, path: l.path, isDir: true, ext: '', kind: 'drive' }));
    let recent = [];
    try { recent = (await api.recentFiles()).map((e) => ({ ...e, kind: 'recent' })); } catch { /* not available */ }
    state.homeItems = [...pinned, ...drives, ...recent];
  }

  async function navigate(dir, opts = {}) {
    const { push = true, select = null, root = null, colActive = null, animate = true, silent = false } = opts;
    if (dir === HOME) {
      await loadHome();
    } else {
      const res = await listDir(dir, true);
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

    const chainLen = dir === HOME ? 1 : ancestors(dir, state.colRoot).length;
    state.colActive = colActive ?? chainLen - 1;

    state.sel.clear();
    let target = select;
    if (!target && prev && prev !== HOME && dir !== HOME && changed && norm(P.dirname(prev)) === norm(dir)) target = prev; // went up: highlight where we came from
    if (target && !inColumnsMode()) { state.sel.add(target); state.anchor = target; state.focus = target; }
    else if (target && inColumnsMode() && state.colActive === chainLen - 1) { state.sel.add(target); state.anchor = target; state.focus = target; }
    else { state.anchor = null; state.focus = null; }

    computeEntries();
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
    renderPathbar();
    renderStatus();
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
      const on = b.dataset.view === prefs.view;
      b.classList.toggle('active', on);
      if (on) $('#view-seg .seg-pill').style.transform = `translateX(${i * 38}px)`;
    });
  }

  function subdirs(p) {
    const c = dirCache.get(p);
    if (!c || c.error) return null;
    return sortEntries(c.entries.filter((e) => e.isDir && (prefs.showHidden || !e.hidden)));
  }

  // Explorer-style navigation tree: Home, pinned folders, drives; folders expand in place.
  function renderSidebar() {
    if (!G.places) return;
    const nav = $('#places');
    const scroll = nav.scrollTop;
    const active = norm(state.cwd || '');
    const chev = '<svg viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
    const missing = [];
    const row = (p, label, icon, lvl, extra = '') => {
      const open = G.treeOpen.has(p);
      const kids = subdirs(p);
      if (open && !kids) missing.push(p);
      const leaf = kids && kids.length === 0;
      let html = `<div class="place${norm(p) === active ? ' active' : ''}" data-path="${esc(p)}" style="--lvl:${lvl}" ${extra}>
        <span class="twisty${open && !leaf ? ' open' : ''}${leaf ? ' none' : ''}" data-twisty="${esc(p)}">${chev}</span>
        ${I.sidebar(icon)}<span>${esc(label)}</span></div>`;
      if (open && kids) html += kids.map((k) => row(k.path, k.name, 'folder', lvl + 1)).join('');
      return html;
    };
    const sec = (key, title, body) => {
      const closed = prefs.secCollapsed?.[key];
      return `<div class="sec-title${closed ? ' collapsed' : ''}" data-sec="${key}">${title}<svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg></div>${closed ? '' : body}`;
    };
    const pinned = [
      ...G.places.favorites.map((f) => row(f.path, f.label, f.icon, 0)),
      ...prefs.favorites.map((p) => row(p, baseName(p), 'folder', 0, 'data-custom="1"')),
    ].join('');
    const drives = G.places.locations.map((l) => row(l.path, l.label, 'drive', 0)).join('');
    nav.innerHTML = `
      <div class="place home-row${state.cwd === HOME ? ' active' : ''}" data-path="${HOME}">
        <span class="twisty none"></span>${I.sidebar('home')}<span>首頁</span></div>
      ${sec('pinned', '釘選', pinned)}
      ${sec('drives', '本機', drives)}`;
    nav.scrollTop = scroll;
    if (missing.length) Promise.all(missing.map((p) => listDir(p))).then(renderSidebar);
  }

  function toggleTree(p) {
    G.treeOpen.has(p) ? G.treeOpen.delete(p) : G.treeOpen.add(p);
    prefs.treeOpen = [...G.treeOpen];
    savePrefs();
    renderSidebar();
  }

  function iconHtml(e, px) {
    if (e.isDir) {
      return `<span class="tw">${I.folder(specialBadge(e.path))}</span>`;
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
    const e = entryOf(p);
    if (!e) return;
    const key = thumbKey(e, px);
    let url = thumbCache.get(key);
    if (url === undefined) {
      url = await api.thumb(p, Math.min(512, px * 2));
      if (!url && WEB_IMAGES.has(e.ext) && (e.size || 0) < 40e6) url = P.fileUrl(p);
      thumbCache.set(key, url || null);
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

  // Render big folders in slices so the first screen appears immediately.
  function renderRows(container, items, rowFn, prefix = '') {
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

  async function renderView(animate) {
    const mode = viewMode();
    view.className = '';
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
      renderRows(view, items, (e, i) => `
        <div class="gi item${state.sel.has(e.path) ? ' sel' : ''}${cut.has(e.path) ? ' cut' : ''}" data-i="${i}" style="--i:${Math.min(i, 40)}" draggable="true">
          <div class="thumb">${iconHtml(e, prefs.icon)}</div>
          <div class="label">${esc(e.name)}</div>
        </div>`);
    } else if (mode === 'list') {
      view.className = 'list';
      const { key, dir } = prefs.sort;
      const head = (k, label) => `<div data-sort="${k}" class="${key === k ? 'sorted' : ''}">${label}${key === k ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : ''}</div>`;
      const header = `<div class="lhead">${head('name', '名稱')}${head('date', '修改日期')}${head('size', '大小')}${head('kind', '類型')}</div>`;
      renderRows(view, items, (e, i) => `
        <div class="lrow item${state.sel.has(e.path) ? ' sel' : ''}${cut.has(e.path) ? ' cut' : ''}" data-i="${i}" draggable="true">
          <div class="name">${iconHtml(e, 40)}<span class="nm">${esc(e.name)}</span></div>
          <div>${fmtDate(e.mtime)}</div>
          <div>${e.isDir ? '--' : fmtSize(e.size)}</div>
          <div>${esc(I.kindLabel(e))}</div>
        </div>`, header);
    } else if (mode === 'gallery') {
      renderGallery();
    }
    observeThumbs();
  }

  async function renderColumns() {
    const chain = ancestors(state.cwd, state.colRoot);
    await Promise.all(chain.map((d) => listDir(d)));
    state.colLists = chain.map((d) => visibleOf(dirCache.get(d)?.entries || []));
    const n = chain.length - 1;
    const prevScroll = $$('.col', view).map((c) => c.scrollTop);
    const cols = chain.map((dir, j) => {
      const next = chain[j + 1];
      const rows = state.colLists[j].map((e, i) => {
        let cls = '';
        if (next && norm(e.path) === norm(next)) cls = j === state.colActive ? ' sel' : ' path';
        else if (j === n && state.sel.has(e.path)) cls = ' sel';
        return `<div class="crow item${cls}" data-col="${j}" data-i="${i}" draggable="true">
          ${iconHtml(e, 36)}<span class="nm">${esc(e.name)}</span>
          ${e.isDir ? '<svg class="chev" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>' : ''}
        </div>`;
      }).join('');
      return `<div class="col" data-dir="${esc(dir)}">${rows || ''}</div>`;
    });
    const sel = selectedEntries();
    const preview = sel.length === 1 && !sel[0].isDir && state.colActive === n
      ? `<div class="col-preview">${previewCard(sel[0])}</div>` : '<div class="col-preview" style="visibility:hidden"></div>';
    view.className = 'columns';
    view.innerHTML = cols.join('') + preview;
    $$('.col', view).forEach((c, i) => { if (prevScroll[i]) c.scrollTop = prevScroll[i]; });
    $$('.crow.sel, .crow.path', view).forEach((el) => el.scrollIntoView({ block: 'nearest' }));
    content.scrollLeft = content.scrollWidth;
    fillPreviewArt();
  }

  function previewCard(e) {
    return `
      <div class="pv-art" data-art="${esc(e.path)}">${e.isDir ? I.folder(specialBadge(e.path)) : I.file(e.ext)}</div>
      <div class="pv-name">${esc(e.name)}</div>
      <div class="pv-kind">${esc(I.kindLabel(e))}${e.isDir ? '' : ` — ${fmtSize(e.size)}`}</div>
      <div class="pv-table">
        <div><span>建立日期</span><span>${fmtDate(e.birth)}</span></div>
        <div><span>修改日期</span><span>${fmtDate(e.mtime)}</span></div>
        ${e.isDir ? '' : `<div><span>大小</span><span>${e.size?.toLocaleString() ?? '--'} 位元組</span></div>`}
      </div>`;
  }

  async function fillPreviewArt() {
    for (const art of $$('[data-art]', view)) {
      const e = entryOf(art.dataset.art);
      if (!e || e.isDir) continue;
      const media = await mediaHtml(e, 440, false);
      if (media && art.isConnected) art.innerHTML = media;
    }
  }

  // Returns <img>/<video> markup for a rich preview, or null.
  async function mediaHtml(e, px, controls) {
    const cat = I.category(e.ext);
    const url = P.fileUrl(e.path);
    if (cat === 'video' && ['mp4', 'webm', 'm4v', 'mov', 'mkv'].includes(e.ext)) {
      return `<video src="${url}" ${controls ? 'controls autoplay' : 'muted loop autoplay playsinline'}></video>`;
    }
    if (WEB_IMAGES.has(e.ext)) return `<img src="${url}" decoding="async" draggable="false">`;
    const t = await api.thumb(e.path, px);
    return t ? `<img src="${t}" draggable="false">` : null;
  }

  function renderGallery() {
    const items = state.entries;
    let cur = selectedEntries()[0];
    if (!cur) { cur = items[0]; state.sel = new Set([cur.path]); state.focus = cur.path; state.anchor = cur.path; }
    view.className = 'gallery';
    view.innerHTML = `
      <div class="g-stage"><div class="hero" data-art="${esc(cur.path)}">${cur.isDir ? I.folder(specialBadge(cur.path)) : I.file(cur.ext)}</div></div>
      <div class="g-caption"><b>${esc(cur.name)}</b><small>${esc(I.kindLabel(cur))}${cur.isDir ? '' : ` · ${fmtSize(cur.size)}`} · ${fmtDate(cur.mtime)}</small></div>
      <div class="g-strip">${items.map((e, i) => `
        <div class="g-item item${state.sel.has(e.path) ? ' sel' : ''}" data-i="${i}" draggable="true" title="${esc(e.name)}">${iconHtml(e, 64)}</div>`).join('')}
      </div>`;
    fillPreviewArt();
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
      <div class="qa item${sel(e)}" data-i="${at(e)}">${I.folder(e.badge)}<div><b>${esc(e.name)}</b><small>${esc(where(e.path))}</small></div></div>`).join('');
    const drv = drives.map((e) => `
      <div class="drv item${sel(e)}" data-i="${at(e)}" data-drive="${esc(e.path)}">${I.drive()}<div><b>${esc(e.name)}</b>
        <div class="bar"><i style="width:0%"></i></div><small class="space">&nbsp;</small></div></div>`).join('');
    const rec = recent.map((e) => `
      <div class="lrow item${sel(e)}${cut.has(e.path) ? ' cut' : ''}" data-i="${at(e)}" draggable="true">
        <div class="name">${iconHtml(e, 40)}<span class="nm">${esc(e.name)}</span></div>
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
    if (t.search.results) return `搜尋「${t.search.query}」`;
    if (t.cwd === HOME || !t.cwd) return '首頁';
    return displayName(t.cwd);
  }

  function renderTabs() {
    $('#tabs').innerHTML = tabs.map((t) => `
      <div class="tab${t === state ? ' active' : ''}" data-tab="${t.id}" title="${esc(t.cwd === HOME ? '首頁' : t.cwd || '')}">
        ${t.cwd === HOME || !t.cwd ? I.sidebar('home') : I.folder(specialBadge(t.cwd))}<span>${esc(tabTitle(t))}</span>
      </div>`).join('');
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
  }

  let lastBg = null; // keeps background tabs in the order they were opened, like browsers
  async function openTab(dir = HOME, { activate = true } = {}) {
    const t = newTabState();
    let at = tabs.indexOf(state) + 1;
    if (!activate && lastBg?.opener === state && tabs.includes(lastBg.tab)) at = tabs.indexOf(lastBg.tab) + 1;
    tabs.splice(at, 0, t);
    lastBg = activate ? null : { opener: state, tab: t };
    if (activate) {
      state.scroll = content.scrollTop;
      state = t;
      syncSearchUi();
      if (!(await navigate(dir, { root: dir }))) await navigate(HOME);
    } else {
      // Background tab: load it without touching the visible one.
      const cur = state;
      state = t;
      const ok = await navigate(dir, { root: dir, silent: true });
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
  }

  function renderPathbar() {
    const bar = $('#pathbar');
    if (state.search.results) { bar.innerHTML = `<span class="crumb">${I.sidebar('recent')}<span>搜尋結果：${state.entries.length} 個項目</span></span>`; return; }
    if (state.cwd === HOME) { bar.innerHTML = `<span class="crumb">${I.sidebar('home')}<span>首頁</span></span>`; return; }
    const chain = ancestors(state.cwd, P.root(state.cwd));
    const sep = '<svg class="crumb-sep" viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg>';
    bar.innerHTML = chain.map((p, i) => `
      <button class="crumb" data-path="${esc(p)}">${i === 0 ? I.drive() : I.folder(specialBadge(p))}<span>${esc(displayName(p))}</span></button>`).join(sep);
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

  // ---------- opening ----------
  async function openEntry(e) {
    if (!e) return;
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
  content.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || G.renaming) return;
    closeMenu();
    G.dragging = null;
    const it = itemFromEl(ev.target);
    if (ev.target.closest('.lhead')) return;
    if (!it?.entry) {
      if (ev.target.closest('.g-stage, .col-preview, .g-caption')) return;
      if (ev.target.closest('.col')) return; // empty area inside a column
      startMarquee(ev);
      return;
    }
    if (it.col != null) { columnClick(it.entry, it.col); return; }
    // Keep a multi-selection intact until mouseup so it can be dragged.
    if (state.sel.has(it.entry.path) && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey) {
      pendingSingle = it.entry.path;
      state.focus = it.entry.path;
      return;
    }
    clickSelect(it.entry, ev);
  });
  content.addEventListener('mouseup', () => {
    if (pendingSingle) { state.anchor = pendingSingle; setSelection([pendingSingle]); pendingSingle = null; }
  });
  content.addEventListener('dblclick', (ev) => {
    const it = itemFromEl(ev.target);
    if (it?.entry) openEntry(it.entry);
  });
  content.addEventListener('click', (ev) => {
    const h = ev.target.closest('.lhead [data-sort]');
    if (!h) return;
    const k = h.dataset.sort;
    prefs.sort = prefs.sort.key === k ? { key: k, dir: -prefs.sort.dir } : { key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 };
    savePrefs();
    computeEntries();
    render();
  });

  // rubber-band selection
  function startMarquee(ev) {
    const mode = prefs.view;
    if (mode !== 'icons' && mode !== 'list') { if (!ev.ctrlKey) setSelection([]); return; }
    const base = ev.ctrlKey || ev.shiftKey ? new Set(state.sel) : new Set();
    if (!ev.ctrlKey && !ev.shiftKey) setSelection([]);
    const box = $('#marquee');
    const origin = content.getBoundingClientRect();
    const sx = ev.clientX - origin.left + content.scrollLeft;
    const sy = ev.clientY - origin.top + content.scrollTop;
    const rects = $$('.item', view).map((el) => {
      const r = el.getBoundingClientRect();
      return { el, l: r.left - origin.left + content.scrollLeft, t: r.top - origin.top + content.scrollTop, r: r.right - origin.left + content.scrollLeft, b: r.bottom - origin.top + content.scrollTop };
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
        if (it.r > l && it.l < l + w && it.b > t && it.t < t + h) next.add(state.entries[Number(it.el.dataset.i)].path);
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
    const paths = it.col != null ? [it.entry.path] : selectedEntries().map((e) => e.path);
    G.dragging = paths;
    api.startDrag(paths);
  });

  function dropTargetFor(target) {
    if (!target?.closest) return null;
    const place = target.closest('.place, .crumb');
    if (place) return { dir: place.dataset.path, el: place };
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
  window.__finderDnd = {
    over: (x, y) => setDropEl(dropTargetFor(document.elementFromPoint(x, y))?.el || null),
    drop: (x, y, paths) => dropInto(document.elementFromPoint(x, y), paths.length ? paths : (G.dragging || []), ctrlHeld),
    leave: () => setDropEl(null),
  };

  async function transfer(op, paths, dest) {
    const results = await api.transfer(op, paths, dest);
    const failed = results.filter((r) => r.error);
    const done = results.filter((r) => !r.error);
    if (failed.length) toast(`${failed.length} 個項目失敗：${errText(failed[0].error)}`);
    else toast(`已${op === 'move' ? '搬移' : '拷貝'} ${done.length} 個項目到「${displayName(dest)}」`);
    await Promise.all([listDir(dest, true), ...paths.map((p) => listDir(P.dirname(p), true))]);
    if (norm(dest) === norm(state.cwd)) state.sel = new Set(done.map((r) => r.path));
    await refresh(false);
  }

  // ---------- file actions ----------
  async function newFolder() {
    if (state.search.results || state.cwd === HOME) return;
    const res = await api.mkdir(state.cwd);
    if (!res.ok) { toast(`無法新增資料夾：${errText(res.error)}`); return; }
    await listDir(state.cwd, true);
    state.sel = new Set([res.path]); state.focus = res.path; state.anchor = res.path;
    if (inColumnsMode()) state.colActive = ancestors(state.cwd, state.colRoot).length - 1;
    computeEntries();
    await render();
    startRename(entryOf(res.path));
  }

  async function trashSelected() {
    const items = selectedEntries().filter((e) => !isVirtual(e));
    if (!items.length) return;
    const failed = await api.trash(items.map((e) => e.path));
    const ok = items.length - failed.length;
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
    toast(op === 'move' ? `已剪下 ${items.length} 個項目` : `已拷貝 ${items.length} 個項目`);
    if (op === 'move') render();
  }

  async function paste() {
    if (!G.clip || state.search.results || state.cwd === HOME) return;
    const { op, paths } = G.clip;
    if (op === 'move') G.clip = null;
    await transfer(op, paths, state.cwd);
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

  function toggleFavorite(p) {
    const i = prefs.favorites.findIndex((f) => norm(f) === norm(p));
    if (i >= 0) prefs.favorites.splice(i, 1); else prefs.favorites.push(p);
    savePrefs();
    if (state.cwd === HOME) refresh(true); else renderSidebar();
  }

  function startRename(e) {
    if (!e || isVirtual(e)) return;
    const el = elForPath(e.path);
    if (!el) return;
    const label = $('.label, .nm', el);
    if (!label) return;
    el.scrollIntoView({ block: 'nearest' });
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
      const name = input.value.trim();
      if (commit && name && name !== e.name) {
        const res = await api.rename(e.path, name);
        if (!res.ok) toast(`無法重新命名：${errText(res.error)}`);
        else {
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
    { label: '以圖像顯示', kbd: 'Ctrl+1', check: prefs.view === 'icons', action: () => setView('icons') },
    { label: '以列表顯示', kbd: 'Ctrl+2', check: prefs.view === 'list', action: () => setView('list') },
    { label: '以直欄顯示', kbd: 'Ctrl+3', check: prefs.view === 'columns', action: () => setView('columns') },
    { label: '以圖庫顯示', kbd: 'Ctrl+4', check: prefs.view === 'gallery', action: () => setView('gallery') },
  ];
  const sortItems = () => [['name', '名稱'], ['kind', '類型'], ['date', '修改日期'], ['size', '大小']].map(([k, l]) => ({
    label: `依${l}排序`, check: prefs.sort.key === k,
    action: () => { prefs.sort = { key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 }; savePrefs(); computeEntries(); render(); },
  }));

  function itemMenu(entries, x, y) {
    const one = entries.length === 1 ? entries[0] : null;
    const isFav = one?.isDir && prefs.favorites.some((f) => norm(f) === norm(one.path));
    const virt = entries.some(isVirtual);
    const builtinPin = one?.kind === 'pinned' && !one.custom;
    openMenu([
      { label: '打開', kbd: 'Enter', action: () => entries.forEach(openEntry) },
      ...(one?.isDir ? [{ label: '在新分頁中打開', kbd: '滑鼠中鍵', action: () => openTab(one.path, { activate: false }) }] : []),
      { label: one ? `快速查看「${one.name}」` : `快速查看 ${entries.length} 個項目`, kbd: 'Space', action: () => ql.open() },
      '-',
      { label: '重新命名', kbd: 'F2', disabled: !one || virt, action: () => startRename(one) },
      { label: '製作副本', kbd: 'Ctrl+D', disabled: virt, action: duplicateSelected },
      { label: '拷貝', kbd: 'Ctrl+C', action: () => copySelected('copy') },
      { label: '剪下', kbd: 'Ctrl+X', disabled: virt, action: () => copySelected('move') },
      { label: '拷貝路徑', kbd: 'Ctrl+Alt+C', action: copyPath },
      '-',
      ...(one?.isDir && !builtinPin && one.kind !== 'drive' ? [{ label: isFav ? '取消釘選' : '釘選到快速存取', action: () => toggleFavorite(one.path) }] : []),
      { label: isWin ? '在檔案總管中顯示' : '在系統檔案管理員中顯示', action: () => api.reveal(entries[0].path) },
      '-',
      { label: '丟到資源回收筒', kbd: 'Delete', disabled: virt, action: trashSelected },
    ], x, y);
  }

  function backgroundMenu(x, y) {
    if (state.cwd === HOME) {
      openMenu([
        { label: '新分頁', kbd: 'Ctrl+T', action: () => openTab(HOME) },
        { label: '重新整理', kbd: 'F5', action: () => refresh(true) },
      ], x, y);
      return;
    }
    openMenu([
      { label: '新增資料夾', kbd: 'Ctrl+Shift+N', disabled: !!state.search.results, action: newFolder },
      { label: G.clip ? `貼上 ${G.clip.paths.length} 個項目` : '貼上', kbd: 'Ctrl+V', disabled: !G.clip || !!state.search.results, action: paste },
      '-',
      ...viewItems(),
      '-',
      ...sortItems(),
      '-',
      { label: '顯示隱藏的項目', kbd: 'Ctrl+Shift+.', check: prefs.showHidden, action: toggleHidden },
      { label: isWin ? '在檔案總管中打開' : '在系統檔案管理員中打開', action: () => api.open(state.cwd) },
    ], x, y);
  }

  content.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    const it = itemFromEl(ev.target);
    if (it?.entry) {
      if (it.col != null) await columnClick(it.entry, it.col);
      else if (!state.sel.has(it.entry.path)) { state.anchor = it.entry.path; setSelection([it.entry.path]); }
      itemMenu(it.col != null ? [it.entry] : selectedEntries(), ev.clientX, ev.clientY);
    } else {
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
      { label: '重新整理', kbd: 'F5', action: () => refresh(true) },
      '-',
      { html: '<div class="mlabel">強調色</div>' },
      { html: `<div class="mrow">${ACCENTS.map(([c, n]) => `<button class="swatch${prefs.accent === c ? ' on' : ''}" style="background:${c};color:${c}" data-accent="${c}" title="${n}"></button>`).join('')}</div>` },
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
    if (p) navigate(p.dataset.path, { root: p.dataset.path });
  });
  $('#places').addEventListener('dblclick', (ev) => {
    const p = ev.target.closest('.place');
    if (p && p.dataset.path !== HOME && !ev.target.closest('[data-twisty]')) toggleTree(p.dataset.path);
  });
  $('#places').addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const p = ev.target.closest('.place');
    if (!p) return;
    const path = p.dataset.path;
    if (path === HOME) {
      openMenu([{ label: '在新分頁中打開', action: () => openTab(HOME, { activate: false }) }], ev.clientX, ev.clientY);
      return;
    }
    const custom = !!p.dataset.custom;
    openMenu([
      { label: '打開', action: () => navigate(path, { root: path }) },
      { label: '在新分頁中打開', kbd: '滑鼠中鍵', action: () => openTab(path, { activate: false }) },
      { label: G.treeOpen.has(path) ? '摺疊' : '展開', action: () => toggleTree(path) },
      '-',
      { label: isWin ? '在檔案總管中打開' : '在系統檔案管理員中打開', action: () => api.open(path) },
      ...(custom ? ['-', { label: '取消釘選', action: () => toggleFavorite(path) }] : []),
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
    if (place?.dataset.path) { openTab(place.dataset.path, { activate: false }); return; }
    const it = itemFromEl(ev.target);
    if (it?.entry?.isDir) openTab(it.entry.path, { activate: false });
  });
  $('#tabs').addEventListener('mousedown', (ev) => {
    const tab = ev.target.closest('.tab');
    if (ev.button === 0 && tab) switchTab(tabs.find((t) => t.id === Number(tab.dataset.tab)));
  });
  $('#tabs').addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const el = ev.target.closest('.tab');
    if (!el) return;
    const t = tabs.find((x) => x.id === Number(el.dataset.tab));
    openMenu([
      { label: '新分頁', kbd: 'Ctrl+T', action: () => openTab(HOME) },
      { label: '複製分頁', action: () => openTab(t.cwd || HOME) },
      '-',
      { label: '關閉分頁', kbd: '滑鼠中鍵', action: () => closeTab(t) },
      { label: '關閉其他分頁', disabled: tabs.length < 2, action: async () => { tabs.splice(0, tabs.length, t); await switchTab(t); renderTabs(); } },
    ], ev.clientX, ev.clientY);
  });
  $('#tab-new').addEventListener('click', () => openTab(HOME));
  $('#tabbar').addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.tab, button')) return;
    if (!isTauri) W.toggleMaximize(); // Tauri drag regions maximize on their own
  });
  $('#pathbar').addEventListener('click', (ev) => {
    const c = ev.target.closest('.crumb');
    if (c?.dataset.path) navigate(c.dataset.path);
  });

  // ---------- view / prefs ----------
  function setView(v) {
    if (prefs.view === v) return;
    prefs.view = v;
    savePrefs();
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
    document.body.classList.toggle('sidebar-hidden', prefs.sidebarHidden);
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
    document.documentElement.style.setProperty('--icon', `${prefs.icon}px`);
    $('#zoom').value = prefs.icon;
    clearTimeout(setIconSize.t);
    setIconSize.t = setTimeout(() => { if (prefs.view === 'icons') renderView(false); }, 250);
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
    $('#search-scope').hidden = !searchInput.value;
    $('[data-scope="folder"]').textContent = `「${tabTitle({ ...state, search: { results: null } })}」`;
    clearTimeout(searchTimer);
    if (state.search.scope === 'deep') searchTimer = setTimeout(runDeepSearch, 300);
    else { state.search.results = null; computeEntries(); renderView(false).then(() => { renderStatus(); renderPathbar(); renderToolbar(); }); }
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { setScope('deep'); }
    else if (ev.key === 'Escape') { clearSearch(true); content.focus(); }
    else if (ev.key === 'ArrowDown') { content.focus(); moveSelection('down', ev); ev.preventDefault(); }
  });
  $('#search-clear').addEventListener('click', () => clearSearch(true));
  $('#search-scope').addEventListener('click', (ev) => { const b = ev.target.closest('[data-scope]'); if (b) setScope(b.dataset.scope); });

  function setScope(scope) {
    state.search.scope = scope;
    $$('#search-scope [data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
    if (scope === 'deep') runDeepSearch();
    else { state.search.results = null; $('#search-status').textContent = ''; computeEntries(); render(); }
  }

  async function runDeepSearch() {
    const q = state.search.query.trim();
    if (!q) return;
    state.search.busy = true;
    $('#search-status').textContent = '搜尋中…';
    renderStatus();
    const tab = state;
    const res = await api.search(state.cwd === HOME ? G.places.home : state.cwd, q, prefs.showHidden);
    if (!res || tab !== state || state.search.query.trim() !== q) return;
    state.search.busy = false;
    state.search.results = res.entries;
    $('#search-status').textContent = res.partial ? `顯示前 ${res.entries.length} 個結果` : `${res.entries.length} 個結果`;
    state.sel.clear();
    computeEntries();
    render({ animate: true });
  }

  function clearSearch(rerender, silent = false) {
    const had = state.search.query || state.search.results;
    state.search = { query: '', scope: 'folder', results: null, busy: false };
    if (silent) return; // background tab: leave the visible search box alone
    syncSearchUi();
    if (rerender && had) { computeEntries(); render(); }
  }

  // The search box shows the active tab's search.
  function syncSearchUi() {
    const q = state.search.query;
    searchInput.value = q;
    $('#search-box').classList.toggle('has-text', !!q);
    $('#search-scope').hidden = !q;
    $('#search-status').textContent = '';
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
      let perRow = items.findIndex((el) => el.offsetTop !== top0);
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
    elForPath(target.path)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    const inInput = ev.target.matches?.('input, textarea');
    const ctrl = ev.ctrlKey || ev.metaKey;
    const k = ev.key;

    if (k === 'Escape') {
      if (!menuEl.hidden) { closeMenu(); return; }
      if (ql.isOpen) { ql.close(); return; }
      if (state.search.query) { clearSearch(true); return; }
      return;
    }
    if (ctrl && k.toLowerCase() === 'f') { ev.preventDefault(); searchInput.focus(); searchInput.select(); return; }
    if (inInput) return;

    if (ctrl && k.toLowerCase() === 't') { ev.preventDefault(); openTab(HOME); return; }
    if (ctrl && k.toLowerCase() === 'w') { ev.preventDefault(); closeTab(state); return; }
    if (ctrl && k === 'Tab') { ev.preventDefault(); cycleTab(ev.shiftKey ? -1 : 1); return; }
    if (ctrl && ['1', '2', '3', '4'].includes(k)) { ev.preventDefault(); setView(['icons', 'list', 'columns', 'gallery'][Number(k) - 1]); return; }
    if (ctrl && ev.shiftKey && k.toLowerCase() === 'n') { ev.preventDefault(); newFolder(); return; }
    if (ctrl && ev.shiftKey && (k === '.' || k === '>')) { ev.preventDefault(); toggleHidden(); return; }
    if (ctrl && ev.altKey && k.toLowerCase() === 's') { ev.preventDefault(); toggleSidebar(); return; }
    if (ctrl && ev.altKey && k.toLowerCase() === 'c') { ev.preventDefault(); copyPath(); return; }
    if (ctrl && k.toLowerCase() === 'a') {
      ev.preventDefault();
      if (!inColumnsMode()) { setSelection(state.entries.map((e) => e.path)); }
      return;
    }
    if (ctrl && k.toLowerCase() === 'c') { copySelected('copy'); return; }
    if (ctrl && k.toLowerCase() === 'x') { copySelected('move'); return; }
    if (ctrl && k.toLowerCase() === 'v') { paste(); return; }
    if (ctrl && k.toLowerCase() === 'd') { ev.preventDefault(); duplicateSelected(); return; }
    if (ctrl && (k === '=' || k === '+')) { ev.preventDefault(); setIconSize(prefs.icon + 8); return; }
    if (ctrl && k === '-') { ev.preventDefault(); setIconSize(prefs.icon - 8); return; }
    if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) { ev.preventDefault(); refresh(true); return; }
    if (k === 'F2') { ev.preventDefault(); const s = selectedEntries(); if (s.length === 1) startRename(s[0]); return; }
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
        else { state.anchor = hit.path; setSelection([hit.path]); elForPath(hit.path)?.scrollIntoView({ block: 'nearest' }); }
      }
    }
  });

  window.addEventListener('mouseup', (ev) => {
    if (ev.button === 3) goBack();
    if (ev.button === 4) goForward();
  });

  // ---------- quick look ----------
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
      const from = elForPath(e.path)?.getBoundingClientRect();
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
      const body = $('#ql-body');
      body.innerHTML = '';
      const cat = I.category(e.ext);
      const info = (extra = '') => `<div class="ql-info">${e.isDir ? I.folder(specialBadge(e.path)) : I.file(e.ext)}
        <div class="pv-name">${esc(e.name)}</div><div class="pv-kind">${esc(I.kindLabel(e))}${e.isDir ? '' : ` — ${fmtSize(e.size)}`}</div>
        <div class="pv-table"><div><span>修改日期</span><span>${fmtDate(e.mtime)}</span></div>${extra}</div></div>`;
      if (e.isDir) {
        const count = await api.folderCount(e.path);
        body.innerHTML = info(`<div><span>內容</span><span>${count == null ? '--' : `${count} 個項目`}</span></div>`);
        return;
      }
      const url = P.fileUrl(e.path);
      if (WEB_IMAGES.has(e.ext)) { body.innerHTML = `<img src="${url}" draggable="false">`; return; }
      if (cat === 'video') { body.innerHTML = `<video src="${url}" controls autoplay></video>`; return; }
      if (cat === 'audio') { body.innerHTML = `<div class="ql-info">${I.file(e.ext)}<div class="pv-name">${esc(e.name)}</div><audio src="${url}" controls autoplay style="margin-top:16px;width:360px"></audio></div>`; return; }
      if (e.ext === 'pdf') { body.innerHTML = `<iframe src="${url}"></iframe>`; return; }
      if ((cat === 'text' || cat === 'code' || cat === 'other' || e.ext === 'csv' || e.ext === 'tsv') && (e.size || 0) < 20e6) {
        const res = await api.readText(e.path);
        if (this.current !== e) return;
        if (res.text != null) {
          body.innerHTML = '<pre></pre>';
          $('pre', body).textContent = res.text + (res.truncated ? '\n\n…（只顯示前 256 KB）' : '');
          return;
        }
      }
      const thumb = await api.thumb(e.path, 1024);
      if (this.current !== e) return;
      body.innerHTML = thumb ? `<img src="${thumb}" draggable="false">` : info();
    },
    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      const root = $('#ql');
      const win = $('#ql-window');
      root.classList.add('closing');
      const from = this.current && elForPath(this.current.path)?.getBoundingClientRect();
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

  // ---------- window chrome ----------
  $('#caption').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    ({ close: W.close, min: W.minimize, max: W.toggleMaximize })[b.dataset.act]();
  });
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
    document.documentElement.style.setProperty('--icon', `${prefs.icon}px`);
    document.documentElement.style.setProperty('--sidebar-w', `${prefs.sidebarW}px`);
    document.body.classList.toggle('sidebar-hidden', prefs.sidebarHidden);
    $('#zoom').value = prefs.icon;
    try {
      G.places = await api.places();
      // Like Explorer: open on Home unless a folder was passed in.
      const start = env.dir || HOME;
      if (!(await navigate(start, { root: start }))) await navigate(HOME);
      content.focus();
    } finally {
      window.__finderReady?.();
    }
  })();
})();
