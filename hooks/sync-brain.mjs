import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { appendFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
function git(args, opts = {}) {
    return execSync('git ' + args, { cwd: BRAIN, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function log(line) {
    try {
        appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n');
    }
    catch { }
}
let committed = false;
let pulled = false;
let pushed = false;
let note = '';
const GRACE_MS = 4 * 60 * 1000;
function recentlyTouched() {
    let files = [];
    try {
        files = git('status --porcelain').split('\n').map((l) => l.slice(3).trim())
            .filter(Boolean).map((f) => f.replace(/^"|"$/g, ''));
    }
    catch {
        return false;
    }
    const now = Date.now();
    for (const f of files) {
        try {
            if (now - statSync(join(BRAIN, f)).mtimeMs < GRACE_MS)
                return true;
        }
        catch { }
    }
    return false;
}
try {
    const status = git('status --porcelain');
    if (status.trim() && recentlyTouched()) {
        note += 'grace-wait(active-edits) ';
    }
    else if (status.trim()) {
        try {
            execSync('node "' + join(BRAIN, 'tools', 'stamp-updated.mjs') + '"', { cwd: BRAIN, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
            execSync('node "' + join(BRAIN, 'tools', 'build-index.mjs') + '"', { cwd: BRAIN, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (e) {
            note += 'reindex-failed ';
        }
        let healthy = true;
        try {
            execSync('node "' + join(BRAIN, 'tools', 'verify.mjs') + '" --quiet', { cwd: BRAIN, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (e) {
            healthy = false;
        }
        if (healthy) {
            git('add -A');
        }
        else {
            git('add -- memory/ MANIFEST.md');
            git('add -- index/');
            try {
                git('reset -q -- index/rules.json');
            }
            catch { }
            const held = git('status --porcelain').split('\n')
                .filter((l) => l.trim() && !/^[AMDR ]{2} (memory|index)\//.test(l));
            note += 'VERIFY-FAILED-held-non-memory(' + held.length + ')+held-rules.json ';
        }
        const staged = git('diff --cached --name-only').trim();
        if (staged) {
            const ts = new Date().toISOString();
            execFileSync('git', [...AUTHOR, 'commit', '-q', '-m', 'sync: auto memory sync ' + ts], { cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            committed = true;
        }
    }
}
catch (e) {
    note += 'commit-failed ';
}
try {
    git('pull --no-rebase --quiet', { timeout: 45000 });
    pulled = true;
}
catch (e) {
    note += 'pull-failed(maybe-conflict) ';
    try {
        git('merge --abort');
        note += 'merge-aborted ';
    }
    catch { }
}
if (pulled) {
    try {
        git('push --quiet', { timeout: 45000 });
        pushed = true;
    }
    catch (e) {
        note += 'push-failed ';
    }
}
try {
    const plugin = resolve(homedir(), '.claude', 'plugins', 'marketplaces', 'havok-brain');
    if (existsSync(join(plugin, '.git'))) {
        const inPlugin = (args, timeout = 45000) => execSync('git ' + args, { cwd: plugin, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            inPlugin('checkout -- memory/MEMORY.md index/ MANIFEST.md', 15000);
        }
        catch { }
        const before = inPlugin('rev-parse HEAD', 10000).trim();
        inPlugin('pull --no-rebase --quiet');
        const after = inPlugin('rev-parse HEAD', 10000).trim();
        note += before === after ? 'plugin-current ' : 'plugin-updated ';
    }
}
catch (e) {
    note += 'plugin-pull-failed ';
}
log('committed=' + committed + ' pulled=' + pulled + ' pushed=' + pushed + (note ? ' ' + note.trim() : ' ok'));
process.exit(0);
