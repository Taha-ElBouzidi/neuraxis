#!/usr/bin/env node
// Commits and pushes only the named paths of the brain, in one turn of the brain write lock, when they changed.
//
//   node tools/commit-paths.mjs "<message>" <path> [<path> ...]
//   node tools/commit-paths.mjs --background "<message>" <path> ...   (returns at once; the work runs detached)
//
// Why (2026-11-05, timers to events, HAVOK's item 1): the nightly HavokBrainSync task was the only thing that
// committed vault.json (every vault store, by the CLI and by the brain server) and index/contacts.json (the WhatsApp
// contacts job): its commits of 2026-11-04 and 2026-11-05 held exactly those. Each writer now commits its own file the
// moment it writes it, so the nightly task can go. Only the named paths are committed: this folder is shared with
// sessions editing code, and a plain commit would take their half-done work.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrainLockSync } from './brain-git-lock.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.sync.log');
const log = (line) => { try { appendFileSync(LOG, new Date().toISOString() + ' commit-paths ' + line + '\n'); } catch { /* best effort */ } };
const git = (args, timeout = 120_000) => spawnSync('git', ['-C', BRAIN, ...args], { encoding: 'utf8', timeout, windowsHide: true });

// Start this tool detached and return at once: a vault store or the contacts job never waits on git.
export function commitPathsInBackground(message, paths) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), message, ...paths], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export function commitPaths(message, paths) {
  return withBrainLockSync('commit-paths: ' + message, () => {
    const changed = git(['status', '--porcelain', '--', ...paths]).stdout.trim();
    if (!changed) return 'nothing to commit';
    const add = git(['add', '--', ...paths]);
    if (add.status !== 0) return 'add failed: ' + String(add.stderr).trim().slice(0, 200);
    const c = git(['commit', '-q', '-m', message, '--', ...paths], 240_000);
    if (c.status !== 0) return 'commit failed: ' + String(c.stderr || c.stdout).trim().slice(0, 200);
    const p = git(['push', '-q', 'origin', 'HEAD']);
    if (p.status !== 0) {
      // Behind the remote: take its commits, then push again once. From Gitea where it exists: origin's fetch address
      // is the GitHub copy, while the refusing push is Gitea's.
      const from = /\bgitea\b/.test(git(['remote']).stdout) ? ['gitea', 'master'] : [];
      const pull = git(['pull', '-q', '--no-rebase', '--no-edit', ...from], 180_000);
      const p2 = pull.status === 0 ? git(['push', '-q', 'origin', 'HEAD']) : pull;
      if (p2.status !== 0) return 'committed, push failed: ' + String(p2.stderr).trim().slice(0, 200);
    }
    return 'committed and pushed';
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const background = args[0] === '--background';
  if (background) args.shift();
  const [message, ...paths] = args;
  if (!message || paths.length === 0) { console.error('usage: node tools/commit-paths.mjs [--background] "<message>" <path> ...'); process.exit(2); }
  if (background) { commitPathsInBackground(message, paths); process.exit(0); }
  let result;
  try { result = commitPaths(message, paths); } catch (e) { result = 'failed: ' + String((e && e.message) || e).slice(0, 200); }
  log(paths.join(',') + ': ' + result);
  console.log(result);
  process.exit(/failed/.test(result) ? 1 : 0);
}
