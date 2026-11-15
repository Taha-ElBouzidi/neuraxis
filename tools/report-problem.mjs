#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname, userInfo, platform, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
export const REPORT_FILE = join(homedir(), '.neuraxis', 'problem-report.md');
const MAX_ERROR_LINES = 40;
const MAX_URL = 7500;
const readJson = (p) => { try {
    return JSON.parse(readFileSync(p, 'utf8'));
}
catch {
    return null;
} };
export function scrub(text, { home = homedir(), user = safeUser(), host = hostname(), brain = BRAIN } = {}) {
    let t = String(text || '');
    const variants = (p) => [...new Set([p, p.split(String.fromCharCode(92)).join('/'), p.split('/').join(String.fromCharCode(92))])].filter((x) => x && x.length > 2);
    for (const b of brain ? variants(brain).sort((a, c) => c.length - a.length) : [])
        t = t.split(b).join('<install>');
    for (const h of variants(home).sort((a, b) => b.length - a.length))
        t = t.split(h).join('<home>');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    if (host && host.length > 1)
        t = t.replace(new RegExp('\\b' + esc(host) + '\\b', 'gi'), '<machine>');
    if (user && user.length > 1)
        t = t.replace(new RegExp('\\b' + esc(user) + '\\b', 'gi'), '<user>');
    t = t.replace(/\b(sk|pk|ghp|gho|github_pat|xox[abp]|AKIA)[A-Za-z0-9_-]{8,}/g, '<secret>');
    t = t.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<secret>');
    t = t.replace(/(Bearer|token|password|passwd|secret)(\s*[:=]\s*|\s+)\S+/gi, '$1$2<secret>');
    t = t.replace(/\b(user|contact|project|feedback|reference)_[a-z0-9_]{3,}(\.md)?\b/g, '<memory>');
    return t;
}
function safeUser() { try {
    return userInfo().username;
}
catch {
    return '';
} }
export function versionInfo(brain = BRAIN) {
    const pkg = readJson(join(brain, 'package.json')) || {};
    const oss = readJson(join(brain, 'oss', 'package.json')) || {};
    const ver = /^\d+\.\d+\.\d+$/.test(pkg.version || '') && pkg.name !== 'havok-brain' && pkg.version !== '1.0.0' ? pkg.version : (oss.version || pkg.version || 'unknown');
    const cfg = readJson(join(brain, 'brain.json')) || {};
    const track = process.env.NEURAXIS_UPDATE_TRACK || cfg.updateTrack || 'release';
    const repo = String(cfg.problemReportRepo || ((pkg.repository && pkg.repository.url) || (oss.repository && oss.repository.url) || '').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') || 'Taha-ElBouzidi/neuraxis');
    return { version: ver, track, repo };
}
export function buildReport({ what, command, errorText, info, env = {} }) {
    const lines = String(errorText || '').split(/\r?\n/).filter((l) => l.trim());
    const tail = lines.slice(-MAX_ERROR_LINES);
    const body = [
        '**What went wrong:** ' + scrub(what || '(not given)', env),
        '',
        '**Version:** ' + info.version + ' (update track ' + info.track + ')',
        '**System:** ' + platform() + ' ' + release() + ' ' + arch() + ', Node ' + process.versions.node,
        ...(command ? ['**Command:** `' + scrub(command, env) + '`'] : []),
        '',
        ...(tail.length ? ['**Last error lines' + (lines.length > tail.length ? ' (the last ' + tail.length + ' of ' + lines.length + ')' : '') + ':**', '', '```', ...tail.map((l) => scrub(l, env)), '```'] : ['(no error output given)']),
        '',
        '_Prepared by tools/report-problem.mjs. Names, paths, addresses and keys are replaced; no memory content is included._',
    ].join(NL);
    const title = 'Problem: ' + scrub(String(what || 'something failed'), env).replace(/\s+/g, ' ').slice(0, 90);
    return { title, body };
}
export function issueUrl({ repo, title, body, version }) {
    const base = 'https://github.com/' + repo + '/issues/new?template=problem-report.md&labels=' + encodeURIComponent('problem-report,v' + version) + '&title=' + encodeURIComponent(title) + '&body=';
    let b = body;
    while (base.length + encodeURIComponent(b).length > MAX_URL && b.length > 200)
        b = b.slice(0, Math.floor(b.length * 0.9));
    if (b !== body)
        b += NL + NL + '(cut to fit the address; the full report is in ~/.neuraxis/problem-report.md)';
    return base + encodeURIComponent(b);
}
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === 'prepare') {
        const what = arg('what');
        if (!what.trim()) {
            process.stderr.write('prepare needs --what "<what went wrong>"' + NL);
            process.exit(2);
        }
        let errorText = '';
        if (arg('error-file')) {
            try {
                errorText = readFileSync(arg('error-file'), 'utf8');
            }
            catch (e) {
                process.stderr.write('cannot read ' + arg('error-file') + ': ' + e.message + NL);
                process.exit(1);
            }
        }
        const info = versionInfo();
        const r = buildReport({ what, command: arg('command'), errorText, info });
        mkdirSync(dirname(REPORT_FILE), { recursive: true });
        writeFileSync(REPORT_FILE, JSON.stringify({ repo: info.repo, version: info.version, title: r.title }) + NL + r.body + NL);
        process.stdout.write('Title: ' + r.title + NL + NL + r.body + NL + NL
            + 'Show the person ALL of the above. Nothing has been sent. If they agree it may go to the maintainer, run: node tools/report-problem.mjs send' + NL);
    }
    else if (cmd === 'show' || cmd === 'send') {
        if (!existsSync(REPORT_FILE)) {
            process.stderr.write('no prepared report: run prepare first' + NL);
            process.exit(1);
        }
        const raw = readFileSync(REPORT_FILE, 'utf8');
        const head = JSON.parse(raw.split(/\r?\n/)[0]);
        const body = raw.split(/\r?\n/).slice(1).join(NL).trim();
        if (cmd === 'show') {
            process.stdout.write('Title: ' + head.title + NL + NL + body + NL);
            process.exit(0);
        }
        const url = issueUrl({ repo: head.repo, title: head.title, body, version: head.version });
        const opener = platform() === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '""', url.replace(/&/g, '^&')]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        let opened = false;
        try {
            const c = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true });
            c.on('error', () => { });
            c.unref();
            opened = true;
        }
        catch {
            opened = false;
        }
        process.stdout.write((opened ? 'Opened the filled-in issue page in the browser. The person checks it and presses Submit; nothing is sent until then.' : 'No browser could be opened.')
            + NL + 'The address, if it did not open: ' + url + NL);
    }
    else {
        process.stderr.write('usage: node tools/report-problem.mjs prepare --what "<...>" [--command "<...>"] [--error-file <file>] | show | send' + NL);
        process.exit(2);
    }
}
