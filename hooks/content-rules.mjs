export const writingRulesOn = (brainJson) => !!brainJson && brainJson.writingStyle === 'plain';
export function brainConfigNear(hookDir, readFile, home) {
    for (const f of [hookDir + '/../brain.json', (() => { try {
            return String(readFile(home + '/.claude/havok-brain-path', 'utf8')).split(/\r?\n/)[0].trim() + '/brain.json';
        }
        catch {
            return '';
        } })()]) {
        if (!f || f === '/brain.json')
            continue;
        try {
            return JSON.parse(readFile(f, 'utf8'));
        }
        catch { }
    }
    return null;
}
export const EM_DASH = new RegExp('\\u2014');
export const EMOJI_CORE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/u;
export const SYMBOLS_PROSE = /[\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}]/u;
const FR_START = '(?<![a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF])';
const FR_END = '(?![a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF])';
export const SLANG = [
    new RegExp('\\b' + 'nickel and ' + 'dimed' + '\\b', 'i'),
    new RegExp('\\b' + 'haggl' + '(?:e|es|ed|ing)\\b', 'i'),
    new RegExp('\\b' + 'knock ' + 'off' + '\\b', 'i'),
    new RegExp(FR_START + '(?:on\\s+se|se|on)\\s+' + 'cale' + '[rs]?' + FR_END, 'i'),
    new RegExp(FR_START + 'recal' + '(?:e|es|er|ons|ez|ent|\\u00E9|\\u00E9e)' + FR_END, 'i'),
    new RegExp(FR_START + 'cal' + '(?:\\u00E9|\\u00E9e|\\u00E9s|\\u00E9es)' + FR_END, 'i'),
];
export const OUTBOUND = /(send_message|send_mail|send_draft|create_draft|reply|post_message)/i;
export function contentOf(tool, input) {
    const ti = input || {};
    if (tool === 'Write')
        return { text: String(ti.content || ''), filePath: String(ti.file_path || '') };
    if (tool === 'Edit')
        return { text: String(ti.new_string || ''), filePath: String(ti.file_path || '') };
    if (tool === 'NotebookEdit')
        return { text: String(ti.new_source || ''), filePath: String(ti.notebook_path || '') };
    if (tool === 'Bash' || tool === 'PowerShell')
        return { text: String(ti.command || ''), filePath: '' };
    if (/^mcp__/.test(tool) && OUTBOUND.test(tool))
        return { text: Object.values(ti).filter((v) => typeof v === 'string').join('\n'), filePath: '' };
    return null;
}
export function contentProblems(tool, input) {
    const c = contentOf(tool, input);
    if (!c)
        return null;
    const { text, filePath } = c;
    const slangExempt = /feedback_no_slang_idioms\.md$/i.test(filePath)
        || /reference_js_regex_accent_boundary\.md$/i.test(filePath)
        || /[\\/]hooks[\\/]/i.test(filePath);
    const isProse = /\.(md|markdown|txt|mdx|rst)$/i.test(filePath);
    const reasons = [];
    if (EM_DASH.test(text))
        reasons.push('an em dash (U+2014)');
    if (EMOJI_CORE.test(text))
        reasons.push('an emoji');
    if (isProse && SYMBOLS_PROSE.test(text))
        reasons.push('an arrow, checkmark, or symbol (not allowed in documents)');
    if (!slangExempt && SLANG.some((re) => re.test(text)))
        reasons.push('a colloquial slang term (English or French)');
    if (!reasons.length)
        return null;
    return { reasons, where: filePath ? ('the file ' + filePath) : ('this ' + tool + ' command') };
}
export function contentDenyReason(p) {
    return 'Blocked by brain rule: ' + p.where + ' contains ' + p.reasons.join(' and ') + '. Rule: plain professional language, no em dashes, no emojis, no arrows or checkmarks, no slang. Remove it and retry. The banned slang list is in hooks/content-rules.mjs.';
}
export function styleProblems(text) {
    const t = String(text || '');
    const reasons = [];
    if (EM_DASH.test(t))
        reasons.push('an em dash');
    if (EMOJI_CORE.test(t))
        reasons.push('an emoji');
    if (SYMBOLS_PROSE.test(t))
        reasons.push('an arrow, checkmark, or decorative symbol');
    if (SLANG.some((re) => re.test(t)))
        reasons.push('a colloquial slang term (English or French)');
    return reasons;
}
export function slipNote(reasons) {
    return 'WRITING SLIP IN YOUR LAST REPLY: it contained ' + reasons.join(' and ')
        + '. It was not rewritten, to save cost. Do not repeat it: plain words only, no em dashes, no emoji, no arrows, no checkmarks, no slang (the list is in hooks/content-rules.mjs).';
}
