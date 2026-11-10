#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.pull-refresh.log');
const VERBOSE = process.argv.includes('--verbose');
const stamp = () => new Date().toISOString();
function log(line) {
    const l = `${stamp()}\t${line}`;
    if (VERBOSE)
        console.log(l);
    try {
        appendFileSync(LOG, l + '\n');
    }
    catch { }
}
function git(args, timeout = 60000) {
    return execFileSync('git', ['-C', BRAIN, ...args], {
        encoding: 'utf8', timeout, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
try {
    if (!existsSync(join(BRAIN, '.git'))) {
        log('SKIP no .git');
        process.exit(0);
    }
    const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean);
    if (dirty.length) {
        log(`SKIP dirty tree, ${dirty.length} changed file(s)`);
        process.exit(0);
    }
    const before = git(['rev-parse', 'HEAD']);
    try {
        git(['fetch', '--quiet', 'origin'], 90000);
    }
    catch (e) {
        log(`SKIP fetch failed: ${String(e.message).split('\n')[0].slice(0, 120)}`);
        process.exit(0);
    }
    const remote = git(['rev-parse', 'origin/master']);
    if (remote === before) {
        log('ok already current');
        process.exit(0);
    }
    const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...origin/master`])
        .split(/\s+/).map(Number);
    if (ahead > 0 && behind > 0) {
        log(`SKIP diverged, ${ahead} local / ${behind} remote. Needs a human.`);
        process.exit(0);
    }
    if (ahead > 0) {
        log(`SKIP ${ahead} unpushed local commit(s), nothing to pull`);
        process.exit(0);
    }
    try {
        git(['merge', '--ff-only', 'origin/master'], 60000);
    }
    catch (e) {
        log(`SKIP ff-only refused: ${String(e.message).split('\n')[0].slice(0, 120)}`);
        process.exit(0);
    }
    const after = git(['rev-parse', 'HEAD']);
    if (after === before) {
        log('ok no movement');
        process.exit(0);
    }
    const changed = git(['diff', '--name-only', `${before}..${after}`]).split('\n').filter(Boolean);
    const memoryTouched = changed.some((f) => f.startsWith('memory/'));
    const n = git(['rev-list', '--count', `${before}..${after}`]);
    if (!memoryTouched) {
        log(`ok pulled ${n} commit(s) ${before.slice(0, 7)}..${after.slice(0, 7)}, no memory change, index untouched`);
        process.exit(0);
    }
    try {
        execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], {
            cwd: BRAIN, timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (e) {
        log(`WARN pulled ${n} but reindex FAILED: ${String(e.message).split('\n')[0].slice(0, 120)}`);
        process.exit(0);
    }
    const memFiles = changed.filter((f) => f.startsWith('memory/')).length;
    log(`ok pulled ${n} commit(s) ${before.slice(0, 7)}..${after.slice(0, 7)}, ${memFiles} memory file(s), reindexed`);
}
catch (e) {
    log(`ERROR ${String(e.message).split('\n')[0].slice(0, 160)}`);
}
process.exit(0);
