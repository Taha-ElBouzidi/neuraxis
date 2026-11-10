import type { Engine } from './shared';
export type ProofEvent = {
    at: number;
    kind: 'layers' | 'recall';
    ok: boolean;
};
export const PROOF_KEEP_MS = 48 * 3600000;
export const PROOF_MAX_EVENTS = 5000;
export const proofFile = (home: string) => `${home}/.claude/havok-mod/host-proof.json`;
export async function recordProof($: Engine, home: string, kind: ProofEvent['kind'], ok: boolean): Promise<void> {
    if (!home)
        return;
    try {
        const now = await $.clock.now();
        let events: ProofEvent[] = [];
        try {
            const v = JSON.parse(await $.fs.read(proofFile(home))) as {
                events?: ProofEvent[];
            };
            events = Array.isArray(v.events) ? v.events : [];
        }
        catch { }
        events = [...events.filter((e) => now - Number(e.at) < PROOF_KEEP_MS), { at: now, kind, ok }].slice(-PROOF_MAX_EVENTS);
        await $.fs.write(proofFile(home), JSON.stringify({ events }));
    }
    catch { }
}
