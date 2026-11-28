import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  (?:async )?function \w+\(/);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('[IT-019/CHG-009] Windows preview takes priority for registered PDF handlers', () => {
  const context = vm.createContext({ api: { previewShow() {} }, prefs: { nativePreview: true },
    I: { category: () => 'pdf' }, BUILTIN_FIRST: new Set(['pdf']) });
  vm.runInContext(fn('nativeWanted'), context);
  assert.equal(!!context.nativeWanted({ ext: 'pdf', isDir: false }), true);
});

test('[IT-020/CHG-009] an old availability response cannot replace the selected preview', async () => {
  const checks = new Map([['pptx', deferred()], ['docx', deferred()]]);
  const shown = [];
  const context = vm.createContext({ native: { gen: 0 }, Symbol, previewHelpers: {},
    api: { previewShow: async (path) => { shown.push(path); return true; } },
    prefetchAround() {}, nativeWanted: () => true, nativeAvailable: (ext) => checks.get(ext).promise,
    nativeRects: () => ({ host: {}, inner: {} }), isDark: () => true, trackNative() {},
    window: { Preview: { fill() {} } } });
  vm.runInContext(fn('fillPreview'), context);
  const media = () => ({ isConnected: true, dataset: {}, prepend() {}, querySelector: () => null });
  const first = context.fillPreview(media(), { path: 'old.pptx', ext: 'pptx' });
  const second = context.fillPreview(media(), { path: 'current.docx', ext: 'docx' });
  checks.get('docx').resolve(true); await second;
  checks.get('pptx').resolve(true); await first;
  assert.deepEqual(shown, ['current.docx']);
});

test('[IT-021/CHG-009] missing handlers are rechecked after availability changes', async () => {
  let available = false, calls = 0;
  const context = vm.createContext({ native: { avail: new Map() },
    api: { previewAvailable: async () => { calls++; return available; } } });
  vm.runInContext(fn('nativeAvailable'), context);
  assert.equal(await context.nativeAvailable('pptx'), false);
  available = true;
  assert.equal(await context.nativeAvailable('pptx'), true);
  assert.equal(calls, 2);
});

test('[IT-022/CHG-009] hiding during handler discovery prevents the pending preview from opening', async () => {
  const availability = deferred();
  const shown = [];
  const context = vm.createContext({ native: { gen: 0, el: null }, previewHelpers: {},
    api: { previewHide() {}, previewShow: async (path) => { shown.push(path); return true; } },
    cancelAnimationFrame() {}, prefetchAround() {}, nativeWanted: () => true,
    nativeAvailable: () => availability.promise, nativeRects: () => ({ host: {}, inner: {} }),
    isDark: () => true, trackNative() {}, window: { Preview: { fill() {} } } });
  vm.runInContext(fn('fillPreview') + '\n' + fn('nativeHide'), context);
  const media = { isConnected: true, dataset: {} };
  const pending = context.fillPreview(media, { path: 'closed.pptx', ext: 'pptx' });
  assert.equal(context.native.el, media, 'pane closure must recognize the pending media owner');
  context.nativeHide();
  availability.resolve(true); await pending;
  assert.deepEqual(shown, []);
});

test('[IT-023/CHG-009] a native failure is labelled as fallback without discarding its error', async () => {
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {},
    api: { previewShow: async () => 'DO_PREVIEW 0x80070005' }, prefetchAround() {},
    nativeWanted: () => true, nativeAvailable: async () => true,
    nativeRects: () => ({ host: {}, inner: {} }), isDark: () => true,
    trackNative() {}, window: { Preview: { fill() {} } } });
  vm.runInContext(fn('fillPreview'), context);
  const media = { isConnected: true, dataset: {} };
  await context.fillPreview(media, { path: 'failed.pptx', ext: 'pptx' });
  assert.equal(media.dataset.nativeError, 'DO_PREVIEW 0x80070005');
  assert.ok(media.dataset.nativeStatus.includes('替代預覽'));
  assert.notEqual(media.dataset.kind, 'native');
});

function listener(target, event) {
  const marker = `  ${target}.addEventListener('${event}',`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  });', start) + '\n  });'.length);
}

test('[IT-024/CHG-009] Ctrl-click leaving one column folder selected never opens it', async () => {
  let options;
  const context = vm.createContext({ state: { cwd: '/parent', colRoot: '/', colLists: [[{ path: '/parent/Folder' }]] },
    columnSelection: () => [], selectInColumn: async (j, paths, opts) => { options = opts; }, Set });
  vm.runInContext(fn('columnModifierClick'), context);
  await context.columnModifierClick({ path: '/parent/Folder', isDir: true }, 0, { ctrlKey: true });
  assert.equal(options.openFolder, false);
});

test('[IT-025/CHG-009] right-click selects a column folder without opening it', async () => {
  let handler, opened = 0, selected;
  const context = vm.createContext({
    content: { addEventListener: (name, cb) => { handler = cb; } },
    state: { cwd: '/parent', sel: new Set(), colActive: 0 }, api: {},
    itemFromEl: () => ({ col: 0, entry: { path: '/parent/Folder', isDir: true } }),
    useWinMenu: () => true, columnClick: async () => { opened++; },
    selectInColumn: async (j, paths, opts) => { selected = { j, paths, opts }; },
    nativeMenu: async () => true, selectedEntries: () => [], setSelection() {}, itemMenu() {},
  });
  vm.runInContext(listener('content', 'contextmenu'), context);
  await handler({ preventDefault() {}, target: { closest: () => null } });
  assert.equal(opened, 0);
  assert.equal(selected.opts.openFolder, false);
  assert.equal(selected.paths[0], '/parent/Folder');
});

test('[IT-026/CHG-009] showing a preview waits until the previous native host is hidden', async () => {
  const hidden = deferred();
  const shown = [];
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {},
    api: { previewHide: () => hidden.promise, previewShow: async (path) => { shown.push(path); return true; } },
    prefetchAround() {}, nativeWanted: () => true, nativeAvailable: async () => true,
    nativeRects: () => ({ host: {}, inner: {} }), isDark: () => true,
    trackNative() {}, window: { Preview: { fill() {} } } });
  vm.runInContext(fn('fillPreview'), context);
  const pending = context.fillPreview({ isConnected: true, dataset: {} }, { path: 'current.pptx', ext: 'pptx' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.length, 0, 'late hide completion must not hide an already shown preview');
  hidden.resolve(); await pending;
  assert.deepEqual(shown, ['current.pptx']);
});

test('[IT-027/BUG-014] right pane prioritizes the PowerPoint handler and uses a shell slide thumbnail on failure', async () => {
  const events = [];
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {},
    api: { previewShow: async () => { events.push('native'); return 'DO_PREVIEW 0x80070005'; } },
    prefetchAround() {}, nativeWanted: () => true, nativeAvailable: async () => true,
    nativeRects: () => ({ host: {}, inner: {} }), isDark: () => true, trackNative() {},
    window: { Preview: { fill: async (_media, _entry, options) => events.push(options.slideThumbnail ? 'slide-thumbnail' : 'text') } } });
  vm.runInContext(fn('fillPreview'), context);
  await context.fillPreview({ isConnected: true, dataset: {}, id: 'pv-media' }, { path: 'slides.pptx', ext: 'pptx' });
  assert.deepEqual(events, ['native', 'slide-thumbnail']);
});

test('[IT-028/BUG-014] right pane never extracts slide text before a successful native preview', async () => {
  let filled = 0;
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {},
    api: { previewShow: async () => true }, prefetchAround() {}, nativeWanted: () => true,
    nativeAvailable: async () => true, nativeRects: () => ({ host: {}, inner: {} }), isDark: () => true,
    trackNative() {}, window: { Preview: { fill: () => { filled++; } } } });
  vm.runInContext(fn('fillPreview'), context);
  const media = { isConnected: true, dataset: {}, id: 'pv-media' };
  await context.fillPreview(media, { path: 'slides.pptx', ext: 'pptx' });
  assert.equal(filled, 0);
  assert.equal(media.dataset.kind, 'native');
});

test('[IT-029/BUG-014] the right pane draws the shell slide image and never substitutes text', async () => {
  const preview = fs.readFileSync(new URL('../renderer/preview.js', import.meta.url), 'utf8');
  let extracted = 0;
  let image = 'data:image/png;base64,fixture';
  const context = vm.createContext({
    window: {
      Icons: { esc: String, category: () => 'slides', kindLabel: () => 'PowerPoint', file: () => '' },
      fsApi: { contentThumbnail: async () => image, richPreview: async () => { extracted++; } },
    },
  });
  vm.runInContext(preview, context);
  const pane = { dataset: {}, querySelector: () => null };
  const helpers = { icon: () => '', badge: () => '', fmtSize: String, fmtDate: String };
  const entry = { path: 'slides.pptx', name: 'slides.pptx', ext: 'pptx', isDir: false };
  await context.window.Preview.fill(pane, entry, { helpers, slideThumbnail: true });
  assert.match(pane.innerHTML, /data:image\/png;base64,fixture/);
  assert.equal(pane.dataset.kind, 'media');
  image = null;
  await context.window.Preview.fill(pane, entry, { helpers, slideThumbnail: true });
  assert.match(pane.innerHTML, /無法顯示投影片版面/);
  assert.equal(pane.dataset.kind, 'info');
  assert.equal(extracted, 0);
});

test('[IT-030/BUG-014] the rightmost column uses the slide image instead of extracted text', async () => {
  const options = [];
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {}, api: {},
    prefetchAround() {}, nativeWanted: () => false,
    window: { Preview: { fill: (_media, _entry, optionsUsed) => options.push(optionsUsed) } } });
  vm.runInContext(fn('fillPreview'), context);
  await context.fillPreview({ isConnected: true, dataset: {} }, { path: 'slides.pptx', ext: 'pptx' });
  assert.equal(options.length, 1);
  assert.equal(options[0].slideThumbnail, true);
});

test('[IT-031/BUG-014] column previews load when the slide column scrolls into view', async () => {
  const frames = [];
  let visible = false;
  let rendered = 0;
  const context = vm.createContext({ native: { gen: 0 }, previewHelpers: {},
    api: { previewShow: async () => { rendered++; return true; } },
    nativeWanted: () => true, nativeAvailable: async () => true, prefetchAround() {},
    nativeRects: () => visible ? { host: {}, inner: {} } : null,
    requestAnimationFrame: (callback) => frames.push(callback),
    performance: { now: () => 0 }, isDark: () => true, trackNative() {},
    window: { Preview: { fill() {} } } });
  vm.runInContext(fn('fillPreview'), context);
  const media = { isConnected: true, dataset: {} };
  const pending = context.fillPreview(media, { path: 'slides.pptx', ext: 'pptx' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendered, 0);
  assert.equal(frames.length, 1);
  visible = true;
  frames.shift()();
  await pending;
  assert.equal(rendered, 1);
  assert.equal(media.dataset.kind, 'native');
});
