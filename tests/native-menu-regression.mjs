import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function nativeMenu(');
const end = source.indexOf('  async function showProperties(', start);
const nativeMenu = source.slice(start, end);

for (const [label, entries, options, expected] of [
  ['file', [{ path: '/files/A.txt' }], {}, ['/files/A.txt']],
  ['multi-selection', [{ path: '/files/A.txt' }, { path: '/files/B.txt' }], {}, ['/files/A.txt', '/files/B.txt']],
  ['background', [], { background: true }, ['/files']],
  ['extended menu', [{ path: '/files/A.txt' }], { shift: true }, ['/files/A.txt']],
]) {
  test(`[IT-017/CHG-008] ${label} uses the unmodified native shell menu`, async () => {
    const calls = [];
    const context = vm.createContext({
      state: { cwd: '/files', search: {} }, HOME: 'home',
      P: { dirname: () => '/files' }, norm: (p) => p, isVirtual: () => false,
      closeMenu() {}, toast() {}, setTimeout() {},
      toExtras: (items) => ({ extras: items.map((i, id) => ({ id, label: i.label })), actions: items.map((i) => i.action) }),
      api: { nativeMenu: async (...args) => { calls.push(args); return ''; } },
    });
    vm.runInContext(nativeMenu, context);
    await context.nativeMenu(entries, { ...options,
      items: [{ label: 'Winfinder custom command', action() { throw Error('must not run'); } }],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(Array.from(calls[0][0]), expected);
    assert.equal(calls[0][1], !!options.background);
    assert.equal(calls[0][2], !!options.shift);
    assert.equal(calls[0][3].length, 0, 'no Winfinder commands may be injected into the shell menu');
  });
}
