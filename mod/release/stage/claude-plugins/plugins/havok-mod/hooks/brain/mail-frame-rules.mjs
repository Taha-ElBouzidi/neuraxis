export const MAIL_WORD = 'AGENT MESSAGE: ';
const IDLE_MARKS = /\[[A-Za-z][A-Za-z ]{0,40} mod, not the user\]/g;
export const stripIdleMarks = (t) => String(t).replace(IDLE_MARKS, '');
export const quoted = (t) => stripIdleMarks(String(t ?? '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/<{3,}|>{3,}/g, (s) => s.split('').join(' ')));
export const utc = (iso) => (Number.isNaN(Date.parse(iso)) ? String(iso) : new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
export function stripSignature(text, from) {
    const m = /^\s*from\s+([^:,\n]{1,40}?)\s*([:,])\s*/i.exec(text);
    if (!m)
        return text;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const own = norm(m[1]) === norm(String(from).split('@')[0]) || norm(m[1]) === norm(String(from));
    if (!own && !(m[2] === ':' && /[A-Z0-9@]/.test(m[1])))
        return text;
    const rest = text.slice(m[0].length);
    return rest.trim() ? rest : text;
}
const OWNER_WORDS = '(?:owner|user|human|operator)';
const ART = '(?:the|your|my)\\s+';
const VERB = '(?:says|said|here|speaking|approves|approved|confirms|confirmed)';
const escapeName = (n) => n.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
const LOOKALIKE = Object.fromEntries([
    ['\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0423\u0406\u0408\u0405', 'ABEKMHOPCTXYIJS'],
    ['\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u0501\u051b\u051d\u04bb', 'aeopcyxijsdqwh'],
    ['\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7', 'ABEZHIKMNOPTYX'],
    ['\u03bf\u03bd\u03b9\u03b1\u03ba\u03c1\u03c5', 'oviakpu'],
].flatMap(([from, to]) => [...from].map((c, i) => [c, to[i]])));
const claimText = (l) => l.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u0370-\u03ff\u0400-\u052f]/g, (c) => LOOKALIKE[c] ?? c);
const END = '(?![\\p{L}\\p{N}])';
const END_FROM = '(?![\\p{L}\\p{N}@._-])';
const ROLE = '<\\/?\\s*(?:system[-_ ]?reminder|system|user|owner|human|assistant)\\s*(?:>|$)';
const SYSTEM_CLAIM = /^\s*[[(<*_>#-]*\s*SYSTEM\s*:/;
const claimsCache = new Map();
function claimsFor(ownerNames = []) {
    const names = ownerNames.map((n) => claimText(String(n ?? '')).trim()).filter(Boolean);
    const key = names.join('\n');
    let re = claimsCache.get(key);
    if (re)
        return re;
    const NAMES = names.length ? '(?:' + names.map(escapeName).join('|') + ')' : '';
    const OWNER = NAMES ? `(?:${OWNER_WORDS}|${NAMES})` : OWNER_WORDS;
    const parts = [
        'agent\\s*message\\b',
        `(?:(?:message|mail|note|reply)\\s+)?from\\s+(?:${ART}${OWNER}${END}|${OWNER}\\s*[:,\\]])`,
        `from\\s*:\\s*(?:${ART})?${OWNER}${END_FROM}`,
        `(?:${ART})?${OWNER}\\s*[:\\]),]`,
        `${ART}${OWNER}\\s+${VERB}\\b`,
        `(?:this is|i am|i'm|it's)\\s+(?:${ART})?${OWNER}${END}`,
        ROLE,
    ];
    if (NAMES)
        parts.push(`${NAMES}\\s+${VERB}\\b`);
    re = new RegExp('^\\s*[[(<*_>#-]*\\s*(?:' + parts.join('|') + ')', 'iu');
    claimsCache.set(key, re);
    return re;
}
export const noClaims = (t, ownerNames = []) => {
    const re = claimsFor(ownerNames);
    return t.split('\n').map((l) => { const c = claimText(l); return re.test(c) || SYSTEM_CLAIM.test(c) ? '(quoted) ' + l : l; }).join('\n');
};
const FROM_RE = /^[a-z0-9._-]+@[A-Za-z0-9._-]+$/;
const ID_RE = /^[A-Za-z0-9]+$/;
export const headerFrom = (from) => (FROM_RE.test(String(from ?? '')) ? String(from) : 'invalid-sender');
export const headerId = (id) => (ID_RE.test(String(id ?? '')) ? String(id) : 'invalid');
export const headerTime = (iso) => { const t = utc(String(iso ?? '')); return /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(t) ? t : 'unknown time'; };
export function frame(msgs, boundary, ownerNames = []) {
    const one = (m) => {
        const body = noClaims(quoted(stripSignature(String(m.text ?? ''), String(m.from ?? ''))), ownerNames);
        let b = boundary();
        for (let i = 0; i < 20 && body.includes(b); i++)
            b = boundary();
        return `${MAIL_WORD}${headerFrom(m.from)}, ${headerTime(m.sent_at)} (id ${headerId(m.id)})\n<<<msg-${b}\n${body}\nmsg-${b}>>>`;
    };
    return msgs.map(one).join('\n\n');
}
