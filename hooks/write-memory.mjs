import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.sync.log');
function gitAuthorFlags() {
    try {
        const g = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).git || {};
        if (g.email)
            return ['-c', 'user.email=' + g.email, '-c', 'user.name=' + (g.name || 'brain')];
    }
    catch { }
    return [];
}
const AUTHOR = gitAuthorFlags();
const msg = process.argv.slice(2).join(' ').trim() || 'memory: update';
function git(args, opts = {}) {
    return execSync('git ' + args, { cwd: BRAIN, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function log(line) { try {
    appendFileSync(LOG, new Date().toISOString() + ' write-memory ' + line + '\n');
}
catch { } }
function out(obj) { console.log(JSON.stringify(obj)); }
try {
    git('checkout master --quiet');
}
catch { }
try {
    git('add memory');
}
catch {
    log('add failed');
    out({ ok: false, error: 'git add memory failed' });
    process.exit(1);
}
const staged = git('diff --cached --name-only').trim();
if (!staged) {
    log('nothing to write');
    out({ ok: true, written: 0, note: 'no memory changes staged' });
    process.exit(0);
}
const offending = staged.split('\n').filter((p) => p && !p.startsWith('memory/'));
if (offending.length) {
    try {
        git('reset --quiet');
    }
    catch { }
    log('refused non-memory paths: ' + offending.join(','));
    out({ ok: false, error: 'write-memory only writes under memory/. For these use propose-to-brain (PR): ' + offending.join(', ') });
    process.exit(2);
}
try {
    execFileSync('git', [...AUTHOR, 'commit', '-q', '-m', msg], { cwd: BRAIN, stdio: ['ignore', 'pipe', 'pipe'] });
}
catch {
    log('commit failed');
    out({ ok: false, error: 'commit failed' });
    process.exit(1);
}
let pushed = false;
for (let i = 0; i < 4 && !pushed; i++) {
    try {
        git('pull --rebase --quiet origin master', { timeout: 45000 });
    }
    catch {
        try {
            git('rebase --abort');
        }
        catch { }
        log('rebase conflict aborted (attempt ' + i + ')');
    }
    try {
        git('push --quiet origin master', { timeout: 45000 });
        pushed = true;
    }
    catch {
        log('push rejected, retry ' + i);
    }
}
log(pushed ? 'ok: ' + staged.replace(/\n/g, ',') : 'FAILED after retries');
out({ ok: pushed, written: staged.split('\n').length, files: staged.split('\n') });
process.exit(pushed ? 0 : 1);
