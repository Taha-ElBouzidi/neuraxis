import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verdict, skipReason } from './verify-rules.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[process.argv.indexOf('--mode') + 1];
if (mode !== 'org' && mode !== 'plugin-dir') {
    console.error('usage: node verify.mjs --mode org|plugin-dir');
    process.exit(2);
}
const SCRATCH = process.env.HAVOK_MOD_VERIFY_DIR ?? (existsSync('D:/') ? 'D:/tmp/havok-mod-verify' : join(tmpdir(), 'havok-mod-verify').split(String.fromCharCode(92)).join('/'));
const CLAUDE = (() => {
    const native = join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe');
    if (existsSync(native))
        return native;
    try {
        const found = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return found.find((f) => /\.exe$/i.test(f)) ?? found.find((f) => /\.cmd$/i.test(f)) ?? native;
    }
    catch {
        return native;
    }
})();
const claudeRun = (args, opts) => {
    if (!/\.cmd$/i.test(CLAUDE))
        return execFileSync(CLAUDE, args, opts);
    const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
    return execFileSync('cmd.exe', ['/d', '/s', '/c', '"' + [CLAUDE, ...args].map(q).join(' ') + '"'], { ...opts, windowsVerbatimArguments: true });
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, 'inert'), { recursive: true });
mkdirSync(join(SCRATCH, 'active', '.claude'), { recursive: true });
writeFileSync(join(SCRATCH, 'machine.json'), '{}\n');
writeFileSync(join(SCRATCH, 'empty-mcp.json'), '{"mcpServers":{}}\n');
writeFileSync(join(SCRATCH, 'active', '.claude', 'havok-mod.verify-x.json'), JSON.stringify({ usage: { dir: `${SCRATCH}/usage` }, keepWarm: { enabled: false }, context: { layersDir: `${SCRATCH}/layers`, archiveDir: `${SCRATCH}/archive` } }) + '\n');
function session(name, cwd, extraEnv, userSettings = false, prompt = 'Reply with the single word ready.') {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
    Object.assign(env, { HAVOK_MOD_MACHINE_CONFIG: `${SCRATCH}/machine.json`, DISABLE_AUTOUPDATER: '1', HAVOK_MOD_ALLOW_CHILD: '1' }, extraEnv);
    if (!extraEnv.HAVOK_MOD_AGENT)
        delete env.HAVOK_MOD_AGENT;
    const debug = join(OUT, `verify-${mode}-${name}-${stamp}.log`);
    const args = ['-p', prompt, '--model', 'haiku', '--tools', 'Read', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', `${SCRATCH}/empty-mcp.json`, '--no-chrome', ...(userSettings ? [] : ['--setting-sources', 'project,local']), '--debug-file', debug];
    if (mode === 'plugin-dir')
        args.push('--plugin-dir', join(HERE, '..', 'mod'));
    let answer = '';
    let stderr = '';
    let exit = 0;
    try {
        answer = claudeRun(args, { cwd, env, encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (e) {
        exit = e.status ?? 1;
        answer = String(e.stdout ?? '');
        stderr = String(e.stderr ?? '');
    }
    const log = existsSync(debug) ? readFileSync(debug, 'utf8') : '';
    const own = log.split('\n').filter((l) => /\(havok-mod\)|\[havok-mod\]|mcp__havok-mod__/.test(l) && !/was skipped|bypassed by|\$\.fs\.(read|exists|stat) \(havok-mod\)|\$\.env\.get \(havok-mod\)/.test(l));
    return { exit, answer: answer.trim(), stderr, debug, log, own };
}
const results = [];
const ok = (name, pass, detail, ...sessions) => {
    const v = verdict(pass, sessions);
    results.push({ name, pass: v !== 'FAIL', skipped: v === 'SKIP', detail });
    console.log(`${v === 'SKIP' ? 'SKIP (' + skipReason(sessions) + ')' : v} ${name}${detail ? ': ' + detail : ''}`);
};
const loaded = (log) => (/hooks module havok-mod@\S+ loaded \(([^)]*)\)/.exec(log)?.[1] ?? '');
const inert = session('inert', join(SCRATCH, 'inert'), {});
ok('Claude Code starts and answers normally', inert.exit === 0 && /ready/i.test(inert.answer), `exit ${inert.exit}, answer "${inert.answer.slice(0, 40)}"`, inert);
ok('the mod is loaded', !!loaded(inert.log), loaded(inert.log) || 'no "hooks module havok-mod... loaded" line', inert);
if (mode === 'org') {
    ok('it runs in tier prepend (as the organization\'s)', /tier prepend/.test(loaded(inert.log)), loaded(inert.log), inert);
    ok('the guard is seated after it', /sec-default@builtin seated by managed prependPlugins at position 2/.test(inert.log), (/cc-plugin-sec-default@builtin [^\n]*seat[^\n]*/.exec(inert.log) ?? [''])[0], inert);
}
else {
    ok('it runs in tier user (development copy)', /tier user/.test(loaded(inert.log)), loaded(inert.log), inert);
}
const agentOnly = inert.own.filter((l) => /\$\.ui\.status \(havok-mod\)|mcp__havok-mod__(context_|send_message|list_agents|message_status)/.test(l) || (/\$\.fs\.(write|append|mkdir) \(havok-mod\)/.test(l) && !/havok-mod[\\/]alive|havok-sessions[\\/]|havok-brain-gate\.json|havok-mod[\\/]host-proof\.json|havok-limit-blocks\.jsonl/.test(l)));
ok('without HAVOK_MOD_AGENT and without a config it runs only the safety jobs (no status line, no context or mail tool, no agent file)', agentOnly.length === 0, agentOnly.slice(0, 3).join(' | '));
const active = session('active', join(SCRATCH, 'active'), { HAVOK_MOD_AGENT: 'verify-x' });
ok('with HAVOK_MOD_AGENT=verify-x and its file the session still answers', active.exit === 0 && /ready/i.test(active.answer), `exit ${active.exit}`, active);
const onLine = active.own.find((l) => /: agent verify-x on |havok verify-x/.test(l)) ?? '';
ok('the mod is on for verify-x', !!onLine, onLine.slice(0, 160), active);
const guardLine = active.own.find((l) => /guard (present|absent|unknown)/.test(l)) ?? '';
if (mode === 'org')
    ok('it finds no guard above it (clean-up and layers can run)', /guard absent/.test(guardLine), guardLine.slice(0, 200));
else
    ok(`it reports the guard (${/guard present/.test(guardLine) ? 'present: a Team login' : 'absent: a personal login'})`, /guard (present|absent)/.test(guardLine), guardLine.slice(0, 200));
ok('the usage row was written', existsSync(`${SCRATCH}/usage`), `${SCRATCH}/usage`, active);
const logs = [inert.debug, active.debug];
if (mode === 'org') {
    const home = process.env.USERPROFILE ?? '';
    const json = (f) => { try {
        return JSON.parse(readFileSync(f, 'utf8'));
    }
    catch {
        return null;
    } };
    const settings = json(join(home, '.claude', 'settings.json')) ?? {};
    const preTurn = /pre-turn\.mjs/.test(JSON.stringify(settings.hooks?.UserPromptSubmit ?? ''));
    const keepPreTurn = json(join(home, '.claude', 'havok-mod', 'machine.json'))?.keepPreTurn === true;
    const ours = json(join(HERE, 'stage', 'claude-plugins', 'plugins', 'havok-mod', 'org.json'))?.recallFromMod === true;
    ok('the old pre-turn hook is gone from settings.json (or kept on purpose for the 24 hour host proof)', !preTurn || keepPreTurn || !ours, preTurn ? (keepPreTurn ? 'kept: machine.json keepPreTurn' : !ours ? 'kept: this build keeps the hook as its recall, the mod steps aside' : 'a UserPromptSubmit entry still runs pre-turn.mjs') : 'absent');
    const since = Date.now();
    const host = session('host', join(SCRATCH, 'active'), { HAVOK_MOD_AGENT: 'verify-x' }, true, 'Which port does the brain server listen on? Answer in one word, from memory, without tools.');
    logs.push(host.debug);
    const events = (json(join(home, '.claude', 'havok-mod', 'host-proof.json'))?.events ?? []).filter((e) => Number(e.at) >= since);
    const got = (kind) => events.find((e) => e.kind === kind);
    const noHost = !got('layers') && !got('recall');
    if (noHost && preTurn) {
        console.log('SKIP the layers and recall from the brain host: no layer host reached in this run, and the pre-turn hook still gives recall');
    }
    else {
        ok('the global layer is shared from the brain host', got('layers')?.ok === true, noHost ? 'no layer host' : JSON.stringify(got('layers') ?? 'no layer fetch'), host);
        ok('the recall call for a recall question reached the brain host', got('recall')?.ok === true, noHost ? 'no layer host' : JSON.stringify(got('recall') ?? 'no recall call'), host);
        const ran = /Hooks: SessionStart:startup \[node "([^"]+dispatch\.mjs)" SessionStart\] \(plugin havok-brain@[^)]*\) finished with status 0/.exec(host.log);
        const sid = (/havok-mod[\\/]+(?:alive|layers-live)[\\/]+([0-9a-f-]{36})/.exec(host.log) ?? [])[1] ?? '';
        const brainPath = (() => { try {
            return readFileSync(join(home, '.claude', 'havok-brain-path'), 'utf8').split(/\r?\n/)[0].trim();
        }
        catch {
            return '';
        } })();
        const byMod = !ran && brainPath && existsSync(join(brainPath, 'hooks', 'check-session-start.mjs'));
        const startHook = ran ? ran[1].replace(/dispatch\.mjs$/, 'check-session-start.mjs') : byMod ? join(brainPath, 'hooks', 'check-session-start.mjs') : '';
        const pluginRoot = startHook.replace(/[\\/]hooks[\\/]check-session-start\.mjs$/, '');
        const brainOut = (s) => { try {
            return execFileSync('node', [startHook], { cwd: home, input: JSON.stringify({ session_id: s, hook_event_name: 'SessionStart', source: 'startup', cwd: home }), encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot } });
        }
        catch (e) {
            console.log(`INFO the brain's hook failed for ${s}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
            return '';
        } };
        const REFLEX = /===== BRAIN TIER 0: REFLEX/;
        if ((!ran && !byMod) || (!sid && !byMod)) {
            ok('the brain\'s session start leaves REFLEX out (the layers carry it)', false, (!ran && !byMod) ? 'the brain\'s SessionStart hook did not run with status 0 in this session, and the engine\'s check-session-start.mjs was not found through ~/.claude/havok-brain-path' : 'no session id for the host session in its log');
        }
        else {
            const markerDir = join(home, '.claude', 'havok-mod', 'layers-live');
            const fresh = 'verify-marker-' + Date.now();
            const settle = (f) => { for (let i = 0; i < 2; i++) {
                const o = f();
                if (o.trim())
                    return o;
                execFileSync('node', ['-e', 'setTimeout(()=>{},5000)'], { windowsHide: true });
            } return ''; };
            let withMarker = '';
            try {
                mkdirSync(markerDir, { recursive: true });
                writeFileSync(join(markerDir, fresh), '');
                withMarker = settle(() => brainOut(fresh));
            }
            finally {
                rmSync(join(markerDir, fresh), { force: true });
            }
            const control = settle(() => brainOut('verify-no-marker-' + Date.now()));
            ok('the brain\'s session start leaves REFLEX out (the layers carry it)', withMarker.trim().length > 0 && !REFLEX.test(withMarker) && REFLEX.test(control), !withMarker.trim() ? `the brain's hook gave no output for ${sid} (failed or empty), so nothing is proven` : REFLEX.test(withMarker) ? `REFLEX in the session start of ${sid}` : !REFLEX.test(control) ? 'control failed: no REFLEX even without the layers-live marker, so the check proves nothing' : `${withMarker.length} chars without REFLEX, control ${control.length} chars with it`);
        }
    }
    let sl = '';
    try {
        sl = (readFileSync(join(home, '.claude', 'statusline.mjs'), 'utf8').split(/\r?\n/)[0].match(/^\/\/ havok-statusline (\S+)/) ?? [])[1] ?? '';
    }
    catch { }
    console.log(`INFO status line ${sl ? sl : 'without a version line (older than 0.1.12)'}`);
}
if (process.argv.includes('--brain-hooks')) {
    const brain = session('brain-hooks', join(SCRATCH, 'inert'), {}, true);
    logs.push(brain.debug);
    ok('with the user settings, Claude Code still answers', brain.exit === 0 && /ready/i.test(brain.answer), `exit ${brain.exit}`, brain);
    const hookLine = brain.log.split('\n').find((l) => /Hooks: UserPromptSubmit \[[^\]]*pre-turn\.mjs[^\]]*\] finished with status 0/.test(l)) ?? '';
    ok('the brain\'s pre-turn command hook still runs', hookLine !== '', hookLine.slice(0, 200), brain);
    ok('and the mod stays inert there', brain.own.length === 0, brain.own.slice(0, 2).join(' | '));
}
{
    const root = join(homedir(), '.claude', 'projects');
    const files = [];
    try {
        for (const d of readdirSync(root, { withFileTypes: true })) {
            if (!d.isDirectory())
                continue;
            for (const f of readdirSync(join(root, d.name)))
                if (f.endsWith('.jsonl')) {
                    try {
                        files.push({ p: join(root, d.name, f), t: statSync(join(root, d.name, f)).mtimeMs });
                    }
                    catch { }
                }
        }
    }
    catch { }
    files.sort((a, b) => b.t - a.t);
    let found = null;
    for (const f of files.slice(0, 40)) {
        let text = '';
        try {
            text = readFileSync(f.p, 'utf8');
        }
        catch {
            continue;
        }
        const k = text.lastIndexOf('"subtype":"compact_boundary"');
        if (k < 0)
            continue;
        const lines = text.slice(text.lastIndexOf(String.fromCharCode(10), k) + 1).split(String.fromCharCode(10)).filter(Boolean).slice(0, 2);
        try {
            found = { file: f.p, rows: lines.map((l) => JSON.parse(l)) };
        }
        catch {
            continue;
        }
        break;
    }
    if (!found)
        ok('session file format: no compaction on this machine to read (not checked)', true, 'skipped');
    else {
        const [b, s] = found.rows;
        const bOk = b?.type === 'system' && b?.subtype === 'compact_boundary' && b?.parentUuid === null && typeof b?.uuid === 'string' && typeof b?.logicalParentUuid === 'string';
        const sOk = s?.type === 'user' && s?.parentUuid === b?.uuid;
        ok('session file format: a compaction is a boundary row with no parent, then the opening chained to it', bOk && sOk, `${found.file.split(String.fromCharCode(92)).join('/').split('/').slice(-2).join('/')}: boundary ${bOk ? 'as expected' : JSON.stringify({ type: b?.type, subtype: b?.subtype, parentUuid: b?.parentUuid, logical: typeof b?.logicalParentUuid })}, opening ${sOk ? 'as expected' : JSON.stringify({ type: s?.type, parent: s?.parentUuid === b?.uuid })}`);
    }
}
{
    const own = join(homedir(), '.claude', 'havok-mod');
    let names = [];
    try {
        names = readdirSync(join(own, 'status')).filter((f) => f.endsWith('.json'));
    }
    catch {
        names = [];
    }
    for (const f of names) {
        try {
            const s = JSON.parse(readFileSync(join(own, 'status', f), 'utf8'));
            if (!/^verify-/.test(String(s?.agent ?? '')))
                continue;
            rmSync(join(own, 'status', f), { force: true });
            rmSync(join(own, 'alive', f), { force: true });
        }
        catch { }
    }
}
const summary = { mode, at: new Date().toISOString(), results, logs };
writeFileSync(join(OUT, `verify-${mode}-${stamp}.json`), JSON.stringify(summary, null, 1));
const failed = results.filter((r) => !r.pass).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(failed ? `${failed} check(s) failed` : skipped ? `all checks passed or skipped (${skipped} blocked by the limit reserve)` : 'all checks passed');
process.exit(failed ? 1 : 0);
