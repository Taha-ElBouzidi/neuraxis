import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { withoutCredit, reserveChanged, reserveApproved, RESERVE_REFUSAL } from './commit-message-rules.mjs';
const file = process.argv[2];
let msg = '';
try {
    msg = readFileSync(file, 'utf8');
}
catch {
    process.exit(0);
}
const show = (spec) => { try {
    return execFileSync('git', ['show', spec], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
catch {
    return '';
} };
const git = (...a) => { try {
    return execFileSync('git', a, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
catch {
    return '';
} };
let mergeHeads = [];
try {
    mergeHeads = readFileSync(git('rev-parse', '--git-path', 'MERGE_HEAD'), 'utf8').split(/\s+/).filter(Boolean);
}
catch { }
const staged = show(':brain.json');
const changed = ['HEAD', ...mergeHeads].every((parent) => reserveChanged(show(parent + ':brain.json'), staged));
if (changed && !reserveApproved(msg)) {
    process.stderr.write(RESERVE_REFUSAL + '\n');
    process.exit(1);
}
writeFileSync(file, withoutCredit(msg) + '\n', 'utf8');
process.exit(0);
