import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const nativeMenu = source.slice(source.indexOf('  async function nativeMenu('), source.indexOf('  async function showProperties('));
const createFolder = source.slice(source.indexOf('  async function newFolderNow('), source.indexOf('  function newFile('));

function fixture(verb) {
  const calls = [];
  const entry = { path: '/files/New folder', name: 'New folder', isDir: true };
  const state = { cwd: '/files', search: {}, sel: new Set() };
  const context = vm.createContext({
    state, HOME: 'home', Set,
    api: { nativeMenu: async () => verb, mkdir: async (dir) => {
      calls.push(['mkdir', dir]); return { ok: true, path: entry.path };
    } },
    P: { dirname: () => '/files' }, norm: (p) => p, isVirtual: () => false,
    closeMenu() {}, toExtras: () => ({ extras: [], actions: [] }),
    pushUndo() {}, trashUndo() {}, toast: (s) => calls.push(['toast', s]),
    listDir: async () => calls.push(['listDir']),
    inColumnsMode: () => false, computeEntries() {},
    render: async () => calls.push(['render']), entryOf: () => entry,
    startRename: (e) => calls.push(['rename', e.path]), batchRename() {},
    setTimeout: () => calls.push(['delayed-refresh']),
  });
  vm.runInContext(createFolder + '\nfunction newFolder() { return newFolderNow(); }\n' + nativeMenu, context);
  return { calls, state, context };
}

test('[IT-001/BUG-001] native NewFolder creates once and starts inline rename after render', async () => {
  const { calls, state, context } = fixture('newfolder');
  assert.equal(await context.nativeMenu([], { background: true }), true);
  assert.deepEqual(calls, [['mkdir', '/files'], ['listDir'], ['render'], ['rename', '/files/New folder']]);
  assert.deepEqual([...state.sel], ['/files/New folder']);
  assert.equal(state.focus, '/files/New folder');
});

test('[IT-002/BUG-001] item rename still delegates to inline rename without creating a folder', async () => {
  const { calls, context } = fixture('rename');
  await context.nativeMenu([{ path: '/files/existing' }]);
  assert.deepEqual(calls, [['rename', '/files/existing']]);
});

test('[IT-003/BUG-001] cancelled native menu does not create or rename anything', async () => {
  const { calls, context } = fixture('');
  await context.nativeMenu([], { background: true });
  assert.deepEqual(calls, [['delayed-refresh']]);
});
