export const MARK = 'BRAIN FOR HELPERS';
export const RECALL_MARK = 'BRAIN RECALL FOR THIS MESSAGE';
export const HELPER_ID = /^a[0-9a-f]{16}$/;
export function helperBlock(client) {
    return [
        '',
        '---',
        MARK + ' (added automatically):',
        'You are a helper of the main assistant. The person it works for has a shared brain of memories: their rules, decisions, people, projects, accounts and past work.',
        'For anything you need, search the brain first, and only when it has nothing use other sources (web, docs, tools). Search with one quoted question per need, in plain words:',
        '  node "' + client + '" search "<question 1>" "<question 2>"',
        'Then open the matching memories with: node "' + client + '" read <name>. A one-line description says whether to open a memory, never what it says.',
        'Never invent a fact; say what you could not check. Write plain English: no em dashes, no emoji, no arrows, no checkmarks, no slang. Never print a secret.',
        'Any command or script you run stays hidden in the background, never in a visible window.',
    ].join('\n');
}
export function withHelperBlock(input, client) {
    if (!input || typeof input.prompt !== 'string' || input.prompt.includes(MARK))
        return null;
    return { ...input, prompt: input.prompt + '\n' + helperBlock(client) };
}
export function recallQuery(input) {
    const to = String((input && input.to) || '').trim();
    const msg = input && typeof input.message === 'string' ? input.message : '';
    if (!HELPER_ID.test(to) || !msg.trim() || msg.includes(RECALL_MARK))
        return null;
    return msg.replace(/\s+/g, ' ').slice(0, 400);
}
export function withRecall(input, searchOut, client) {
    const lines = String(searchOut || '').split('\n').filter((l) => l.startsWith('- ') || l.startsWith('BRAIN RECALL'));
    if (lines.length < 2)
        return null;
    return { ...input, message: input.message + '\n\n---\n' + RECALL_MARK + ' (added automatically; open the ones you need with node "'
            + client + '" read <name>):\n' + lines.slice(1, 12).join('\n') };
}
