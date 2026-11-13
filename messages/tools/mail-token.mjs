import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeAuth, sha256 } from '../lib/auth.mjs';
const DATA_DIR = process.env.MAIL_DATA_DIR || join(homedir(), '.claude', 'havok-mail');
const BRAIN_HOME = process.env.MAIL_BRAIN_HOME || process.env.HAVOK_HOME || join(homedir(), '.claude');
const auth = makeAuth({ brainHome: BRAIN_HOME, dataDir: DATA_DIR });
const FILE = auth.mailTokensFile;
const [cmd, name] = process.argv.slice(2);
const flag = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const load = () => { try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
}
catch {
    return {};
} };
function lockDown(path) {
    if (process.platform !== 'win32')
        return;
    try {
        execFileSync('icacls', [path, '/inheritance:r', '/grant:r', process.env.USERNAME + ':(R,W)', '/grant:r', 'SYSTEM:(F)'], { stdio: 'ignore' });
    }
    catch { }
}
function save(db) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
    lockDown(FILE);
}
if (cmd === 'issue') {
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        console.log('usage: node tools/mail-token.mjs issue <MACHINE> --out <file>');
        process.exit(1);
    }
    const out = flag('--out');
    if (!out) {
        console.log('--out is required. The value is never printed.');
        process.exit(1);
    }
    if (auth.brainTokens().some((t) => t.name === name)) {
        console.log(`${name} already has a brain token; it uses that one. Refusing a second identity.`);
        process.exit(1);
    }
    const db = load();
    if (Object.values(db).some((m) => m.name === name)) {
        console.log(`${name} already has a mailbox token; revoke it first.`);
        process.exit(1);
    }
    if (existsSync(out)) {
        console.log(`${out} exists; refusing to overwrite it.`);
        process.exit(1);
    }
    const value = randomBytes(32).toString('base64url');
    db[sha256(value)] = { name, issued: new Date().toISOString().slice(0, 10) };
    save(db);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, value, 'utf8');
    lockDown(out);
    console.log(`issued a mailbox token for ${name}; value written to ${out}. Move that file to the machine, then delete it here.`);
}
else if (cmd === 'list') {
    for (const m of Object.values(load()))
        console.log(`${m.name.padEnd(16)} mailbox  issued ${m.issued}`);
    for (const t of auth.brainTokens())
        console.log(`${t.name.padEnd(16)} brain    (the brain token, accepted as is)`);
}
else if (cmd === 'revoke') {
    const db = load();
    const before = Object.keys(db).length;
    for (const [h, m] of Object.entries(db))
        if (m.name === name)
            delete db[h];
    save(db);
    console.log(before === Object.keys(db).length ? `no mailbox token named ${name}` : `revoked ${name}; refused from the next request on`);
}
else {
    console.log('node tools/mail-token.mjs issue <MACHINE> --out <file> | list | revoke <MACHINE>');
    process.exit(cmd ? 1 : 0);
}
