#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrainLockSync } from './brain-git-lock.mjs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.sync.log');
const log = (line) => { try {
    appendFileSync(LOG, new Date().toISOString() + ' commit-paths ' + line + '\n');
}
catch { } };
const git = (args, timeout = 120000) => spawnSync('git', ['-C', BRAIN, ...args], { encoding: 'utf8', timeout, windowsHide: true });
export function commitPathsInBackground(message, paths) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), message, ...paths], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
}
export function commitPaths(message, paths) {
    return withBrainLockSync('commit-paths: ' + message, () => {
        const changed = git(['status', '--porcelain', '--', ...paths]).stdout.trim();
        if (!changed)
            return 'nothing to commit';
        const add = git(['add', '--', ...paths]);
        if (add.status !== 0)
            return 'add failed: ' + String(add.stderr).trim().slice(0, 200);
        const c = git(['commit', '-q', '-m', message, '--', ...paths], 240000);
        if (c.status !== 0)
            return 'commit failed: ' + String(c.stderr || c.stdout).trim().slice(0, 200);
        const p = git(['push', '-q', 'origin', 'HEAD']);
        if (p.status !== 0) {
            const from = /\bgitea\b/.test(git(['remote']).stdout) ? ['gitea', 'master'] : [];
            const pull = git(['pull', '-q', '--no-rebase', '--no-edit', ...from], 180000);
            const p2 = pull.status === 0 ? git(['push', '-q', 'origin', 'HEAD']) : pull;
            if (p2.status !== 0)
                return 'committed, push failed: ' + String(p2.stderr).trim().slice(0, 200);
        }
        return 'committed and pushed';
    });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const background = args[0] === '--background';
    if (background)
        args.shift();
    const [message, ...paths] = args;
    if (!message || paths.length === 0) {
        console.error('usage: node tools/commit-paths.mjs [--background] "<message>" <path> ...');
        process.exit(2);
    }
    if (background) {
        commitPathsInBackground(message, paths);
        process.exit(0);
    }
    let result;
    try {
        result = commitPaths(message, paths);
    }
    catch (e) {
        result = 'failed: ' + String((e && e.message) || e).slice(0, 200);
    }
    log(paths.join(',') + ': ' + result);
    console.log(result);
    process.exit(/failed/.test(result) ? 1 : 0);
}
