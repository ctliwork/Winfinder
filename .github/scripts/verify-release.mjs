import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(fs.readFileSync('updater-check/latest.json', 'utf8'));
assert.equal(manifest.version.replace(/^v/, ''), process.env.VERSION, 'updater version');
const platforms = Object.values(manifest.platforms || {});
assert.ok(platforms.some((p) => typeof p.signature === 'string' && p.signature.trim() &&
  typeof p.url === 'string' && p.url.includes(`/releases/download/${process.env.TAG}/`) && p.url.endsWith('.exe')),
  'signed Windows EXE updater');
const release = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${process.env.TAG}`], { encoding: 'utf8' }));
assert.equal(release.draft, false, 'release is published');
assert.equal(release.prerelease, false, 'release is stable');
for (const name of ['Winfinder_x64-setup.exe', 'Finder-for-Windows_x64-setup.exe', 'latest.json']) {
  assert.ok(release.assets.some((a) => a.name === name && a.state === 'uploaded' && a.size > 0), `missing asset: ${name}`);
}
console.log(`Verified ${release.tag_name}: installers uploaded and updater has a signature and matching version.`);
