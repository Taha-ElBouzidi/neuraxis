export type Limits = {
    remindAt: number;
    forceAt: number;
};
export type TurnEnd = {
    kind: 'none';
} | {
    kind: 'force';
} | {
    kind: 'note';
    text: string;
};
const fmt = (n: number) => n.toLocaleString('en-US');
export class ContextWatch {
    private remindArmed = true;
    private forceArmed = true;
    private midArmed = true;
    private deeperSent = false;
    private forced = false;
    private dipped = false;
    reset() {
        this.remindArmed = true;
        this.forceArmed = true;
        this.midArmed = true;
        this.deeperSent = false;
        this.forced = false;
        this.dipped = false;
    }
    private settle(tokens: number, l: Limits): boolean {
        const floor = l.remindAt || l.forceAt;
        if (!floor || tokens >= floor)
            return false;
        this.reset();
        return true;
    }
    afterStep(tokens: number, l: Limits): string {
        if (this.settle(tokens, l))
            return '';
        if (!l.forceAt || tokens < l.forceAt) {
            if (this.forced)
                this.dipped = true;
            return '';
        }
        if (this.forced && this.dipped)
            return this.deeper(tokens, l);
        if (!this.midArmed)
            return '';
        this.midArmed = false;
        return midTurnText(tokens, l);
    }
    afterTurn(tokens: number, l: Limits): TurnEnd {
        if (this.settle(tokens, l))
            return { kind: 'none' };
        if (!l.forceAt || tokens < l.forceAt) {
            if (this.forced)
                this.dipped = true;
            if (l.remindAt && tokens >= l.remindAt && this.remindArmed) {
                this.remindArmed = false;
                return { kind: 'note', text: reminderText(tokens, l) };
            }
            return { kind: 'none' };
        }
        if (this.forceArmed) {
            this.forceArmed = false;
            this.remindArmed = false;
            this.midArmed = false;
            this.forced = true;
            this.dipped = false;
            return { kind: 'force' };
        }
        if (this.forced && this.dipped) {
            const text = this.deeper(tokens, l);
            return text ? { kind: 'note', text } : { kind: 'none' };
        }
        return { kind: 'none' };
    }
    forceNotStarted() {
        this.forceArmed = true;
        this.forced = false;
    }
    private deeper(tokens: number, l: Limits): string {
        if (this.deeperSent)
            return '';
        this.deeperSent = true;
        this.midArmed = false;
        return deeperText(tokens, l);
    }
}
export function reminderText(tokens: number, l: Limits) {
    return `Havok context mod: your conversation holds about ${fmt(tokens)} tokens, past the ${fmt(l.remindAt)} reminder. Clean up when a good moment comes (context_map, then context_archive); at ${l.forceAt ? fmt(l.forceAt) : 'the limit'} the mod will ask for it.`;
}
export function midTurnText(tokens: number, l: Limits) {
    return `Havok context mod: during this turn your conversation passed ${fmt(l.forceAt)} tokens (about ${fmt(tokens)} now). Claude Code compacts by itself near its own limit with a summary you do not control. Without stopping your task, call context_map, then context_archive for finished work you no longer need word for word, then carry on. The archive applies when Claude Code compacts, or at the end of this turn.`;
}
export function deeperText(tokens: number, l: Limits) {
    return `Havok context mod: the last clean-up did not bring your conversation under ${fmt(l.remindAt || l.forceAt)} tokens, and it is past ${fmt(l.forceAt)} again (about ${fmt(tokens)}). Clean up deeper: call context_map and archive more of the finished work, enough to get under ${fmt(l.remindAt || l.forceAt)}. The mod starts no further clean-up turn before that.`;
}
