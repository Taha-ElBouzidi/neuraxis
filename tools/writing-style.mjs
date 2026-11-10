#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(BRAIN, 'brain.json');
const NL = String.fromCharCode(10);
const arg = (process.argv[2] || '').toLowerCase();
let cfg = {};
try {
    if (existsSync(FILE))
        cfg = JSON.parse(readFileSync(FILE, 'utf8'));
}
catch {
    process.stderr.write('brain.json does not parse; nothing changed' + NL);
    process.exit(1);
}
const now = cfg.writingStyle === 'plain' ? 'plain' : 'off';
if (!arg || arg === '--status') {
    process.stdout.write('writing style: ' + now + (now === 'plain' ? ' (no em dashes, emoji, arrows, checkmarks or slang)' : ' (no writing rules)') + NL);
    process.exit(0);
}
if (arg !== 'plain' && arg !== 'off') {
    process.stderr.write('usage: node tools/writing-style.mjs plain | off' + NL);
    process.exit(2);
}
if (arg === 'plain')
    cfg.writingStyle = 'plain';
else
    delete cfg.writingStyle;
writeFileSync(FILE, JSON.stringify(cfg, null, 2) + NL, 'utf8');
process.stdout.write('writing style: ' + arg + NL);
