import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
function constEq(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    if (x.length !== y.length)
        return false;
    try {
        return timingSafeEqual(x, y);
    }
    catch {
        return false;
    }
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return {};
    }
}
export function sha256(s) {
    return createHash('sha256').update(s).digest('hex');
}
export function makeAuth({ brainHome, dataDir, homeMachine = '' }) {
    const serverTokenFile = join(brainHome, 'havok-server-token');
    const brainTokensFile = join(brainHome, 'havok-tokens.json');
    const mailTokensFile = join(dataDir, 'mail-tokens.json');
    function brainTokens() {
        const list = [];
        try {
            list.push({ value: readFileSync(serverTokenFile, 'utf8').trim(), name: String(homeMachine || process.env.COMPUTERNAME || 'LOCAL').toUpperCase(), kind: 'brain' });
        }
        catch { }
        for (const [value, meta] of Object.entries(readJson(brainTokensFile))) {
            list.push({ value, name: String(meta?.name || 'unnamed'), kind: 'brain' });
        }
        return list;
    }
    function whoIs(header) {
        const given = String(header || '').replace(/^Bearer\s+/i, '').trim();
        if (!given)
            return null;
        let found = null;
        const brain = brainTokens();
        const brainNames = new Set(brain.map((t) => t.name));
        for (const t of brain)
            if (t.value && constEq(given, t.value))
                found = { machine: t.name, kind: 'brain' };
        const hash = sha256(given);
        for (const [h, meta] of Object.entries(readJson(mailTokensFile))) {
            const name = String(meta?.name || '');
            if (!name || brainNames.has(name))
                continue;
            if (constEq(hash, h) && !found)
                found = { machine: name, kind: 'mail' };
        }
        return found;
    }
    return { whoIs, brainTokens, mailTokensFile };
}
