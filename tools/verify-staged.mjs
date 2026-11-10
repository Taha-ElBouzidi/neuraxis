// Verifies what a commit will hold, not what the disk holds (M2, system review 2026-11-09).
//
// HAVOK and HAVOK - Dev (and helpers) share one brain working tree. verify.mjs checks the files on disk, so a commit
// passed when it depended on another agent's unstaged file, and was refused for another agent's half-edited one. This
// exports the staged tree (git checkout-index of the index) into a temporary folder, links node_modules, runs
// verify.mjs there, and answers with its exit code and output. The temporary folder is removed afterwards.
//
//   node tools/verify-staged.mjs [--quiet]      run from the brain checkout (or with cwd inside it)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const dir = mkdtempSync(join(tmpdir(), 'brain-staged-'));
let code = 1;
try {
  // The index as it will be committed, every path, with the working tree's own line endings.
  execFileSync('git', ['checkout-index', '-a', '-f', '--prefix=' + dir.replace(/\\/g, '/') + '/'], { cwd: BRAIN, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const mods = join(BRAIN, 'node_modules');
  if (existsSync(mods)) symlinkSync(mods, join(dir, 'node_modules'), 'junction');
  // The generated index is rebuilt from the staged memories first, as the pre-commit hook does before the commit, so a
  // commit that stages a memory without its index is judged on what it will hold.
  spawnSync(process.execPath, [join(dir, 'tools', 'build-index.mjs')], { cwd: dir, stdio: 'ignore', windowsHide: true, timeout: 150_000, env: { ...process.env, HAVOK_STAGED_VERIFY: '1' } });
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'verify.mjs'), ...(quiet ? ['--quiet'] : [])], {
    cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 170_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HAVOK_LAYERS_DIR: process.env.HAVOK_LAYERS_DIR || resolve(BRAIN, '..', 'LAYERS'), HAVOK_STAGED_VERIFY: '1' },
  });
  // Paths in the report name the brain, not the temporary copy.
  const fix = (s) => String(s || '').split(dir).join(BRAIN).split(dir.replace(/\\/g, '/')).join(BRAIN.replace(/\\/g, '/'));
  process.stdout.write(fix(r.stdout));
  process.stderr.write(fix(r.stderr));
  code = r.status === null ? 124 : r.status;
} catch (e) {
  process.stderr.write('the staged tree could not be exported: ' + String(e && e.message).slice(0, 200) + '\n');
  code = 2;
} finally {
  // The junction is removed on its own first (rmdir removes a junction, never what it points at). If that fails, the
  // temporary folder is left as it is: a recursive removal must never reach the brain's node_modules through it.
  let linkGone = !existsSync(join(dir, 'node_modules'));
  try { if (!linkGone) { rmdirSync(join(dir, 'node_modules')); linkGone = true; } } catch { /* left in place */ }
  if (linkGone) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp folder */ } }
}
process.exit(code);
