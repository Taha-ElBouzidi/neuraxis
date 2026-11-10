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
    execFileSync('git', ['checkout-index', '-a', '-f', '--prefix=' + dir.replace(/\\/g, '/') + '/'], { cwd: BRAIN, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const mods = join(BRAIN, 'node_modules');
    if (existsSync(mods))
        symlinkSync(mods, join(dir, 'node_modules'), 'junction');
    spawnSync(process.execPath, [join(dir, 'tools', 'build-index.mjs')], { cwd: dir, stdio: 'ignore', windowsHide: true, timeout: 150000, env: { ...process.env, HAVOK_STAGED_VERIFY: '1' } });
    const r = spawnSync(process.execPath, [join(dir, 'tools', 'verify.mjs'), ...(quiet ? ['--quiet'] : [])], {
        cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 170000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HAVOK_LAYERS_DIR: process.env.HAVOK_LAYERS_DIR || resolve(BRAIN, '..', 'LAYERS'), HAVOK_STAGED_VERIFY: '1' },
    });
    const fix = (s) => String(s || '').split(dir).join(BRAIN).split(dir.replace(/\\/g, '/')).join(BRAIN.replace(/\\/g, '/'));
    process.stdout.write(fix(r.stdout));
    process.stderr.write(fix(r.stderr));
    code = r.status === null ? 124 : r.status;
}
catch (e) {
    process.stderr.write('the staged tree could not be exported: ' + String(e && e.message).slice(0, 200) + '\n');
    code = 2;
}
finally {
    let linkGone = !existsSync(join(dir, 'node_modules'));
    try {
        if (!linkGone) {
            rmdirSync(join(dir, 'node_modules'));
            linkGone = true;
        }
    }
    catch { }
    if (linkGone) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
        catch { }
    }
}
process.exit(code);
