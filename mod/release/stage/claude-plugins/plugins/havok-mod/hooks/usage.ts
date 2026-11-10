import type { TurnCompleteInput } from 'claude-code';
import { type Config, type Engine, type HookLink, S, appendText, waitCapped } from './shared';
import { B, brainInit } from './brainjobs';
import { takeHelperMs } from './brainhost';
const SEND_MS = 120000;
const WRITE_WAIT_MS = 5000;
let cfg: {
    dir: string;
    agent: string;
    machine: string;
} | null = null;
let writing: Promise<unknown> = Promise.resolve();
let sending = false;
let again = false;
export const outboxFile = (dir: string, agent: string, machine: string) => `${dir}/outbox-${agent}@${machine}.jsonl`;
function send($: Engine, legacy = false) {
    const c = cfg;
    if (!c)
        return;
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
            const argv = ['node', `${B.root}/hooks/send-analytics.mjs`, 'usage', outboxFile(c.dir, c.agent, c.machine), ...(legacy ? ['--legacy', c.dir] : [])];
            await $.process.run(argv, { timeoutMs: SEND_MS });
        }
        catch (err) {
            $.ui.log(`usage rows not sent this time (${String(err).slice(0, 120)}); they wait in the outbox`, { to: 'debug' });
        }
        finally {
            sending = false;
            if (again) {
                again = false;
                send($);
            }
        }
    })();
}
export function usageStart($: Engine, c: Config) {
    cfg = c.usage.enabled ? { dir: c.usage.dir, agent: c.agent, machine: c.machine } : null;
    send($, true);
}
export async function usageTurn($: Engine, e: TurnCompleteInput, kind: string, hook?: HookLink) {
    const c = cfg;
    if (!c)
        return;
    const at = await $.clock.now();
    const u = e.usage;
    const s = await $.session.usage().catch(() => undefined);
    const row = {
        id: 'u-' + crypto.randomUUID(),
        at: new Date(at).toISOString(),
        agent: c.agent,
        machine: c.machine,
        session: S.sessionId,
        turn: e.turnId,
        loop: e.agentId ?? 'main',
        kind: e.agentId ? 'subagent' : kind,
        reason: e.reason,
        model: u?.model ?? null,
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        durationMs: e.durationMs,
        context: s?.context?.tokens ?? null,
        costUsd: s?.cost?.usd ?? null,
        limits: Object.fromEntries((s?.rateLimits ?? []).map((r) => [r.kind, r.percentUsed])),
        helperMs: e.agentId ? null : takeHelperMs(),
    };
    const run = writing.then(() => appendText($, outboxFile(c.dir, c.agent, c.machine), JSON.stringify(row) + '\n'));
    writing = run.catch((err: unknown) => $.ui.log(`usage row not written: ${String(err).slice(0, 120)}`, { to: 'debug' }));
    await waitCapped($, writing, WRITE_WAIT_MS, hook);
    send($);
}
export async function usageRow($: Engine, r: Record<string, unknown>, hook?: HookLink) {
    const c = cfg;
    if (!c)
        return;
    const line = JSON.stringify({ ...r, agent: c.agent, machine: c.machine }) + '\n';
    const run = writing.then(() => appendText($, outboxFile(c.dir, c.agent, c.machine), line));
    writing = run.catch((err: unknown) => $.ui.log(`analytics row not written: ${String(err).slice(0, 120)}`, { to: 'debug' }));
    await waitCapped($, writing, WRITE_WAIT_MS, hook);
    send($);
}
