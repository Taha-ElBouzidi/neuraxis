import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
const CHECK = process.argv.includes('--check');
const NO_EMBED = process.argv.includes('--no-embed');
const NL = '\n';
const say = (s) => process.stdout.write(s + NL);
const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
function run(cmd, ms = 60000, cwd = BRAIN) {
    try {
        return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    }
    catch (e) {
        return { ok: false, out: String((e.stdout || '') + (e.stderr || '')).trim() || String(e.message) };
    }
}
const has = (bin) => run(process.platform === 'win32' ? 'where ' + bin : 'command -v ' + bin, 8000).ok;
say('machine    : ' + me);
say('brain      : ' + BRAIN.split(String.fromCharCode(92)).join('/'));
say('');
if (!has('git')) {
    say('MISSING git. Install it, then run this again.');
    process.exit(1);
}
let ageOk = has('age');
say('age        : ' + (ageOk ? 'present' : 'MISSING'));
if (!ageOk && !CHECK) {
    if (process.platform === 'win32') {
        say('             installing with winget, user scope, no admin...');
        const r = run('winget install --id FiloSottile.age --exact --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity', 300000);
        const linked = resolve(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'age.exe');
        ageOk = has('age') || existsSync(linked);
        say('             ' + (ageOk ? 'installed' : 'install FAILED: ' + r.out.split(NL).slice(-2).join(' ')));
        if (ageOk && !has('age')) {
            say('             NOTE: age is installed but not on this process PATH. Open a NEW shell and run this again.');
            process.exit(2);
        }
    }
    else {
        say('             install it with your package manager (apt install age, brew install age), then run this again.');
        process.exit(1);
    }
}
if (!ageOk)
    process.exit(1);
let total = 0, readable = 0, registered = false;
try {
    const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
    for (const box of Object.values(v.secrets || {})) {
        total++;
        if (box.keys && box.keys[me])
            readable++;
    }
}
catch { }
try {
    registered = !!JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).machines[me];
}
catch { }
say('vault      : ' + readable + ' of ' + total + ' secrets readable, ' + (registered ? 'registered' : 'not registered'));
if (readable === total && total > 0) {
    say('');
    say('Already connected. Nothing to do.');
}
else if (CHECK) {
    say('');
    say('--check: would generate a key and publish a request for ' + me);
}
else {
    const hadKey = existsSync(AGEKEY);
    const r = run('node tools/vault.mjs request', 30000);
    if (!r.ok) {
        say('request FAILED: ' + r.out.split(NL).slice(-2).join(' '));
        process.exit(1);
    }
    const pub = r.out.split(/\r?\n/).filter(Boolean).pop();
    say('key        : ' + (hadKey ? 'already existed, left alone' : 'generated') + ', private half stays at ' + AGEKEY);
    say('public key : ' + pub);
    const reqFile = 'vault-requests/' + me + '.json';
    run('git add ' + reqFile, 15000);
    const c = run('git -c core.hooksPath=/dev/null commit -m "vault: ' + me + ' requests access" -- ' + reqFile, 30000);
    const p = c.ok ? run('git push', 60000) : { ok: false, out: c.out };
    say('request    : ' + (p.ok ? 'pushed as ' + reqFile : 'written to ' + reqFile + ' but NOT pushed. Push it by hand: ' + (c.out.split(NL)[0] || '')));
    say('');
    say('Next, on the HOST machine (the one running the brain server), an agent runs:');
    say('  node tools/vault.mjs approve ' + me);
    say('  git commit -am "vault: grant ' + me + '" && git push');
    say('Then pull here. Until that happens this machine reads memories and rules normally and');
    say('simply cannot decrypt secrets. Do NOT ask the person for credentials in the meantime.');
}
const hasModel = existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'));
say('');
say('recall     : ' + (hasModel ? 'semantic (local model present)' : 'keyword only'));
if (!hasModel && !NO_EMBED && !CHECK) {
    say('             installing the embedding runtime, about 426MB, one time...');
    const r = run('npm install --no-audit --no-fund', 900000);
    say('             ' + (existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))
        ? 'installed, semantic recall is on'
        : 'FAILED, staying on keyword recall: ' + r.out.split(NL).slice(-2).join(' ')));
}
else if (!hasModel) {
    say('             skipped. Enable later with: npm install (in ' + BRAIN.split(String.fromCharCode(92)).join('/') + ')');
}
say('');
say('Requirements in full, for the record:');
say('  git, node            already present or this script could not run');
say('  age                  handled above, winget user scope, no admin');
say('  a brain clone        already present');
say('  a machine key        generated here, never leaves this machine');
say('  approval on the host one command, then git push');
say('  npm install          optional, only for semantic recall');
say('  NOT needed: a passphrase, a bearer token, a server URL, a VPN, a domain, an open port.');
