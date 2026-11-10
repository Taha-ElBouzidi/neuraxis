// The secret scan of a git commit, in one place: check-secrets.mjs (the command hook) and the mod import
// this file. Pure: no Node imports. Only added lines of the staged diff are scanned (not the +++ file header).
//
// A scan that does not finish never lets the commit through (the owner 2026-11-02: hooks "go past the time we allow
// them and no issue"; a timed-out safety hook let the action run). Its callers refuse with SCAN_UNFINISHED.

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
  // M4 (system review 2026-11-09): this system's own secret shapes.
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'age identity', re: /AGE-SECRET-KEY-1[0-9A-Z]{40,}/ },
  { name: 'Tailscale auth key', re: /tskey-[a-z]+-[A-Za-z0-9_-]{8,}/ },
];

// A random token of 32 bytes as base64url (the brain and mailbox tokens, brain-server.mjs) has no prefix to match: a
// run of exactly 43 base64url characters with both cases, a digit and high entropy counts. Git hashes (hex) and
// ordinary words do not reach 4.5 bits a character.
// A run inside standard base64 (a + / or = beside it, as in package-lock integrity hashes) is not one.
const TOKEN_RUN = /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+/=-])/g;
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
export function randomTokens(text) {
  return (String(text || '').match(TOKEN_RUN) || []).filter((t) => /[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && entropy(t) >= 4.5);
}

// Bash and PowerShell both run git (the PowerShell tool was never scanned before 2026-11-02).
export const isShell = (tool) => tool === 'Bash' || tool === 'PowerShell';
const COMMIT_AT = /\bgit\b[^|;&]*\bcommit\b/;
export const isCommitAttempt = (cmd) => COMMIT_AT.test(String(cmd || ''));

// The folder the commit runs in. A command often moves first (`cd <repo> && git commit`, PowerShell's Set-Location,
// `git -C <repo> commit`); checking the session's folder then scans the wrong repository. A move this cannot follow
// ($VAR, ~, cd -, popd) keeps `base`, the session's folder, as before.
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
  if (msys) x = msys[1].toUpperCase() + ':' + (msys[2] || '/');
  x = x.replace(/(.)\/+$/, '$1');
  return /^([a-zA-Z]:)?\//.test(x) ? x : dir.replace(/[\\/]+$/, '') + '/' + x;
};
export function commitDir(cmd, base) {
  const s = String(cmd || '');
  const b = String(base || '');
  const m = COMMIT_AT.exec(s);
  if (!m) return b;
  let dir = b;
  for (const raw of s.slice(0, m.index).split(SEP)) {
    const part = raw.trim().replace(/^[({]\s*/, '');
    if (BLIND.test(part)) return b;
    const mv = MOVE.exec(part);
    if (mv) {
      const p = unquote(mv[1]);
      if (!readable(p)) return b;
      dir = into(dir, p);
    }
    if (raw.includes(')') || raw.includes('}')) dir = b;
  }
  for (const c of m[0].matchAll(/\s-C\s+("[^"]*"|'[^']*'|\S+)/g)) {
    const p = unquote(c[1]);
    if (!readable(p)) return b;
    dir = into(dir, p);
  }
  return dir;
}

export function addedLines(diff) {
  return String(diff || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}

// known: exact secret values the caller read from this machine's token files; one of them in an added line is a hit
// whatever its shape (the leak guard's way).
export function secretsIn(diff, known = []) {
  const added = addedLines(diff);
  const hits = SECRET_PATTERNS.filter((p) => p.re.test(added)).map((p) => p.name);
  if (randomTokens(added).length) hits.push('random token (32 bytes, base64url)');
  if (known.some((k) => k && k.length >= 16 && added.includes(k))) hits.push('a token of this machine');
  return hits;
}

// M4: a commit that skips git's own hooks (--no-verify, or -n in a short-flag cluster) is refused: the git hooks are
// the scan's backstop. Quoted text (a commit message) is not read as flags.
const COMMIT_SEG = /\bgit\b[^|;&]*\bcommit\b[^|;&]*/g;
export function skipsVerify(cmd) {
  const plain = String(cmd || '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  for (const seg of plain.match(COMMIT_SEG) || []) {
    const after = seg.slice(seg.search(/\bcommit\b/) + 'commit'.length);
    if (/(^|\s)--no-verify\b/.test(after) || /(^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(after)) return true;
  }
  return false;
}
// The files on a machine that hold its own tokens, read by each caller (this file stays pure): the brain server's
// token, the machine tokens it accepts (their keys), and a messages-only token.
export const tokenFiles = (home) => ['havok-server-token', 'havok-tokens.json', 'havok-mail-token'].map((f) => String(home || '').replace(/[\\/]+$/, '') + '/.claude/' + f);
export function tokensFrom(path, text) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!t) return [];
  if (/\.json$/i.test(path)) { try { return Object.keys(JSON.parse(t)).filter((k) => k.length >= 16); } catch { return []; } }
  return t.length >= 16 && !/\s/.test(t) ? [t] : [];
}
export const NO_VERIFY_REASON = 'Blocked: this commit skips the git hooks (--no-verify or -n), which hold the secret scan and the commit checks. Run it without that flag.';

export function secretDenyReason(hits) {
  return 'Blocked: the staged diff appears to contain a secret (' + hits.join(', ') + '). Do not commit credentials. Remove the secret, move it to an env var or .gitignored file, restage, and retry.';
}

export const SCAN_UNFINISHED = 'Blocked: the secret scan of the staged diff did not finish in time, so this commit was not checked and did not run. Run the same commit again; if it keeps happening, check git diff --cached yourself for a secret first.';
