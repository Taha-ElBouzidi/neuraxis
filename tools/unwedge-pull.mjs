#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const DIR = resolve(opt('dir', resolve(dirname(fileURLToPath(import.meta.url)), '..')));
const REMOTE = opt('remote', 'origin');
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const say = (s) => process.stdout.write(s + NL);
function git(args, opts = {}) {
    return execFileSync('git', ['-C', DIR, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}
function gitOk(args) { try {
    git(args);
    return true;
}
catch {
    return false;
} }
const norm = (t) => String(t).split(CR + NL).join(NL);
try {
    if (!existsSync(join(DIR, '.git'))) {
        say('unwedge: no .git at ' + DIR + ', nothing to do');
        process.exit(0);
    }
    if (!gitOk(['fetch', '--quiet', REMOTE])) {
        say('unwedge: fetch failed, leaving the tree alone');
        process.exit(0);
    }
    let ref = '';
    try {
        ref = git(['symbolic-ref', '-q', '--short', 'refs/remotes/' + REMOTE + '/HEAD']).trim();
    }
    catch { }
    if (!ref) {
        try {
            ref = git(['rev-parse', '--abbrev-ref', '@{upstream}']).trim();
        }
        catch { }
    }
    if (!ref) {
        const b = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        ref = REMOTE + '/' + b;
    }
    if (!gitOk(['merge-base', 'HEAD', ref])) {
        say('unwedge: HEAD and ' + ref + ' share no history, a pull cannot merge them, leaving the tree alone');
        process.exit(0);
    }
    const incoming = git(['diff', '--name-only', 'HEAD..' + ref]).split(NL).map((s) => s.trim()).filter(Boolean);
    if (!incoming.length) {
        say('unwedge: nothing incoming from ' + ref);
        process.exit(0);
    }
    const stamp = new Date().toISOString().split(':').join('-').split('.').join('-');
    const trash = join(DIR, '.sync-trash', stamp);
    let moved = 0;
    let restored = 0;
    const kept = [];
    for (const rel of incoming) {
        const abs = join(DIR, rel);
        if (!existsSync(abs))
            continue;
        const tracked = gitOk(['ls-files', '--error-unmatch', '--', rel]);
        if (!tracked) {
            const dest = join(trash, rel);
            mkdirSync(dirname(dest), { recursive: true });
            renameSync(abs, dest);
            moved += 1;
            continue;
        }
        const modified = !gitOk(['diff', '--quiet', '--', rel]);
        if (!modified)
            continue;
        let remote = null;
        try {
            remote = git(['show', ref + ':' + rel]);
        }
        catch {
            remote = null;
        }
        let local = null;
        try {
            local = readFileSync(abs, 'utf8');
        }
        catch {
            local = null;
        }
        if (remote !== null && local !== null && norm(remote) === norm(local)) {
            if (gitOk(['checkout', '--', rel]))
                restored += 1;
            else
                kept.push(rel);
        }
        else {
            kept.push(rel);
        }
    }
    say('unwedge: ' + incoming.length + ' incoming path(s), moved ' + moved + ' untracked to .sync-trash, restored ' + restored + ' identical, kept ' + kept.length + ' that differ');
    for (const k of kept)
        say('  kept, differs from the remote, pull may stop on it: ' + k);
}
catch (e) {
    say('unwedge: ' + String(e.message).split(NL)[0].slice(0, 160));
}
process.exit(0);
