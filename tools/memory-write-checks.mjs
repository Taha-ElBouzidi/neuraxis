export const DESC_MIN = 60;
export const BODY_MIN = 100;
export function writeChecks({ head = '', body = '', desc = '' } = {}) {
    const d = String(desc || '').trim().replace(/^["']|["']$/g, '');
    if (d.length < DESC_MIN) {
        return { refuse: { error: 'thin description', detail: `the description is the only text recall searches: write it in the words the person would type when looking for this, and when to read it (at least ${DESC_MIN} characters; this one has ${d.length}).` } };
    }
    if (!/^\s*asserted:\s*["']?\d{4}-\d{2}-\d{2}/m.test(head)) {
        return { refuse: { error: 'missing asserted date', detail: 'add "asserted: YYYY-MM-DD" under metadata: the date the fact was written (and "updated:" when it changes).' } };
    }
    const text = String(body || '').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/[#*>`_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < BODY_MIN) {
        return { refuse: { error: 'thin body', detail: `the body must state the fact, its source, where it applies and why (at least ${BODY_MIN} characters of text; this one has ${text.length}).` } };
    }
    const warnings = [];
    const sourced = /\bsource\b|\bsaid\b|\bwords\b|\btold\b|"[^"]{4,}"|\b\d{4}-\d{2}-\d{2}\b|\bmeasured\b|\btested\b|\bcommit\b|\bfile\b|\bcommand\b/i.test(text);
    if (!sourced)
        warnings.push('no source named: add who said it (with the date) or the command, file or test that proved it.');
    return { warnings };
}
