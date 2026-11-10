export const SECRET_PATTERNS = [
    { name: 'Google OAuth client secret', re: /GOCSPX-[A-Za-z0-9_-]{8,}/ },
    { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9]{20,}/ },
    { name: 'Stripe-style key', re: /sk_(live|test)_[A-Za-z0-9]{10,}/ },
    { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
    { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
    { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'bearer token', re: /[Bb]earer\s+[A-Za-z0-9._-]{24,}/ },
    { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'age identity', re: /AGE-SECRET-KEY-1[0-9A-Z]{40,}/ },
    { name: 'Tailscale auth key', re: /tskey-[a-z]+-[A-Za-z0-9_-]{8,}/ },
];
const TOKEN_RUN = /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+/=-])/g;
export function entropy(s) {
    const n = new Map();
    for (const c of s)
        n.set(c, (n.get(c) || 0) + 1);
    let h = 0;
    for (const k of n.values()) {
        const p = k / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}
export function randomTokens(text) {
    return (String(text || '').match(TOKEN_RUN) || []).filter((t) => /[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && entropy(t) >= 4.5);
}
export const isShell = (tool) => tool === 'Bash' || tool === 'PowerShell';
const COMMIT_AT = /\bgit\b[^|;&]*\bcommit\b/;
export const isCommitAttempt = (cmd) => COMMIT_AT.test(String(cmd || ''));
const SEP = /&&|\|\||;|\r?\n/;
const MOVE = /^(?:cd|chdir|pushd|sl|set-location|push-location)(?:\s+-(?:path|literalpath))?\s+(.+)$/i;
const BLIND = /^(?:cd|chdir|popd|pop-location)\s*$/i;
const unquote = (s) => {
    const t = String(s).trim();
    const q = /^"([^"]*)"$|^'([^']*)'$/.exec(t);
    return q ? (q[1] ?? q[2]) : /\s/.test(t) ? '' : t;
};
const readable = (p) => !!p && p !== '-' && !/[$%`~*?]/.test(p);
const into = (dir, p) => {
    let x = p.replace(/\\/g, '/');
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(x);
    if (msys)
        x = msys[1].toUpperCase() + ':' + (msys[2] || '/');
    x = x.replace(/(.)\/+$/, '$1');
    return /^([a-zA-Z]:)?\//.test(x) ? x : dir.replace(/[\\/]+$/, '') + '/' + x;
};
export function commitDir(cmd, base) {
    const s = String(cmd || '');
    const b = String(base || '');
    const m = COMMIT_AT.exec(s);
    if (!m)
        return b;
    let dir = b;
    for (const raw of s.slice(0, m.index).split(SEP)) {
        const part = raw.trim().replace(/^[({]\s*/, '');
        if (BLIND.test(part))
            return b;
        const mv = MOVE.exec(part);
        if (mv) {
            const p = unquote(mv[1]);
            if (!readable(p))
                return b;
            dir = into(dir, p);
        }
        if (raw.includes(')') || raw.includes('}'))
            dir = b;
    }
    for (const c of m[0].matchAll(/\s-C\s+("[^"]*"|'[^']*'|\S+)/g)) {
        const p = unquote(c[1]);
        if (!readable(p))
            return b;
        dir = into(dir, p);
    }
    return dir;
}
export function addedLines(diff) {
    return String(diff || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}
export function secretsIn(diff, known = []) {
    const added = addedLines(diff);
    const hits = SECRET_PATTERNS.filter((p) => p.re.test(added)).map((p) => p.name);
    if (randomTokens(added).length)
        hits.push('random token (32 bytes, base64url)');
    if (known.some((k) => k && k.length >= 16 && added.includes(k)))
        hits.push('a token of this machine');
    return hits;
}
const COMMIT_SEG = /\bgit\b[^|;&]*\bcommit\b[^|;&]*/g;
export function skipsVerify(cmd) {
    const plain = String(cmd || '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    for (const seg of plain.match(COMMIT_SEG) || []) {
        const after = seg.slice(seg.search(/\bcommit\b/) + 'commit'.length);
        if (/(^|\s)--no-verify\b/.test(after) || /(^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(after))
            return true;
    }
    return false;
}
export const tokenFiles = (home) => ['havok-server-token', 'havok-tokens.json', 'havok-mail-token'].map((f) => String(home || '').replace(/[\\/]+$/, '') + '/.claude/' + f);
export function tokensFrom(path, text) {
    const t = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!t)
        return [];
    if (/\.json$/i.test(path)) {
        try {
            return Object.keys(JSON.parse(t)).filter((k) => k.length >= 16);
        }
        catch {
            return [];
        }
    }
    return t.length >= 16 && !/\s/.test(t) ? [t] : [];
}
export const NO_VERIFY_REASON = 'Blocked: this commit skips the git hooks (--no-verify or -n), which hold the secret scan and the commit checks. Run it without that flag.';
export function secretDenyReason(hits) {
    return 'Blocked: the staged diff appears to contain a secret (' + hits.join(', ') + '). Do not commit credentials. Remove the secret, move it to an env var or .gitignored file, restage, and retry.';
}
export const SCAN_UNFINISHED = 'Blocked: the secret scan of the staged diff did not finish in time, so this commit was not checked and did not run. Run the same commit again; if it keeps happening, check git diff --cached yourself for a secret first.';
