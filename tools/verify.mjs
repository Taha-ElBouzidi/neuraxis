import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { versionGuard } from './version-guard.mjs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const failures = [];
const passes = [];
const ok = (m) => { passes.push(m); if (!QUIET)
    console.log('  ok    ' + m); };
const bad = (m) => { failures.push(m); console.error('  FAIL  ' + m); };
const detail = (e) => {
    const text = [e && e.stderr, e && e.stdout]
        .map((b) => (b == null ? '' : b.toString()))
        .join('\n')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean);
    if (!text.length) {
        console.error('          (child produced no output; ' + ((e && e.message) || 'no message') + ')');
        return;
    }
    text.slice(0, 12).forEach((l) => console.error('          ' + l));
    if (text.length > 12)
        console.error(`          ... ${text.length - 12} more line(s)`);
};
for (const dir of ['hooks', 'tools']) {
    const d = join(BRAIN, dir);
    if (!existsSync(d))
        continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.mjs'))) {
        try {
            execFileSync(process.execPath, ['--check', join(d, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
            ok(`parse ${dir}/${f}`);
        }
        catch (e) {
            bad(`parse ${dir}/${f} -> ${String(e.stderr || e.message).split('\n')[0]}`);
        }
    }
}
for (const f of ['REFLEX.md', 'memory/MEMORY.md', 'CLAUDE.md', 'METHODOLOGIES.md']) {
    existsSync(join(BRAIN, f)) ? ok(`present ${f}`) : bad(`MISSING ${f}`);
}
try {
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs'), '--check'], { cwd: BRAIN, stdio: ['ignore', 'pipe', 'pipe'] });
    ok('index in sync with memory/');
}
catch (e) {
    bad('index drift, run: node tools/build-index.mjs');
    detail(e);
}
try {
    const out = execSync(`"${process.execPath}" "${join(BRAIN, 'tools', 'reflect.mjs')}"`, { cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/Total findings:\s*(\d+)/);
    const n = m ? Number(m[1]) : -1;
    if (n === 0)
        ok('reflection clean (0 findings)');
    else if (n > 0) {
        bad(`reflection has ${n} finding(s), run: node tools/reflect.mjs`);
        out.split('\n')
            .filter((l) => /^##\s/.test(l) && !/\(0\)\s*$/.test(l))
            .forEach((l) => console.log('          ' + l.replace(/^##\s*/, '')));
    }
    else
        bad('reflection did not report a total');
}
catch (e) {
    bad('reflect.mjs failed to run');
    detail(e);
}
const MIN_DESC = 40;
try {
    const memDir = join(BRAIN, 'memory');
    const weak = [];
    for (const f of readdirSync(memDir).filter((x) => x.endsWith('.md') && x !== 'MEMORY.md')) {
        const raw = readFileSync(join(memDir, f), 'utf8').replace(/\r\n/g, '\n');
        const end = raw.indexOf('\n---', 3);
        const fm = raw.startsWith('---') && end > 0 ? raw.slice(3, end) : '';
        const m = fm.match(/^description:\s*(.+)$/m);
        const desc = m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : '';
        if (!desc)
            weak.push(`${f} (no description)`);
        else if (desc.length < MIN_DESC)
            weak.push(`${f} (${desc.length} chars, too vague to recall)`);
    }
    if (weak.length)
        bad(`${weak.length} memory description(s) too weak to be recalled: ${weak.slice(0, 5).join(', ')}${weak.length > 5 ? ' ...' : ''}`);
    else
        ok(`all memory descriptions are usable for recall (min ${MIN_DESC} chars)`);
}
catch (e) {
    bad('description audit failed: ' + e.message);
}
const REQUIRED_EVENTS = ['SessionStart'];
try {
    const hj = JSON.parse(readFileSync(join(BRAIN, 'hooks', 'hooks.json'), 'utf8'));
    const events = hj.hooks || {};
    const missing = REQUIRED_EVENTS.filter((e) => !Array.isArray(events[e]) || !events[e].length);
    if (missing.length)
        bad(`hooks.json does not register: ${missing.join(', ')} (the plugin will silently not run them)`);
    else
        ok(`hooks.json registers ${REQUIRED_EVENTS.join(', ')}`);
    const dead = [];
    for (const groups of Object.values(events)) {
        for (const g of groups || []) {
            for (const h of g.hooks || []) {
                const m = String(h.command || '').match(/hooks\/([\w.-]+\.mjs)/);
                if (m && !existsSync(join(BRAIN, 'hooks', m[1])))
                    dead.push(m[1]);
            }
        }
    }
    if (dead.length)
        bad(`hooks.json points at missing file(s): ${[...new Set(dead)].join(', ')}`);
    else
        ok('every hook referenced by hooks.json exists');
}
catch (e) {
    bad('hooks/hooks.json is missing or not valid JSON: ' + e.message);
}
if (existsSync(join(BRAIN, 'hooks', 'dispatch.mjs'))) {
    try {
        const { JOBS } = await import(pathToFileURL(join(BRAIN, 'hooks', 'dispatch.mjs')).href);
        const missing = [...new Set(Object.values(JOBS).flat().map((j) => j.file))].filter((f) => !existsSync(join(BRAIN, 'hooks', f)));
        if (missing.length)
            bad('hooks/dispatch.mjs runs missing backup hook(s): ' + missing.join(', '));
        else
            ok('every backup hook hooks/dispatch.mjs runs exists');
    }
    catch (e) {
        bad('hooks/dispatch.mjs could not be loaded: ' + String(e.message).split(String.fromCharCode(10))[0]);
    }
}
try {
    const rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
    const hasNewline = (t) => [10, 13].some((c) => t.includes(String.fromCharCode(c)));
    const malformed = rules.filter((r) => !r.rule || r.rule.length < 20 || r.rule.includes('\\"') || hasNewline(r.rule)
        || !/[.!?]$/.test(r.rule.trim()));
    let REQUIRED_RULES = [
        'feedback_verify_before_claiming',
        'feedback_say_when_the_brain_is_down',
        'feedback_open_the_memory_not_the_description',
        'feedback_write_it_the_moment_you_learn_it',
        'feedback_reversible_act_irreversible_ask',
    ];
    try {
        const cfg = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8'));
        if (Array.isArray(cfg.requiredRules) && cfg.requiredRules.length)
            REQUIRED_RULES = cfg.requiredRules;
    }
    catch { }
    const have = new Set(rules.map((r) => r.slug));
    const missing = REQUIRED_RULES.filter((r) => !have.has(r));
    const orders = rules.map((r) => r.order);
    const dupOrder = orders.length !== new Set(orders).size;
    if (!rules.length)
        bad('index/rules.json has no rules: every agent runs with no behaviour rules');
    else if (malformed.length)
        bad('index/rules.json malformed (newline or escaping): ' + malformed.map((m) => m.slug).join(', '));
    else if (missing.length)
        bad('required always-on rule(s) lost their `rule:` line: ' + missing.join(', '));
    else if (dupOrder)
        bad('duplicate rule_order, injection order is nondeterministic: ' + orders.join(','));
    else
        ok('index/rules.json carries ' + rules.length + ' always-on rules, all required ones present');
}
catch (e) {
    bad('index/rules.json missing or unreadable, so the per-turn injection has no rules: ' + e.message);
}
function probePrompt() {
    try {
        const rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
        const idx = JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
        const first = rules.slice().sort((x, y) => x.order - y.order)[0];
        const desc = first && idx && idx.descriptions && idx.descriptions[first.slug];
        if (desc)
            return String(desc).split(/s+/).slice(0, 9).join(' ');
    }
    catch { }
    return 'how do i log creatine';
}
try {
    const hook = join(BRAIN, 'hooks', 'pre-turn.mjs');
    if (!existsSync(hook)) {
        bad('hooks/pre-turn.mjs is MISSING: every agent runs with no behaviour rules and no recall');
    }
    else {
        const r = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ prompt: probePrompt() }),
            encoding: 'utf8', timeout: 20000,
            env: { ...process.env, HAVOK_BRAIN: BRAIN },
        });
        let ctx = '';
        try {
            ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '';
        }
        catch { }
        const MUST_CONTAIN = { recall: 'BRAIN RECALL' };
        try {
            const rr = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
            for (const r of rr) {
                if (r.when)
                    continue;
                const t = String(r.rule || '').trim();
                if (t.length > 30)
                    MUST_CONTAIN[r.slug] = t.slice(-30);
            }
        }
        catch { }
        const absent = Object.entries(MUST_CONTAIN).filter(([, phrase]) => !ctx.includes(phrase)).map(([k]) => k);
        if (!ctx.trim())
            bad('pre-turn.mjs produced NO output: agents get no rules and no recall, silently');
        else if (absent.length)
            bad('pre-turn.mjs output is missing rule content: ' + absent.join(', '));
        else
            ok('pre-turn.mjs end to end: all rule content and recall present in the injection');
    }
}
catch (e) {
    bad('could not run hooks/pre-turn.mjs end to end: ' + e.message);
}
try {
    const vaultPath = join(BRAIN, 'vault.json');
    if (existsSync(vaultPath)) {
        const vj = JSON.parse(readFileSync(vaultPath, 'utf8'));
        const entries = Object.entries(vj.secrets || {});
        const broken = entries.filter(([, e]) => {
            if (!e.ct || !e.iv || !e.tag)
                return true;
            const v2 = e.keys && typeof e.keys === 'object' && Object.keys(e.keys).length > 0;
            const v1 = !!e.salt;
            return !v2 && !v1;
        });
        if (broken.length)
            bad('vault.json has entries missing crypto fields: ' + broken.map((b) => b[0]).join(', '));
        else {
            const v2n = entries.filter(([, e]) => e.keys).length;
            ok('vault.json: ' + entries.length + ' secrets, every one encrypted (' + v2n + ' per-machine, ' + (entries.length - v2n) + ' legacy passphrase)');
        }
        const leaked = entries.filter(([, e]) => JSON.stringify(e.keys || {}).includes('AGE-SECRET-KEY'));
        if (leaked.length)
            bad('PRIVATE AGE KEY INSIDE vault.json: ' + leaked.map((b) => b[0]).join(', '));
    }
}
catch (e) {
    bad('vault.json is unreadable or not valid JSON: ' + e.message);
}
try {
    const sp = join(BRAIN, 'server-endpoint.json');
    if (existsSync(sp)) {
        const raw = readFileSync(sp, 'utf8');
        const shapes = [
            /Bearer\s+[A-Za-z0-9_\-.]{16,}/,
            /AGE-SECRET-KEY-[A-Z0-9]+/,
            /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
            /\beyJ[A-Za-z0-9_-]{20,}\./,
            /"[A-Za-z0-9_\-]{40,}"/,
        ];
        const hit = shapes.find((re) => re.test(raw));
        if (hit)
            bad('server-endpoint.json contains something credential-shaped (' + hit + '). It is committed: it must hold an address and nothing else.');
        else
            ok('server-endpoint.json: address only, no credential');
    }
}
catch (e) {
    bad('server-endpoint.json is unreadable or not valid JSON: ' + e.message);
}
try {
    const rp = join(BRAIN, 'vault-recipients.json');
    if (existsSync(rp)) {
        const raw = readFileSync(rp, 'utf8');
        if (raw.includes('AGE-SECRET-KEY'))
            bad('PRIVATE AGE KEY IN vault-recipients.json. Remove it and rotate every credential.');
        const machines = Object.entries(JSON.parse(raw).machines || {});
        const wrong = machines.filter(([, m]) => !/^age1[0-9a-z]{50,}$/.test(m.pubkey || ''));
        if (wrong.length)
            bad('vault-recipients.json has entries that are not age public keys: ' + wrong.map((m) => m[0]).join(', '));
        else
            ok('vault-recipients.json: ' + machines.length + ' machine(s), all public keys');
    }
}
catch (e) {
    bad('vault-recipients.json is unreadable or not valid JSON: ' + e.message);
}
for (const f of ['havok-vault-key', '.vault-key', 'vault.key', 'havok-age-key.txt', 'key.txt']) {
    if (existsSync(join(BRAIN, f))) {
        bad('PRIVATE KEY FILE IN THE REPO: ' + f + '. Delete it and rotate every credential it could unlock.');
    }
}
ok('no vault private key file inside the repo');
try {
    const gitq = (args) => execFileSync('git', ['-C', BRAIN, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const staged = gitq(['diff', '--cached', '--name-only']).split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
    const hookChange = staged.filter((f) => f.startsWith('hooks/') && (f.endsWith('.mjs') || f.endsWith('.json')));
    const versionAt = (rev) => { try {
        return JSON.parse(gitq(['show', rev + ':.claude-plugin/plugin.json'])).version;
    }
    catch {
        return '';
    } };
    const now = JSON.parse(readFileSync(join(BRAIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    let branch = '', baseRev = '';
    try {
        branch = gitq(['rev-parse', '--abbrev-ref', 'HEAD']);
    }
    catch {
        branch = '';
    }
    try {
        baseRev = gitq(['merge-base', 'HEAD', 'origin/master']);
    }
    catch {
        baseRev = '';
    }
    const r = versionGuard({ hookChange, branch, now, head: versionAt('HEAD'), base: baseRev ? versionAt(baseRev) : '', master: versionAt('origin/master') });
    if (r.ok)
        ok(r.message);
    else
        bad(r.message);
}
catch {
    ok('plugin version guard skipped: not a git checkout');
}
if (!QUIET || failures.length) {
    console.log(`\n${failures.length ? 'BRAIN VERIFY FAILED' : 'BRAIN VERIFY PASSED'}: ${passes.length} passed, ${failures.length} failed`);
}
process.exit(failures.length ? 1 : 0);
