export const LIMIT_BLOCK_RE = /limit at \d+%[^\n]*The rest is (?:kept|reserved) for|Blocked: [^\n]*limit at \d+ percent[^\n]*urgent to go ahead/;
export const blockedByLimit = (s) => !!s && LIMIT_BLOCK_RE.test(`${s.answer ?? ''}\n${s.stderr ?? ''}\n${s.log ?? ''}`);
export const NOT_SIGNED_IN_RE = /Not logged in|Please run \/login|Invalid API key|OAuth token has expired|authentication_error/i;
export const notSignedIn = (s) => !!s && NOT_SIGNED_IN_RE.test(`${s.answer ?? ''}
${s.stderr ?? ''}`);
export function verdict(pass, sessions = []) {
    if (pass)
        return 'PASS';
    return sessions.some(blockedByLimit) || sessions.some(notSignedIn) ? 'SKIP' : 'FAIL';
}
export function skipReason(sessions = []) {
    return sessions.some(blockedByLimit) ? 'blocked by limit' : 'not signed in to Claude';
}
