import { menuTurn, setInteractive } from './agentmenu';
import { loadOwn, registerModelTool, modelTools, stepRequest, stepAnswered } from './modeleffort';
import { decisionsStart, decisionsTurnStart, decisionTools, noteToolResult } from './decisions';
import { readLimits, limitLine } from './limits';
import { isPingText } from './brain/keepwarm-rules.mjs';
import type { Register, ToolCallInput, ToolCallResult } from 'claude-code';
import { PLUGIN, S, dropCleanedContext, kindOf, loadConfig, markReal, statusBeat, statusStart, statusStep, storeSet } from './shared';
const lastRequestKey = (session: string) => `lastrequest:${session}`;
import { coldTurnStart, isColdTurn, COLD_TURN_ANSWER } from './context';
import { contextStart, contextTurnStart, contextCompose, contextSubmit, contextLayerCheck, globalDelivered, realActivity, contextTurn, contextCompact, sessionFilePath, contextTools, ownCompaction, OWN_COMPACTION_FAILED, contextStep, takeContextNote, takeChangeNote } from './context';
import { foldRender } from './fold';
import { mailStart, mailSubmit, mailTurn, mailTurnStart, mailStep, mailTools, mailToolContext, mailBusy } from './mail';
import { warmStart, warmSubmit, warmTurn } from './keepwarm';
import { usageStart, usageTurn } from './usage';
import { writeLayersLive, hostRelease } from './layersource';
import { updateCheck } from './update';
import { recallTurn, recallDown } from './recall';
import { rcStart, rcTitle, rcTurn, rcAccountChanged, rcCredentialsPath, rcPidPath, isPidPath, rcPidChanged } from './remote';
import { brainInit, brainKnownDown, brainToolCall, brainPrompt, brainStop, brainSessionStart, brainCompact, brainRequest, markHandled, markStartEarly, inputOf, touchAlive, takeBlockedAnswer, lightSession } from './brainjobs';
const why = (err: unknown) => String(err).slice(0, 200);
type Data = Record<string, unknown>;
const MARKER_WAIT_MS = 8000;
function gate() {
    let open: () => void = () => undefined;
    const p = new Promise<void>((r) => { open = r; });
    return { p, open, done: false };
}
let startGate = gate();
export const register: Register = (on) => {
    on('session.start', async ($, e, next) => {
        if (startGate.done)
            startGate = gate();
        const g = startGate;
        try {
            const started = await next(e);
            const c = await loadConfig($, e.cwd);
            S.cfg = c;
            if (!c)
                return started;
            S.sessionId = await $.session.id();
            setInteractive(e.isInteractive !== false);
            S.turnRunning = false;
            S.turnKind = 'none';
            S.composeSeen = false;
            S.guarded = undefined;
            await markReal($);
            S.lastRequest = 0;
            try {
                await statusStart($);
            }
            catch (err) {
                $.ui.log(`status: ${why(err)}`, { to: 'debug' });
            }
            try {
                await loadOwn($);
                await registerModelTool($);
            }
            catch (err) {
                $.ui.log(`model and effort: ${why(err)}`, { to: 'debug' });
            }
            try {
                await decisionsStart($);
            }
            catch (err) {
                $.ui.log(`decisions: ${why(err)}`, { to: 'debug' });
            }
            if ((await $.session.messages()).length) {
                const kept = Number(await $.store.get(lastRequestKey(S.sessionId)).catch(() => 0)) || 0;
                if (kept > 0)
                    S.lastRequest = kept;
                else {
                    const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${c.home}/.claude`).replace(/\\/g, '/').replace(/\/+$/, '');
                    try {
                        S.lastRequest = (await $.fs.stat(sessionFilePath(configDir, c.cwd, S.sessionId))).mtimeMs;
                    }
                    catch {
                        S.lastRequest = 0;
                    }
                }
            }
            try {
                usageStart($, c);
            }
            catch (err) {
                $.ui.log(`usage: ${why(err)}`, { to: 'debug' });
            }
            const live = async () => {
                const d = globalDelivered();
                if (d.delivered)
                    await writeLayersLive($, c.home, S.sessionId, d);
                g.done = true;
                g.open();
            };
            try {
                await contextStart($, c, live);
            }
            catch (err) {
                $.ui.log(`context: ${why(err)}`, { to: 'debug' });
            }
            try {
                await warmStart($, c);
            }
            catch (err) {
                $.ui.log(`keep-warm: ${why(err)}`, { to: 'debug' });
            }
            try {
                await mailStart($, c);
            }
            catch (err) {
                $.ui.log(`messages: ${why(err)}`, { to: 'debug' });
            }
            try {
                await rcStart($, c);
            }
            catch (err) {
                $.ui.log(`remote control: ${why(err)}`, { to: 'debug' });
            }
            return started;
        }
        finally {
            g.done = true;
            g.open();
        }
    });
    on('prompt.compose', ($, e, next) => contextCompose($, e, next));
    on('prompt.submit', async ($, e, next) => {
        if (!S.cfg)
            return next(e);
        let x = e;
        try {
            const own = e.origin?.kind === 'plugin' && (e.origin as {
                name?: string;
            }).name === PLUGIN;
            if (!own) {
                await markReal($);
                realActivity();
            }
            x = await contextSubmit($, x);
            x = warmSubmit($, x);
            mailSubmit($, x);
        }
        catch (err) {
            $.ui.log(`prompt.submit: ${why(err)}`, { to: 'debug' });
            x = e;
        }
        return next(x);
    });
    on('turn.start', async ($, e, next) => {
        if (S.cfg && e.agentId === undefined) {
            S.turnRunning = true;
            S.turnKind = kindOf(e.text);
            coldTurnStart(e.text);
            decisionsTurnStart(e.text);
            try {
                mailTurnStart(e, S.turnKind, await $.clock.now());
                void mailBusy($, e.agentId).catch(() => undefined);
            }
            catch (err) {
                $.ui.log(`messages: ${why(err)}`, { to: 'debug' });
            }
            if (S.turnKind === 'real' || S.turnKind === 'mail') {
                await markReal($);
                realActivity();
                try {
                    await contextTurnStart($);
                }
                catch (err) {
                    $.ui.log(`context: ${why(err)}`, { to: 'debug' });
                }
            }
            await statusBeat($).catch(() => undefined);
        }
        return next(e);
    });
    on('turn.step', async function* ($, e, next) {
        const held = e.agentId === undefined && e.index === 0 ? takeBlockedAnswer() : '';
        if (held) {
            $.ui.log('limit reserve: prompt held, answered with the notice, no request', { to: 'debug' });
            yield { kind: 'text', index: 0, text: held } as never;
            yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never;
            return { turnId: e.turnId, index: e.index, answer: held, toolUses: [], stopReason: 'end_turn', usage: null } as never;
        }
        if (S.cfg && e.agentId === undefined && isColdTurn()) {
            $.ui.log(`cold turn: step ${e.index} answered without a request`, { to: 'debug' });
            return { turnId: e.turnId, index: e.index, answer: COLD_TURN_ANSWER, toolUses: [], stopReason: 'end_turn', usage: null } as never;
        }
        let sent = e;
        if (S.cfg)
            try {
                sent = stepRequest(e);
            }
            catch (err) {
                $.ui.log(`model and effort: ${why(err)}`, { to: 'debug' });
            }
        if (e.index === 0 && e.agentId === undefined && (sent.model !== e.model || sent.effort !== e.effort))
            $.ui.log(`own model and effort on this turn: model ${e.model} sent as ${sent.model}, effort ${e.effort ?? 'none'} sent as ${sent.effort ?? 'none'}`, { to: 'debug' });
        const r = yield* next(sent);
        try {
            stepAnswered(r as never, e.agentId);
        }
        catch { }
        if (e.index === 0 && e.agentId === undefined && sent.model !== e.model)
            $.ui.log(`own model: the answer came from ${(r as {
                usage?: {
                    model?: string;
                };
            } | undefined)?.usage?.model ?? 'unknown'}`, { to: 'debug' });
        if (e.agentId === undefined)
            brainRequest((r as {
                usage?: unknown;
            } | undefined)?.usage);
        if (S.cfg)
            try {
                mailStep(r, e.agentId);
            }
            catch (err) {
                $.ui.log(`messages: ${why(err)}`, { to: 'debug' });
            }
        if (S.cfg && e.agentId === undefined) {
            S.lastRequest = await $.clock.now();
            dropCleanedContext();
            try {
                await contextStep($, r?.usage ?? null, r?.toolUses?.length ?? 0);
            }
            catch (err) {
                $.ui.log(`context: ${why(err)}`, { to: 'debug' });
            }
            void statusStep($);
        }
        return r;
    });
    on('tool.call', async ($, e, next) => {
        const pass = async (x: ToolCallInput) => {
            const r = await next(x);
            if (S.cfg)
                try {
                    noteToolResult(x, r);
                }
                catch { }
            if (S.cfg && x.agentId === undefined)
                void statusStep($);
            await touchAlive($).catch(() => undefined);
            const noted = withContextNote(x, r);
            if (!S.cfg || 'deny' in noted)
                return noted;
            const mail = await mailToolContext($, x.agentId).catch(() => null);
            return mail ? { ...noted, context: [...(noted.context ?? []), mail] } : noted;
        };
        const tool = String(e.tool);
        if (S.cfg && e.agentId === undefined && (S.turnKind === 'real' || S.turnKind === 'mail') && !tool.startsWith(`mcp__${PLUGIN}__`))
            await markReal($);
        const raw = e as unknown as Data;
        let answer: Awaited<ReturnType<typeof brainToolCall>> = null;
        try {
            answer = await brainToolCall($, raw, next);
        }
        catch (err) {
            $.ui.log(`brain jobs on ${tool}: ${why(err)}`, { to: 'debug' });
            return pass(e);
        }
        if (answer && 'deny' in answer)
            return { deny: answer.deny };
        await markHandled($, 'PreToolUse', { tool_use_id: raw.tool_use_id, tool_name: tool, tool_input: inputOf(raw) }).catch(() => undefined);
        if (answer && 'input' in answer)
            return pass({ ...e, ...answer.input } as ToolCallInput);
        return pass(e);
    });
    on('classic.UserPromptSubmit', async ($, e, next) => {
        let mine: Awaited<ReturnType<typeof brainPrompt>>;
        try {
            mine = await brainPrompt($, e as unknown as Data, next);
        }
        catch (err) {
            $.ui.log(`brain jobs on the prompt: ${why(err)}`, { to: 'debug' });
            return next(e);
        }
        if ('block' in mine)
            return { block: mine.block };
        if ('answer' in mine)
            return next(e);
        let recall: Awaited<ReturnType<typeof recallTurn>> = { block: '' };
        const light = await lightSession($).catch(() => false);
        if (!light)
            try {
                recall = await recallTurn($, String((e as unknown as Data).prompt ?? ''), next);
            }
            catch (err) {
                $.ui.log(`recall: ${why(err)}`, { to: 'debug' });
            }
        try {
            await contextLayerCheck($, recall.layers, recallDown() || (await brainKnownDown($)));
        }
        catch (err) {
            $.ui.log(`layer check: ${why(err)}`, { to: 'debug' });
        }
        let notice = '';
        try {
            notice = await updateCheck($, recall.release ?? hostRelease());
        }
        catch (err) {
            $.ui.log(`release notice: ${why(err)}`, { to: 'debug' });
        }
        await markHandled($, 'UserPromptSubmit', e as unknown as Data).catch(() => undefined);
        const r = await next(e);
        const change = takeChangeNote();
        let limits = '';
        if (S.cfg && !isPingText(String((e as unknown as Data).prompt ?? ''))) {
            try {
                limits = limitLine(await readLimits($, S.cfg.keepWarm.limitsFile), await $.clock.now());
            }
            catch { }
        }
        const add = [...mine.context, ...(change ? [change] : []), ...(recall.block ? [recall.block] : []), ...(limits ? [limits] : []), ...(notice ? [notice] : [])];
        return add.length ? { ...r, additionalContext: [...(r.additionalContext ?? []), ...add] } : r;
    });
    on('classic.Stop', async ($, e, next) => {
        let block: string | null;
        try {
            block = await brainStop($, e as unknown as Data, next);
        }
        catch (err) {
            $.ui.log(`brain jobs at the end of the reply: ${why(err)}`, { to: 'debug' });
            return next(e);
        }
        if (block)
            return { block };
        await markHandled($, 'Stop', e as unknown as Data).catch(() => undefined);
        return next(e);
    });
    on('classic.SessionStart', async ($, e, next) => {
        if (await lightSession($).catch(() => false)) {
            try {
                await brainInit($, S.cfg?.checks.brainDir ?? '');
                await markHandled($, 'SessionStart', e as unknown as Data);
            }
            catch (err) {
                $.ui.log(`brain session start: ${why(err)}`, { to: 'debug' });
            }
            return next(e);
        }
        await markStartEarly($, e as unknown as Data).catch(() => undefined);
        await Promise.race([startGate.p, $.clock.sleep(MARKER_WAIT_MS)]);
        try {
            await brainInit($, S.cfg?.checks.brainDir ?? '');
            await brainSessionStart($, e as unknown as Data, next);
            await markHandled($, 'SessionStart', e as unknown as Data);
        }
        catch (err) {
            $.ui.log(`brain session start: ${why(err)}`, { to: 'debug' });
        }
        const r = await next(e);
        let title = '';
        try {
            title = await rcTitle($);
        }
        catch (err) {
            $.ui.log(`remote control title: ${why(err)}`, { to: 'debug' });
        }
        const cred = rcCredentialsPath();
        let pidPath = '';
        try {
            pidPath = await rcPidPath($, String((e as unknown as {
                session_id?: string;
            }).session_id ?? S.sessionId ?? ''));
        }
        catch (err) {
            $.ui.log(`remote control record: ${why(err)}`, { to: 'debug' });
        }
        const paths = [cred, pidPath].filter(Boolean);
        const watched = paths.length ? { watchPaths: [...((r as {
                    watchPaths?: string[];
                }).watchPaths ?? []), ...paths] } : {};
        return title ? { ...r, ...watched, sessionTitle: title } : { ...r, ...watched };
    });
    on('classic.FileChanged', async ($, e, next) => {
        const r = await next(e);
        const path = String((e as unknown as {
            file_path?: string;
        }).file_path ?? '').split(String.fromCharCode(92)).join('/').toLowerCase();
        if (path.endsWith('/.claude/.credentials.json'))
            await rcAccountChanged($).catch((err: unknown) => $.ui.log(`remote control: ${why(err)}`, { to: 'debug' }));
        else if (isPidPath(path))
            await rcPidChanged($).catch((err: unknown) => $.ui.log(`remote control: ${why(err)}`, { to: 'debug' }));
        return r;
    });
    on('classic.PostCompact', async ($, e, next) => {
        try {
            await brainCompact($, e as unknown as Data, next);
            await markHandled($, 'PostCompact', e as unknown as Data);
        }
        catch (err) {
            $.ui.log(`brain compaction log: ${why(err)}`, { to: 'debug' });
        }
        return next(e);
    });
    on('turn.complete', async ($, e, next) => {
        const r = await next(e);
        if (!S.cfg)
            return r;
        const kind = e.agentId === undefined ? S.turnKind : 'subagent';
        if (e.agentId === undefined) {
            S.turnRunning = false;
            if (e.usage) {
                S.lastRequest = await $.clock.now();
                await storeSet($, lastRequestKey(S.sessionId), S.lastRequest).catch(() => undefined);
            }
            if (kind === 'real' || kind === 'mail')
                await markReal($);
        }
        try {
            await usageTurn($, e, kind, next);
        }
        catch (err) {
            $.ui.log(`usage: ${why(err)}`, { to: 'debug' });
        }
        try {
            await contextTurn($, e, kind);
        }
        catch (err) {
            $.ui.log(`context: ${why(err)}`, { to: 'debug' });
        }
        try {
            await warmTurn($, e, kind);
        }
        catch (err) {
            $.ui.log(`keep-warm: ${why(err)}`, { to: 'debug' });
        }
        try {
            await mailTurn($, e, kind);
        }
        catch (err) {
            $.ui.log(`messages: ${why(err)}`, { to: 'debug' });
        }
        if (e.agentId === undefined) {
            await menuTurn($, kind, e.agentId).catch(() => undefined);
            S.turnKind = 'none';
            await statusBeat($).catch(() => undefined);
            await rcTurn($).catch(() => undefined);
        }
        return r;
    });
    on('session.compact', ($, e, next) => contextCompact($, e, next))
        .catch(($, e, next) => (ownCompaction(e) ? { skip: OWN_COMPACTION_FAILED } : next(e)));
    contextTools(on);
    mailTools(on);
    modelTools(on);
    decisionTools(on);
    foldRender(on);
};
function withContextNote(e: ToolCallInput, r: ToolCallResult): ToolCallResult {
    if (!S.cfg || e.agentId !== undefined || 'deny' in r)
        return r;
    const notes = [takeContextNote(), takeChangeNote()].filter(Boolean);
    return notes.length ? { ...r, context: [...(r.context ?? []), ...notes] } : r;
}
