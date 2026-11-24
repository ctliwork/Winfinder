import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `function ${name} exists`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  (?:async )?function \w+\(/);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('[IT-004/BUG-002] an in-flight watcher read cannot repaint an active rename', async () => {
  const read = deferred();
  let paints = 0;
  const context = vm.createContext({
    G: { renaming: null }, state: { cwd: '/files', search: {}, sel: new Set() }, HOME: 'home',
    dirCache: new Map([['/files', { entries: [] }]]),
    listDir: () => read.promise, computeEntries() {}, render: async () => { paints++; },
    setTimeout: () => 1, clearTimeout() {}, Set,
  });
  vm.runInContext('let refreshQueued = new Set(["/files"]); let refreshTimer;\n' + fn('flushRefresh') + '\n' + fn('refresh'), context);
  const pending = context.flushRefresh();
  context.G.renaming = '/files/renaming';
  read.resolve();
  await pending;
  assert.equal(paints, 0, 'watcher must defer rendering when rename starts during its read');
  context.G.renaming = null;
  await context.flushRefresh();
  assert.equal(paints, 1, 'deferred changes render after editing ends');
});

function searchFixture() {
  const pending = [];
  const status = { textContent: '' };
  const tab = { cwd: '/files', search: { query: 'report', scope: 'deep', filters: {}, busy: false, results: null }, sel: new Set() };
  const context = vm.createContext({
    state: tab, HOME: 'home', prefs: {}, G: {}, Symbol,
    $: () => status, filtersOn: () => false, renderStatus() {}, computeEntries() {}, render() {},
    searchFilter: (f) => f, everythingQuery: (q) => q,
    api: { search: (...args) => { const d = deferred(); pending.push({ ...d, args }); return d.promise; } },
  });
  vm.runInContext(fn('runDeepSearch'), context);
  return { context, pending, tab, status };
}

test('[IT-005/BUG-003] an old deep search cannot overwrite folder-scope results', async () => {
  const { context, pending, tab } = searchFixture();
  const run = context.runDeepSearch();
  tab.search.scope = 'folder';
  pending[0].resolve({ entries: [{ path: '/files/stale' }] });
  await run;
  assert.equal(tab.search.results, null);
});

test('[IT-006/BUG-003] same-query searches with changed filters accept only the latest response', async () => {
  const { context, pending, tab } = searchFixture();
  const first = context.runDeepSearch();
  tab.search.filters = { kind: 'image' };
  const second = context.runDeepSearch();
  pending[1].resolve({ entries: [{ path: '/files/latest' }] });
  await second;
  pending[0].resolve({ entries: [{ path: '/files/stale' }] });
  await first;
  assert.equal(tab.search.results[0].path, '/files/latest');
});

test('[IT-007/BUG-004] Ctrl+Z waits for an in-flight new text file instead of undoing the previous action', async () => {
  const created = deferred();
  const effects = [];
  const context = vm.createContext({
    state: { cwd: '/files', search: {}, sel: new Set() }, HOME: 'home', Set,
    G: { renaming: null },
    api: { newFile: () => created.promise, trash: async (paths) => { effects.push(paths[0]); return []; } },
    listDir: async () => {}, inColumnsMode: () => false, computeEntries() {}, render: async () => {},
    startRename() {
      context.G.renaming = '/files/new.txt';
      context.G.cancelRename = async () => { context.G.renaming = null; };
    }, entryOf: () => null, toast() {}, dirCache: new Map(), refresh: async () => {},
    errText: (s) => s,
  });
  const undoStart = source.indexOf('  const undoStack = []');
  const undoEnd = source.indexOf('  function transfer(', undoStart);
  vm.runInContext(source.slice(undoStart, undoEnd) + '\n' + fn('newFile') +
    (source.includes('  async function newFileNow(') ? '\n' + fn('newFileNow') : ''), context);
  context.pushUndo('previous', async () => { effects.push('previous'); });
  const creating = context.newFile();
  const undoing = context.undo();
  await Promise.resolve();
  created.resolve({ ok: true, path: '/files/new.txt' });
  await Promise.all([creating, undoing]);
  assert.deepEqual(effects, ['/files/new.txt']);
  assert.equal(context.G.renaming, null, 'undo must close the editor before deleting its new file');
});

test('[IT-008/BUG-005] right-clicking empty space in an ancestor column targets that column', async () => {
  const root = '/files';
  const calls = [];
  let handler;
  const context = vm.createContext({
    state: { cwd: '/files/child' },
    content: { addEventListener: (_event, cb) => { handler = cb; } },
    itemFromEl: () => null, inColumnsMode: () => true, useWinMenu: () => true,
    api: { nativeMenu() {} }, norm: (p) => p,
    navigate: async (dir) => { context.state.cwd = dir; return true; },
    nativeMenu: async () => { calls.push(context.state.cwd); return true; },
    appItemsForBackground: () => [], ancestors: () => [root, '/files/child'],
    backgroundMenu: async () => { calls.push(context.state.cwd); },
  });
  const start = source.indexOf("  content.addEventListener('contextmenu'");
  const end = source.indexOf("  $('#btn-more')", start);
  vm.runInContext(source.slice(start, end), context);
  await handler({ preventDefault() {}, target: { closest: (s) => s === '.col' ? { dataset: { dir: root } } : null } });
  assert.deepEqual(calls, [root]);
});

test('[IT-009/BUG-006] deleting an ancestor folder returns to its surviving parent', async () => {
  const context = vm.createContext({
    state: { cwd: '/files/parent/child', colRoot: '/files', colActive: 0, sel: new Set() },
    prefs: {}, selectedEntries: () => [{ path: '/files/parent', name: 'parent', isDir: true }],
    isVirtual: () => false, api: { trash: async () => [] }, vanish: async () => {},
    toast() {}, inColumnsMode: () => true, ancestors: () => ['/files', '/files/parent', '/files/parent/child'],
    P: { dirname: (p) => p.slice(0, p.lastIndexOf('/')) },
    isUnder: (p, root) => p === root || p.startsWith(root + '/'),
    navigate: async (dir) => { context.state.cwd = dir; }, refresh: async () => {},
  });
  vm.runInContext(fn('trashSelectedNow'), context);
  await context.trashSelectedNow();
  assert.equal(context.state.cwd, '/files');
});

test('[IT-010/BUG-007] confirming an IME candidate does not submit an inline rename', async () => {
  const listeners = {};
  const renamed = [];
  const input = {
    isConnected: true, focus() {}, setSelectionRange() {},
    addEventListener: (name, cb) => { listeners[name] = cb; },
    replaceWith() {},
  };
  const label = { replaceWith() {} };
  const entry = { path: '/files/old.txt', name: 'old.txt' };
  const context = vm.createContext({
    G: { renaming: null }, isVirtual: () => false, revealPath: () => ({}),
    $: () => label, document: { createElement: () => input },
    track: (p) => p, api: { rename: async (_path, name) => { renamed.push(name); return { ok: false }; } },
    refresh: async () => {}, content: { focus() {} }, toast() {}, errText: (e) => e,
  });
  vm.runInContext(fn('startRename'), context);
  context.startRename(entry);
  input.value = '中文檔名.txt';
  listeners.keydown({ key: 'Enter', isComposing: true, stopPropagation() {} });
  await Promise.resolve();
  assert.deepEqual(renamed, []);
  assert.equal(context.G.renaming, entry.path);
  listeners.keydown({ key: 'Enter', isComposing: false, stopPropagation() {} });
  await Promise.resolve();
  assert.deepEqual(renamed, ['中文檔名.txt']);
});

test('[IT-011/BUG-003] a completed background search updates its own tab without repainting the active tab', async () => {
  const { context, pending, tab } = searchFixture();
  const run = context.runDeepSearch();
  const other = { cwd: '/other', search: { results: null } };
  context.state = other;
  pending[0].resolve({ entries: [{ path: '/files/result' }] });
  await run;
  assert.equal(tab.search.busy, false);
  assert.equal(tab.search.results[0].path, '/files/result');
  assert.equal(other.search.results, null);
});

test('[IT-012/BUG-003] clearing a deep search invalidates its pending response', async () => {
  const { context, pending, tab, status } = searchFixture();
  const run = context.runDeepSearch();
  tab.search.query = '';
  await context.runDeepSearch();
  pending[0].resolve({ entries: [{ path: '/files/stale' }] });
  await run;
  assert.equal(tab.search.results, null);
  assert.equal(tab.search.busy, false);
  assert.equal(status.textContent, '');
});

test('[IT-013/BUG-008] background pathbar updates preserve a path being typed', () => {
  const original = '<input id="path-input" value="/typing">';
  let editing = true;
  const bar = { classList: { contains: () => editing }, innerHTML: original, scrollWidth: 100 };
  const context = vm.createContext({
    state: { cwd: '/files', search: {} }, HOME: 'home', $: () => bar,
    P: { root: () => '/' }, ancestors: () => ['/', '/files'],
    shellIco: () => '', folderIco: () => '', I: { drive: () => '' },
    esc: (s) => s, displayName: (s) => s,
  });
  vm.runInContext(fn('renderPathbar'), context);
  context.renderPathbar();
  assert.equal(bar.innerHTML, original, 'an async redraw must not replace the active address editor');
  editing = false;
  context.renderPathbar();
  assert.ok(bar.innerHTML.includes('data-path="/files"'), 'path breadcrumbs update after editing finishes');
});

test('[IT-014/BUG-008] finishing a rename does not steal focus from another text editor', async () => {
  const read = deferred();
  const listeners = {};
  let focuses = 0;
  const input = { isConnected: true, focus() {}, setSelectionRange() {}, replaceWith() {},
    addEventListener: (name, cb) => { listeners[name] = cb; } };
  const label = { replaceWith() {} };
  const context = vm.createContext({
    G: {}, isVirtual: () => false, revealPath: () => ({}), $: () => label,
    document: { createElement: () => input, activeElement: { matches: () => true } },
    refresh: () => read.promise, content: { focus: () => { focuses++; } },
  });
  vm.runInContext(fn('startRename'), context);
  context.startRename({ path: '/files/a', name: 'a' });
  listeners.keydown({ key: 'Escape', stopPropagation() {} });
  read.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(focuses, 0);
});

test('[IT-015/BUG-009] paste waits for the preceding asynchronous clipboard write', async () => {
  const write = deferred();
  let clipboard = null;
  const transfers = [];
  const context = vm.createContext({
    G: {}, state: { cwd: '/destination', search: {} }, HOME: 'home',
    selectedEntries: () => [{ path: '/source/B.txt' }], isVirtual: () => false,
    toast() {}, render() {},
    api: {
      clipboardWrite: async (paths, cut) => { await write.promise; clipboard = { paths, cut }; },
      clipboardRead: async () => clipboard,
    },
    transfer: async (...args) => { transfers.push(args); },
  });
  vm.runInContext(fn('copySelected') + '\n' + fn('clipboardFiles') + '\n' + fn('paste'), context);
  context.copySelected('copy');
  const pasting = context.paste();
  write.resolve();
  await pasting;
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0][1][0], '/source/B.txt');
});
