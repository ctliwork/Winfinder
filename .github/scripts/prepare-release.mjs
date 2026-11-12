// Fail before expensive compilation if release authorization, source, or tag access is invalid.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from main.');
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Missing source SHA.');
const version = `0.3.${process.env.GITHUB_RUN_NUMBER}`;
const tag = `v${version}`;
const headers = {
  Authorization: `Bearer ${process.env.GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
async function api(route, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
    ...options, headers: { ...headers, ...options.headers },
  });
  if (!res.ok) throw new Error(`GitHub ${route}: HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

let notes = process.env.RELEASE_NOTES || '下載 Winfinder_x64-setup.exe 安裝。已安裝的版本會自動提示更新。';
if (process.env.GITHUB_EVENT_NAME === 'push') {
  const request = JSON.parse(fs.readFileSync('.github/release-request.json', 'utf8'));
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(request.request_id || '')) throw new Error('Invalid release request ID.');
  let previous = null;
  try {
    previous = JSON.parse(execFileSync('git', ['show', `${sha}^:.github/release-request.json`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { /* first release request has no previous file */ }
  if (previous?.request_id === request.request_id) throw new Error('Use a new request_id to request another release.');
  if (!/^[0-9a-f]{40}$/.test(request.validated_sha || '')) throw new Error('Invalid validated commit SHA.');
  if (!Number.isSafeInteger(request.validation_run_id) || request.validation_run_id <= 0) throw new Error('Invalid validation run ID.');
  const run = await api(`actions/runs/${request.validation_run_id}`);
  if (run.conclusion !== 'success' || run.status !== 'completed' ||
      run.head_branch !== 'main' || run.head_sha !== request.validated_sha ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      !['Glass interface check', 'Windows test'].includes(run.name)) {
    throw new Error('The release request does not identify a successful main-branch validation.');
  }
  execFileSync('git', ['diff', '--exit-code', request.validated_sha, sha, '--',
    'renderer', 'src-tauri', 'package.json', 'package-lock.json', 'main.js', 'preload.js'], { stdio: 'inherit' });
  if (typeof request.notes !== 'string' || !request.notes.trim() || request.notes.length > 8000) throw new Error('Missing or oversized release notes.');
  notes = request.notes;
  console.log(`Validated source ${request.validated_sha}; release request ${request.request_id}.`);
}
// Tag the checked-out default-branch commit before compiling. Never retarget an existing tag.
const refRoute = `git/ref/tags/${tag}`;
const existing = await fetch(`https://api.github.com/repos/${repo}/${refRoute}`, { headers });
if (existing.status === 404) {
  const created = await api('git/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  });
  if (created.object?.sha !== sha) throw new Error('Created tag points at an unexpected commit.');
} else {
  if (!existing.ok) throw new Error(`Cannot check release tag: HTTP ${existing.status}`);
  if ((await existing.json()).object?.sha !== sha) throw new Error('Release tag already points at another commit.');
}
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = version;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
const delimiter = `NOTES_${randomUUID()}`;
fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nnotes<<${delimiter}\n${notes}\n${delimiter}\n`);
fs.appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\nTAG=${tag}\n`);
console.log(`Prepared ${tag} at ${sha}; tag access verified before compilation.`);
