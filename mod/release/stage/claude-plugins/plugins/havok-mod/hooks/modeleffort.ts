import type { Engine, On } from 'claude-code';
import { S, toolMatch, setOwnStatus, owner } from './shared';
import { usageRow } from './usage';
export type Own = {
    model: string;
    effort: string;
    since?: string;
    why?: string;
    by?: string;
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const TOKENS_PER_POINT = 114000;
let own: Own = { model: '', effort: '' };
let turnModel = '';
let lastModel = '';
let lastContext = 0;
let loaded = '';
const stateFile = (home: string, agent: string) => `${home}/.claude/havok-mod/agent/${agent}.json`;
export const ownNow = () => own;
export function validModel(m: string): boolean {
    return /^(haiku|sonnet|opus|fable)$/i.test(m) || /^claude-[a-z0-9.-]{3,60}$/i.test(m);
}
export const isFable = (m: string) => /fable/i.test(m);
const family = (m: string) => (/fable/i.test(m) ? 'fable' : /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : m.toLowerCase());
export const sameModel = (a: string, b: string) => !!a && !!b && family(a) === family(b);
export function applyOwn<T extends {
    index: number;
    model: string;
    effort?: string | number;
    agentId?: string;
}>(e: T, o: Own, state: {
    turnModel: string;
}): T {
    if (e.agentId !== undefined)
        return e;
    let out = e;
    if (e.index === 0)
        state.turnModel = o.model && !sameModel(o.model, e.model) ? o.model : '';
    if (state.turnModel)
        out = { ...out, model: state.turnModel };
    if (o.effort && (EFFORTS as readonly string[]).includes(o.effort) && e.effort !== o.effort)
        out = { ...out, effort: o.effort as T['effort'] };
    return out;
}
export async function loadOwn($: Engine) {
    const c = S.cfg;
    if (!c || loaded === c.agent)
        return;
    loaded = c.agent;
    let saved: Own | null = null;
    try {
        saved = JSON.parse(await $.fs.read(stateFile(c.home, c.agent))) as Own;
    }
    catch {
        saved = null;
    }
    const start = c.modelEffort ?? { model: '', effort: '' };
    own = saved && (saved.model || saved.effort) ? { model: saved.model || '', effort: saved.effort || '', since: saved.since, why: saved.why, by: saved.by } : { model: start.model || '', effort: start.effort || '', by: start.model || start.effort ? 'config' : undefined };
    setOwnStatus($, { model: own.model, effort: own.effort, by: own.by });
    if (own.model || own.effort)
        $.ui.log(`own model and effort: ${own.model || 'default model'}, ${own.effort || 'default effort'} (${own.by ?? 'saved'})`, { to: 'debug' });
}
export function stepRequest<T extends {
    index: number;
    model: string;
    effort?: string | number;
    agentId?: string;
}>(e: T): T {
    const state = { turnModel };
    const out = applyOwn(e, own, state);
    turnModel = state.turnModel;
    return out;
}
export function stepAnswered(r: {
    usage?: {
        model?: string;
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    } | null;
} | undefined, agentId?: string) {
    if (agentId !== undefined || !r?.usage)
        return;
    if (r.usage.model)
        lastModel = r.usage.model;
    const n = (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0);
    if (n)
        lastContext = n;
}
export function switchAnswer(o: {
    from: Own;
    to: Own;
    current: string;
    context: number;
}): string {
    const parts: string[] = [];
    const modelChange = !!o.to.model && !sameModel(o.to.model, o.current);
    const back = !o.to.model && !!o.from.model;
    if (modelChange || back) {
        const points = o.context ? Math.max(0.1, Math.round((o.context / TOKENS_PER_POINT) * 10) / 10) : 0;
        parts.push(`Model ${o.to.model || 'back to the machine default'} from the next turn (not inside this one).` +
            (o.context ? ` It rewrites the whole context once in that model's cache: about ${o.context.toLocaleString('en-US')} tokens, about ${points} five-hour points.` : ' It rewrites the whole context once in that model\'s cache.') +
            ' Switch at a natural break: a new task, or right after a clean-up, when the context is rewritten anyway.');
    }
    else if (o.to.model)
        parts.push(`Model ${o.to.model}: already in use, nothing to rewrite.`);
    if (o.to.effort !== o.from.effort)
        parts.push(`Effort ${o.to.effort || 'back to the default'} from the next prompt; it costs nothing (the cache is kept).`);
    return parts.join(' ') || 'Nothing changed.';
}
async function setOwn($: Engine, input: Record<string, unknown>): Promise<{
    result: string;
} | {
    deny: string;
}> {
    const c = S.cfg;
    if (!c)
        return { deny: 'This session has no Havok agent config; the model and effort stay as Claude Code sets them.' };
    await loadOwn($);
    const model = typeof input.model === 'string' ? input.model.trim() : undefined;
    const effort = typeof input.effort === 'string' ? input.effort.trim().toLowerCase() : undefined;
    const why = String(input.why ?? '').trim();
    const ownerAsked = input.owner_asked === true;
    if (!why)
        return { deny: `Say why in "why": the reason is kept with the choice and shown to ${owner()}.` };
    if (model === undefined && effort === undefined)
        return { deny: 'Give a model, an effort, or both ("default" clears one).' };
    if (model !== undefined && model !== 'default' && !validModel(model))
        return { deny: `"${model}" is not a model: use haiku, sonnet, opus or a full claude-... id, or "default".` };
    if (model && isFable(model) && !ownerAsked)
        return { deny: `Fable only when ${owner()} asks for it (global context): set owner_asked true and quote the request in "why".` };
    if (effort !== undefined && effort !== 'default' && !(EFFORTS as readonly string[]).includes(effort))
        return { deny: `"${effort}" is not an effort: use low, medium, high, xhigh, max, or "default".` };
    const from = { ...own };
    const to: Own = {
        model: model === undefined ? own.model : model === 'default' ? '' : model,
        effort: effort === undefined ? own.effort : effort === 'default' ? '' : effort,
        since: new Date(await $.clock.now()).toISOString(),
        why,
        by: ownerAsked ? owner() : c.agent,
    };
    const kept = from.by === owner() && !ownerAsked ? ` The earlier choice was ${owner()}'s; this replaces it, so say so.` : '';
    own = to;
    setOwnStatus($, { model: to.model, effort: to.effort, by: to.by });
    try {
        await $.fs.write(stateFile(c.home, c.agent), JSON.stringify(to) + '\n');
    }
    catch (err) {
        return { deny: `The choice could not be saved (${String(err).slice(0, 100)}); nothing changed.` };
    }
    const answer = switchAnswer({ from, to, current: lastModel || turnModel, context: lastContext }) + kept;
    $.ui.log(`model and effort set: ${to.model || 'default model'}, ${to.effort || 'default effort'} (by ${to.by}: ${why})`, { to: 'transcript' });
    await usageRow($, { id: `m-${Date.now().toString(36)}`, at: to.since, kind: 'model-switch', session: S.sessionId, from: { model: from.model, effort: from.effort }, to: { model: to.model, effort: to.effort }, current: lastModel, context: lastContext, why, by: to.by }).catch(() => undefined);
    return { result: answer };
}
export async function registerModelTool($: Engine) {
    await $.tool.register({
        name: 'set_model_effort',
        isDeferred: true,
        description: 'Set your own model and effort as this agent, kept across restarts and applied by the mod to every request (not Claude Code\'s machine default). ' +
            'Effort (low, medium, high, xhigh, max) applies from the next prompt and costs nothing. A model (haiku, sonnet, opus, or a full id) applies from the next turn and rewrites your whole context once in that model\'s cache: the answer gives the cost; switch at a natural break, a new task or right after a clean-up. ' +
            `"default" clears one. Fable only when ${owner()} asks for it (owner_asked true, the request quoted in why).`,
        inputSchema: {
            type: 'object',
            properties: {
                model: { type: 'string', description: 'haiku, sonnet, opus, a full claude-... id, or "default".' },
                effort: { type: 'string', description: 'low, medium, high, xhigh, max, or "default".' },
                why: { type: 'string', description: `Why, in one line (the work needs it, or what ${owner()} asked).` },
                owner_asked: { type: 'boolean', description: `True when ${owner()} asked for this choice.` },
            },
            required: ['why'],
        },
    });
}
export function modelTools(on: On) {
    on('tool.call', toolMatch('set_model_effort'), async ($, e) => {
        if (e.agentId !== undefined)
            return { deny: 'The model and effort are set for the main conversation only.' };
        return setOwn($, e as unknown as Record<string, unknown>);
    }).catch(() => ({ deny: 'The model and effort could not be set in the mod; nothing changed. Try again.' }));
}
