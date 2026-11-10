import type { Engine, On, ToolCallInput, ToolCallResult } from 'claude-code';
import { S, appendShared, toolMatch, org, owner, isBackgroundFork, FORK_REFUSAL } from './shared';
import { B, brainInit } from './brainjobs';
import { brainHost } from './recall';
import { hostRequest } from './brainhost';
const SEND_MS = 120000;
const MAX = { what: 2000, why: 2000, options: 4000, area: 40, relates: 20, relate: 200 };
const AREAS = ['mod', 'brain', 'messages', 'context', 'release', 'finance', 'health', 'tv', 'ipad', 'network', 'machine', 'agents', 'pages', 'security', 'other'];
let turnMessages: string[] = [];
let turnCommits: string[] = [];
let sending = false;
let again = false;
export const decisionOutbox = (dir: string, agent: string, machine: string) => `${dir}/outbox-decisions-${agent}@${machine}.jsonl`;
export function messageIdsOf(text: string): string[] {
    const out: string[] = [];
    for (const m of String(text ?? '').matchAll(/AGENT MESSAGE:[^\n]*\(id ([0-9A-Z]{26})\)/g))
        if (!out.includes(m[1]!))
            out.push(m[1]!);
    return out;
}
export function commitsOf(command: string, output: string): string[] {
    const out: string[] = [];
    const add = (h: string) => { if (!out.includes(h))
        out.push(h); };
    const text = String(output ?? '');
    for (const m of text.matchAll(/^\[[^\]\n]*? ([0-9a-f]{7,12})\] /gm))
        add(m[1]!);
    if (/\bgit\b[^\n]*\bcommit\b/.test(command) && /\bgit\b[^\n]*\blog\b[^\n]*--oneline/.test(command)) {
        for (const m of text.matchAll(/^([0-9a-f]{7,12}) \S/gm))
            add(m[1]!);
    }
    return out;
}
export function decisionsTurnStart(text: string) {
    turnMessages = messageIdsOf(text);
    turnCommits = [];
}
export function noteToolResult(e: ToolCallInput, r: ToolCallResult) {
    if (e.agentId !== undefined || 'deny' in r)
        return;
    const tool = String(e.tool);
    if (tool !== 'Bash' && tool !== 'PowerShell')
        return;
    const command = String((e as unknown as {
        command?: unknown;
    }).command ?? '');
    if (!/\bgit\b/.test(command))
        return;
    const output = typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? '');
    for (const h of commitsOf(command, output))
        if (!turnCommits.includes(h))
            turnCommits.push(h);
}
export function callsReview(command: string): boolean {
    const c = String(command ?? '');
    return /(127\.0\.0\.1|localhost|\[::1\]):8502\b/i.test(c) || /\/api\/decisions\/[^\s'"]+\/review/i.test(c);
}
export function buildRow(input: Record<string, unknown>, ctx: {
    agent: string;
    machine: string;
    session: string;
    at: string;
    messages: string[];
    commits: string[];
}): {
    row: Record<string, unknown>;
} | {
    deny: string;
} {
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const what = s(input.what);
    const why = s(input.why);
    if (!what)
        return { deny: 'Say what was decided in "what", in one line.' };
    if (!why)
        return { deny: `Say why in "why": ${owner()} reviews the reason with the decision.` };
    if (what.length > MAX.what || why.length > MAX.why)
        return { deny: `"what" and "why" are at most ${MAX.what} characters each; say it shorter.` };
    const options = s(input.options_left_out);
    if (options.length > MAX.options)
        return { deny: `"options_left_out" is at most ${MAX.options} characters.` };
    const area = (s(input.area) || 'other').toLowerCase().slice(0, MAX.area);
    const byGiven = s(input.by);
    if (byGiven && byGiven.toLowerCase() !== owner().toLowerCase())
        return { deny: `"by" is "${owner()}" for a decision ${owner()} gave you; leave it out for one you took yourself.` };
    const given = Array.isArray(input.relates_to) ? input.relates_to : typeof input.relates_to === 'string' && input.relates_to ? [input.relates_to] : [];
    const relates: string[] = [];
    for (const r of [...given.map((x) => String(x).trim().slice(0, MAX.relate)), ...ctx.messages.map((m) => `message ${m}`), ...ctx.commits.map((c) => `commit ${c}`)]) {
        if (r && !relates.includes(r) && relates.length < MAX.relates)
            relates.push(r);
    }
    return { row: { id: 'd-' + crypto.randomUUID(), kind: 'decision', at: ctx.at, agent: ctx.agent, machine: ctx.machine, session: ctx.session, what, why, options_left_out: options, area, relates_to: relates, ...(byGiven ? { by: owner() } : {}) } };
}
function send($: Engine, outbox: string) {
    if (sending) {
        again = true;
        return;
    }
    sending = true;
    void (async () => {
        try {
            await brainInit($);
            if (!B.root)
                return;
            await $.process.run(['node', `${B.root}/hooks/send-analytics.mjs`, 'decision', outbox], { timeoutMs: SEND_MS });
        }
        catch (err) {
            $.ui.log(`decisions not sent this time (${String(err).slice(0, 120)}); they wait in the outbox`, { to: 'debug' });
        }
        finally {
            sending = false;
            if (again) {
                again = false;
                send($, outbox);
            }
        }
    })();
}
export async function decisionsStart($: Engine) {
    const c = S.cfg;
    if (!c)
        return;
    await $.tool.register({
        name: 'log_decision',
        isDeferred: false,
        description: `Log a decision for ${owner()}'s review, the moment you take it: a choice between options, approving another agent's proposal, a rule, threshold or setting chosen, something built or left out. ` +
            `A decision ${owner()} gives you (to any agent) is logged the same moment with by: "${owner()}". ` +
            `Each one is reviewed${org().reviewUrl ? ` on ${org().reviewUrl}` : ''} and marked kept or reversed; a reversal reaches you as a message. ` +
            'The mod adds your agent, machine, time, the messages this turn answers and the commits it made. Plain sentences.',
        inputSchema: {
            type: 'object',
            properties: {
                what: { type: 'string', description: 'What was decided, in one line.' },
                why: { type: 'string', description: 'Why: the reason, the measurement or whose request.' },
                options_left_out: { type: 'string', description: 'The alternatives not taken and why not.' },
                area: { type: 'string', description: `The area: ${AREAS.join(', ')}.` },
                relates_to: { type: 'array', items: { type: 'string' }, description: 'Optional: a file, plan, page, release or message this decision belongs to (messages and commits of this turn are added by the mod).' },
                by: { type: 'string', description: `"${owner()}" when ${owner()} gave you this decision; leave it out for one you took yourself.` },
            },
            required: ['what', 'why', 'area'],
        },
    });
    await $.tool.register({
        name: 'decision_search',
        isDeferred: false,
        description: `Search the decision log (${owner()}'s decisions and every agent's, with their review state: waiting, kept or reversed) by words. ` +
            `Check it before asking ${owner()} anything: if it was already decided, act on that instead of asking or messaging another agent.`,
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Words to look for, such as the subject of the question.' },
                limit: { type: 'number', description: 'At most this many decisions (default 10, at most 30).' },
            },
            required: ['query'],
        },
    });
    send($, decisionOutbox(c.usage.dir, c.agent, c.machine));
}
export function formatSearch(query: string, decisions: Record<string, unknown>[]): string {
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const oneLine = (v: unknown, n: number) => { const x = s(v).replace(/\s+/g, ' ').trim(); return x.length <= n ? x : x.slice(0, n) + '...'; };
    if (!decisions.length)
        return `No decision in the log matches "${oneLine(query, 120)}". If it is ${owner()}'s to decide, ask.`;
    const lines = [`${decisions.length} decision${decisions.length === 1 ? '' : 's'} matching "${oneLine(query, 120)}", best first:`];
    for (const d of decisions) {
        const review = d.review && typeof d.review === 'object' ? (d.review as Record<string, unknown>) : null;
        lines.push(`- ${s(d.id)} (${s(d.at).slice(0, 16).replace('T', ' ')} UTC, by ${s(d.by) || s(d.agent) || 'an agent'}${s(d.by) && s(d.agent) ? ` through ${s(d.agent)}` : ''}, ${s(d.state) || 'waiting'}, ${s(d.area) || 'other'}): ${oneLine(d.what, 400)}`);
        lines.push(`  why: ${oneLine(d.why, 400)}`);
        if (review && s(review.note))
            lines.push(`  ${owner()}'s review note: ${oneLine(review.note, 300)}`);
    }
    return lines.join('\n');
}
export function decisionTools(on: On) {
    on('tool.call', toolMatch('decision_search'), async ($, e) => {
        const input = e as unknown as Record<string, unknown>;
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query)
            return { deny: 'Give the words to look for in "query".' };
        const limit = Math.min(Math.max(Math.round(Number(input.limit) || 10), 1), 30);
        const h = await brainHost($);
        if (!h)
            return { deny: 'This machine has no brain server to search; the decision log cannot be read here.' };
        const r = await hostRequest($, h, 'GET', `/decisions?q=${encodeURIComponent(query.slice(0, 500))}&limit=${limit}`, { budgetMs: 8000 });
        if (!r.ok)
            return { deny: `The brain server did not answer (${r.why.slice(0, 100)}); try again.` };
        if (r.status !== 200)
            return { deny: `The brain server answered status ${r.status}; the search did not run.` };
        let v: {
            decisions?: unknown;
        };
        try {
            v = JSON.parse(r.text);
        }
        catch {
            return { deny: 'The brain server answered something that is not a decision list.' };
        }
        const list = Array.isArray(v.decisions) ? (v.decisions as Record<string, unknown>[]).filter((d) => d && typeof d === 'object') : [];
        return { result: formatSearch(query, list) };
    }).catch(() => ({ deny: 'The decision search failed in the mod; try again.' }));
    on('tool.call', toolMatch('log_decision'), async ($, e) => {
        const c = S.cfg;
        if (!c)
            return { deny: 'This session has no Havok agent config, so the decision cannot be logged here.' };
        if (await isBackgroundFork($, e.agentId))
            return { deny: FORK_REFUSAL };
        const built = buildRow(e as unknown as Record<string, unknown>, {
            agent: c.agent, machine: c.machine, session: S.sessionId, at: new Date(await $.clock.now()).toISOString(),
            messages: e.agentId === undefined ? turnMessages : [], commits: e.agentId === undefined ? turnCommits : [],
        });
        if ('deny' in built)
            return { deny: built.deny };
        const outbox = decisionOutbox(c.usage.dir, c.agent, c.machine);
        try {
            await appendShared($, outbox, JSON.stringify(built.row) + '\n');
        }
        catch (err) {
            return { deny: `The decision could not be written to the outbox (${String(err).slice(0, 100)}); nothing was logged. Try again.` };
        }
        send($, outbox);
        const rel = (built.row.relates_to as string[]);
        return { result: `Logged ${String(built.row.id)} (${String(built.row.area)})${rel.length ? `, related to ${rel.join(', ')}` : ''}. It goes to ${owner()}'s review list.` };
    }).catch(() => ({ deny: 'The decision could not be logged in the mod; try again.' }));
    on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
        if (callsReview(String((e as unknown as {
            command?: unknown;
        }).command ?? ''))) {
            return { deny: `The review page and its listener are ${owner()}'s alone. An agent allowed to review other agents' decisions uses node <brainDir>/tools/brain-client.mjs decision review <id> kept|reversed "<note>".` };
        }
        return next(e);
    });
}
