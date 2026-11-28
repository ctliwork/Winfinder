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
