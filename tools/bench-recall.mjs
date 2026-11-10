#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { hostname } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const runsFlag = argv.indexOf('--runs');
const RUNS = runsFlag > -1 ? Number(argv[runsFlag + 1]) : 3;
import { existsSync as __ex, readFileSync as __rf } from 'node:fs';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn, resolve as __rs, join as __jn } from 'node:path';
const __BRAIN = __rs(__dn(__fu(import.meta.url)), '..');
const GENERIC_PROMPTS = [
    'is it fixed yet', 'can you reach the memory', 'what did we decide about this',
    'save that for later', 'should you ask me first', 'how does recall work here',
];
const PROMPTS = __ex(__jn(__BRAIN, 'bench-prompts.json'))
    ? JSON.parse(__rf(__jn(__BRAIN, 'bench-prompts.json'), 'utf8'))
    : GENERIC_PROMPTS;
const HOOK = join(BRAIN, 'hooks', 'pre-turn.mjs');
if (!existsSync(HOOK)) {
    process.stderr.write('no hooks/pre-turn.mjs at ' + HOOK + '\n');
    process.exit(1);
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const hasIndex = existsSync(join(BRAIN, 'index', 'keywords.json'));
const hasEmbeddings = existsSync(join(BRAIN, 'index', 'embeddings.json'));
let memCount = 0;
try {
    memCount = readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8').length ? -1 : 0;
}
catch { }
const times = [];
let hits = 0;
let empty = 0;
let mode = 'unknown';
let fetchCmds = 0;
for (let r = 0; r < RUNS; r += 1) {
    for (const p of PROMPTS) {
        const t0 = Date.now();
        const res = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ prompt: p }),
            encoding: 'utf8', timeout: 30000, cwd: BRAIN, windowsHide: true,
        });
        times.push(Date.now() - t0);
        const out = (res.stdout || '') + (res.stderr || '');
        const m = out.match(/BRAIN RECALL: (\d+) memories/);
        if (m) {
            hits += Number(m[1]);
        }
        else {
            empty += 1;
        }
        if (out.includes('brain-client.mjs read'))
            fetchCmds += 1;
        if (/semantic recall (is OFF|missed)/.test(out))
            mode = 'keyword only (degraded)';
        else if (mode === 'unknown')
            mode = 'fused';
    }
}
const sorted = times.slice().sort((a, b) => a - b);
const total = times.length;
const line = (k, v) => process.stdout.write(k.padEnd(26) + v + '\n');
process.stdout.write('\nBRAIN LATENCY, ' + (process.env.HAVOK_MACHINE_NAME || hostname()) + '\n');
process.stdout.write('brain: ' + BRAIN + '\n\n');
line('prompts timed', total + '  (' + PROMPTS.length + ' prompts x ' + RUNS + ' runs)');
line('median', pct(sorted, 50) + 'ms');
line('p95', pct(sorted, 95) + 'ms');
line('min / max', sorted[0] + 'ms / ' + sorted[sorted.length - 1] + 'ms');
process.stdout.write('\n');
line('local keyword index', hasIndex ? 'present' : 'ABSENT, recall comes from the server');
line('local embeddings', hasEmbeddings ? 'present' : 'ABSENT');
line('recall mode', mode);
line('avg memories per prompt', (hits / total).toFixed(1));
line('prompts with no recall', empty + ' of ' + total);
line('fetch-command lines', fetchCmds + '  (nonzero means this machine lacks local memory files)');
process.stdout.write('\nAccuracy is a separate command: node tools/eval-recall.mjs\n');
