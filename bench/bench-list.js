// node bench/bench-list.js <folder> — same listing logic as the old Electron backend.
const fsp = require('fs').promises;
const path = require('path');
async function list(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (let i = 0; i < dirents.length; i += 256) {
    out.push(...await Promise.all(dirents.slice(i, i + 256).map(async (d) => {
      const full = path.join(dir, d.name);
      const st = await fsp.stat(full).catch(() => null);
      return { name: d.name, isDir: st?.isDirectory(), size: st?.size, mtime: st?.mtimeMs };
    })));
  }
  return out;
}
(async () => {
  const dir = process.argv[2];
  let best = Infinity; let n = 0;
  for (let i = 0; i < 5; i++) { const t = performance.now(); n = (await list(dir)).length; best = Math.min(best, performance.now() - t); }
  console.log(`node: ${n} entries, best of 5: ${best.toFixed(1)} ms`);
})();
