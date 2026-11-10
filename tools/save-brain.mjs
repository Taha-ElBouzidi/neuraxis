#!/usr/bin/env node
// Save the brain in the background: reindex, verify, commit and push, without making anyone wait.
//
// The owner, 2026-09-17: "that call should be in the back end, no need to block us, and this should be the
// standard for all agent brain functionalities, it should be in the background, it shouldn't affect
// the flow of the conversation."
//
// An agent used to write a memory and then sit through build-index, verify and a commit hook, 20 to 60
// seconds of a conversation spent on bookkeeping. Now it writes the file and runs this, which returns
// at once and does the rest in a detached process. Results go to .save-brain.log.
//
//   node tools/save-brain.mjs "commit message"                  memory/, index/, MANIFEST.md
//   node tools/save-brain.mjs "commit message" tools/x.mjs      those paths as well
//   node tools/save-brain.mjs --status                          the last runs
//
// Machines that are not the brain host write through `brain-client.mjs write`, which the server now also
// indexes and backs up in the background.
//
// ON A BRAIN HOST WITH brain.json memoryWritesThroughServer (the owner's the host, M2 of the system review 2026-11-09):
// memories are saved only through the brain server, like on every other machine, so no session sweeps another's
// unsaved memory edits into its commit. Here this script then commits only the paths it is given (code, never
// memory/), and saves memories only as a fallback while the brain server is down, only the slugs it is given:
//   node tools/save-brain.mjs "commit message" tools/x.mjs                  those paths only
//   node tools/save-brain.mjs --fallback "commit message" <slug> [<slug>]   brain server down: these memories only

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority as osSetPriority, constants as osConstants } from 'node:os';
import { withBrainLockSync } from './brain-git-lock.mjs';
import { isPublicName } from './public-install.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.save-brain.log');
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const log = (s) => { try { appendFileSync(LOG, new Date().toISOString() + '  ' + s + NL); } catch { /* the log is a courtesy */ } };

if (argv[0] === '--status') {
  const lines = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split(NL).slice(-12) : ['no runs yet'];
  process.stdout.write(lines.join(NL) + NL);
  process.exit(0);
}

const SERVER_ONLY = (() => { try { return JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).memoryWritesThroughServer === true; } catch { return false; } })();
const SLUG_RE = /^[a-z][a-z0-9_]{2,80}$/;
const isMemoryPath = (p) => /^memory[\\/]/.test(String(p).replace(/^\.[\\/]/, '')) || String(p).replace(/[\\/]+$/, '') === 'memory';

if (argv[0] !== '--worker') {
  if (SERVER_ONLY && argv[0] === '--fallback') {
    const [, message, ...slugs] = argv;
    if (!message || !slugs.length || slugs.some((s) => !SLUG_RE.test(s.replace(/\.md$/, '')))) {
      process.stderr.write('usage: node tools/save-brain.mjs --fallback "commit message" <slug> [<slug>...]' + NL); process.exit(1);
    }
    const st = spawnSync(process.execPath, [join(BRAIN, 'tools', 'brain-client.mjs'), 'status'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (/\bUP on\b/.test(String(st.stdout))) {
      process.stderr.write('the brain server is up: save the memory through it, node tools/brain-client.mjs write <slug> --file <path>. The fallback is only for a server that does not answer.' + NL);
      process.exit(1);
    }
  } else if (SERVER_ONLY) {
    const [message, ...paths] = argv;
    if (!message || !paths.length || paths.some(isMemoryPath)) {
      process.stderr.write('On this brain host a memory is saved through the brain server: node tools/brain-client.mjs write <slug> --file <path>'
        + ' (delete: brain-client.mjs delete <slug> --why "..."). save-brain.mjs commits only the code paths it is given: node tools/save-brain.mjs "message" tools/x.mjs.'
        + ' Brain server down: node tools/save-brain.mjs --fallback "message" <slug> [<slug>...]' + NL);
      process.exit(1);
    }
  }
  const message = argv[0] === '--fallback' ? argv[1] : argv[0];
  if (!message) { process.stderr.write('usage: node tools/save-brain.mjs "commit message" [paths...]' + NL); process.exit(1); }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...argv], {
    cwd: BRAIN, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  process.stdout.write('saving in the background: index, verify, commit, push. Check with node tools/save-brain.mjs --status' + NL);
  process.exit(0);
}

// ---------------------------------------------------------------- the worker
// BELOW NORMAL PRIORITY, inherited by build-index and build-embeddings. On the brain host a save competes with the
// brain server for the CPU; at normal priority a rebuild slowed recall from other machines to 17 s and
// made secret reads time out (2026-09-28). Background work waits; recall does not.
try { osSetPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here: run at normal */ }
const FALLBACK = argv[1] === '--fallback';
const [message, ...rest] = FALLBACK ? argv.slice(2) : argv.slice(1);
const fallbackSlugs = FALLBACK ? rest.map((s) => s.replace(/\.md$/, '')) : [];
const extra = FALLBACK ? [] : rest;
// The brain's pre-commit lets this commit of memory/ through (M2).
if (FALLBACK) process.env.HAVOK_SAVE_FALLBACK = '1';
const run = (cmd, args, timeout) => execFileSync(cmd, args, { cwd: BRAIN, timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// git's own index.lock can still be held by something outside the brain write lock (an agent running git by hand).
const OUTSIDE_LOCK_WAIT_MS = 180000;
const why = (e) => (String(e.stdout || '') + String(e.stderr || '') + String(e.message || '')).replace(/\s+/g, ' ');
log('start: ' + message);
let provenance = null;
try { provenance = await import('./provenance.mjs'); } catch (e) { log('provenance skipped: ' + String(e.message).slice(0, 120)); }
let exitCode = 0;
try { exitCode = withBrainLockSync('save-brain: ' + message, saveUnderLock); }
catch (e) { log('FAILED to commit: ' + message + ' | ' + String(e.message).slice(0, 240)); exitCode = 1; }
// After the lock, not under it: reflect only reads and takes about 18 s on the host, which every other writer waited
// through on each save (audit 2026-11-01, tools/save-brain-lock.test.mjs).
if (exitCode === 0) warnIfBrainHasFindings();
process.exit(exitCode);

// Index, commit and push in one turn of the brain write lock (tools/brain-git-lock.mjs), so two saves never collide:
// the second one waits for the first instead of failing on git's index.lock. Returns the exit code.
function saveUnderLock() {
  try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch (e) { log('build-index failed: ' + String(e.stderr || e.message).split(NL)[0].slice(0, 160)); }
  // Who wrote what (tools/provenance.mjs): every memory file this save is about to commit gets a ledger line. The
  // worker inherits the agent's environment, so it sees the same session as the agent that ran the save. In a shared
  // folder another session's unsaved edits are swept in too; they are stamped with this writer, marked via save-brain.
  if (provenance) {
    try {
      if (SERVER_ONLY && !FALLBACK) throw new Error('no memories in this save');
      const st = run('git', ['status', '--porcelain', '--', ...(FALLBACK ? fallbackSlugs.map((s) => 'memory/' + s + '.md') : ['memory/'])], 30000).split(NL).filter(Boolean);
      const entries = st.map((l) => ({ code: l.slice(0, 2), file: l.slice(3).trim().replace(/^"|"$/g, '') }))
        .filter((x) => /\.md$/.test(x.file) && !/MEMORY\.md$/.test(x.file))
        .map((x) => ({ slug: x.file.split('/').pop().replace(/\.md$/, ''), action: /D/.test(x.code) ? 'delete' : /\?|A/.test(x.code) ? 'new' : 'update' }));
      if (entries.length) provenance.record(entries, provenance.whoAmI(), 'save-brain');
    } catch (e) { log('provenance skipped: ' + String(e.message).slice(0, 120)); }
  }
  const outsideUntil = Date.now() + OUTSIDE_LOCK_WAIT_MS;
  let drift = 0;
  // An install ignores index/ and MANIFEST.md, and git add refuses a named path that is ignored, so every save there
  // failed before it committed (2026-11-02, tools/save-brain-push.test.mjs). Ignored or missing paths are left out.
  const notIgnored = (p) => { try { run('git', ['check-ignore', '-q', '--', p], 30000); return false; } catch { return true; } };
  // On a server-only brain host: the given code paths only, or in the fallback the given memories with the generated
  // files; never the whole memory/ folder (M2).
  const generated = ['index/', 'MANIFEST.md', 'provenance/'].filter((p) => existsSync(join(BRAIN, p)));
  const paths = (SERVER_ONLY
    ? (FALLBACK ? [...fallbackSlugs.map((s) => 'memory/' + s + '.md'), 'memory/MEMORY.md', ...generated] : extra)
    : [...['memory/', ...generated].filter((p) => existsSync(join(BRAIN, p))), ...extra]).filter(notIgnored);
  for (let attempt = 1; ; attempt += 1) {
    try {
      run('git', ['add', '-A', '--', ...paths], 60000);
      // The updated: date before the commit (git drops what the pre-commit stamps in a commit limited to paths).
      if (FALLBACK) { try { run(process.execPath, [join(BRAIN, 'tools', 'stamp-updated.mjs')], 60000); run('git', ['add', '-A', '--', ...paths.filter((p) => p.startsWith('memory/') && existsSync(join(BRAIN, p)))], 60000); } catch { /* the commit still runs */ } }
      // Only what this save added: the folder is shared, and a plain commit sweeps in another session's staged code.
      run('git', ['commit', '-q', '-m', message, '--', ...paths], 240000);
      // The real index takes HEAD for these paths (a commit limited to paths uses its own index; see brain-server.mjs).
      try { run('git', ['reset', '-q', '--', ...paths], 30000); } catch { /* the next save resyncs */ }
      break;
    } catch (e) {
      const w = why(e);
      // Someone else's commit may already have taken these files. The push below still runs.
      if (/nothing to commit|no changes added/i.test(w)) { log('nothing new to commit: ' + message); break; }
      if (/index\.lock|cannot lock ref|Another git process/i.test(w) && Date.now() < outsideUntil) { sleep(Math.min(2000 * attempt, 10000)); continue; }
      // The agent kept writing after this run indexed, which is the whole point of not waiting. Drift
      // from that is healed by indexing again, never reported as a failure. Seen on the first real run.
      if (/index drift/i.test(w) && ++drift < 4) {
        try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch { /* the retry will say */ }
        continue;
      }
      log('FAILED to commit: ' + message + ' | ' + w.slice(0, 240));
      return 1;
    }
  }
  const target = pushTarget();
  if (target.skip) { log('committed, not pushed: ' + target.skip); return 0; }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { run('git', ['push', '-q', target.remote, 'HEAD'], 120000); log('done: ' + message); return 0; }
    catch (e) {
      // Refused because the remote moved on (another machine pushed): take its commits, then push again. Until
      // 2026-11-05 only the nightly HavokBrainSync task pulled, so a refused save waited up to a day (4 on 2026-11-04).
      if (/non-fast-forward|fetch first|rejected/i.test(why(e))) {
        try { const from = /gitea/.test(run('git', ['remote'], 10000)) ? 'gitea' : target.remote; run('git', ['pull', '-q', '--no-rebase', '--no-edit', from, 'master'], 180000); } catch (p) { log('pull before push failed: ' + why(p).slice(0, 200)); }
      }
      if (attempt < 3) { sleep(5000 * attempt); continue; }
      log('committed but NOT pushed: ' + message + ' | ' + why(e).slice(0, 240));
      return 1;
    }
  }
  return 1;
}

// A clone of the public repository keeps that repository as origin, so a plain push after a save sent the person's
// memories to the upstream engine, and a public fork as origin would publish them (2026-11-02,
// tools/save-brain-push.test.mjs). In an install (package.json names infinite-context) the save pushes only to the backup
// remote the person names in brain.json ("backupRemote": a remote name or address), never to origin by default. A brain
// that is not an install pushes to origin as before.
function repoKey(u) {
  return String(u || '').trim().replace(/^git\+/i, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/\\]+@/, '').replace(/^([^/\\:]{2,}):(?!\d)/, '$1/').replace(/[\\/]+$/, '').replace(/\.git$/i, '').toLowerCase();
}
function pushTarget() {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(BRAIN, 'package.json'), 'utf8')); } catch { return { remote: 'origin' }; }
  if (!isPublicName(pkg.name)) return { remote: 'origin' };
  let backup = '';
  try { backup = String(JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).backupRemote || '').trim(); } catch { /* none */ }
  if (!backup) return { skip: 'no backup remote is named. To back the brain up, create a private repository of your own and set "backupRemote" to its address in brain.json' };
  let urls = [backup];
  try { urls = run('git', ['remote', 'get-url', '--push', '--all', backup], 30000).split(NL).map((s) => s.trim()).filter(Boolean); } catch { /* an address, not a remote name */ }
  const r = pkg.repository;
  const upstream = repoKey(typeof r === 'string' ? r : r && r.url);
  if (upstream && urls.some((u) => repoKey(u) === upstream)) return { skip: 'the backup remote is the public Neuraxis repository; name a private repository of your own in brain.json "backupRemote"' };
  return { remote: backup };
}

// Memory problems (a broken link, a near duplicate) no longer block a save (hooks/git/pre-commit, 2026-11-01); they
// are reported here instead, in the log every agent reads with --status after a save, naming what to fix.
function warnIfBrainHasFindings() {
  try {
    const out = run(process.execPath, [join(BRAIN, 'tools', 'reflect.mjs')], 120000);
    // Index drift is left out: after a save it is almost always another agent's memory written but not indexed yet,
    // which its own save is about to fix, and the line read as this agent's problem (audit 2026-11-01).
    const drift = Number((out.match(/^##\s*Index drift \((\d+)\)/m) || [])[1] || 0);
    const total = Number((out.match(/Total findings:\s*(\d+)/) || [])[1] || 0) - drift;
    if (total <= 0) return;
    const sections = out.split(NL).filter((l) => /^##\s/.test(l) && !/\(0\)\s*$/.test(l) && !/^##\s*Index drift/.test(l)).map((l) => l.replace(/^##\s*/, ''));
    const lines = out.split(NL).filter((l) => /->|<->/.test(l)).slice(0, 3).map((l) => l.trim());
    log('WARN after "' + message + '": brain has ' + total + ' finding(s), fix them (node tools/reflect.mjs): ' + sections.join('; ') + (lines.length ? ' | ' + lines.join(' | ') : ''));
  } catch (e) { log('WARN after "' + message + '": could not run reflect.mjs: ' + String(e.message).slice(0, 120)); }
}
