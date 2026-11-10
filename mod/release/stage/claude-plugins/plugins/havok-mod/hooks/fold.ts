import type { On } from 'claude-code';
import { PLUGIN, hasIdleMark } from './shared';
import { foldedRow } from './mail';
import { foldedNote, NOTE_TOOL, OPENING_AFTER_SUMMARY } from './context';
let fullView = false;
export const isFullView = () => fullView;
export function setFullViewForTests(v: boolean) { fullView = v; }
const OWN_TOOL = `mcp__${PLUGIN}__`;
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '...' : t);
export function promptLine(text: string): string | null {
    const t = String(text ?? '');
    const mail = foldedRow(t);
    if (mail)
        return mail;
    if (hasIdleMark(t))
        return 'Neuraxis mod: clean-up question (ctrl+o to read)';
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1 && t.length <= 120)
        return null;
    return `${cut(lines[0] ?? '', 100)} (ctrl+o to read)`;
}
export function foldRender(onHook: On) {
    onHook('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
        const x = (e.props as {
            isExpanded?: boolean;
        }).isExpanded;
        if (typeof x === 'boolean')
            fullView = x;
        return next(e);
    });
    onHook('ui.render', { component: 'ToolResult' }, ($, e, next) => {
        const p = e.props as {
            tool?: string;
            isExpanded?: boolean;
        };
        if (typeof p.isExpanded === 'boolean')
            fullView = p.isExpanded;
        if (p.isExpanded || p.tool !== NOTE_TOOL)
            return next(e);
        return next({ ...e, props: { ...p, output: 'the note (ctrl+o to read)' } } as typeof e);
    });
    onHook('ui.render', { component: 'ToolUse' }, ($, e, next) => {
        const p = e.props as {
            tool: string;
            input: unknown;
            isExpanded?: boolean;
        };
        if (typeof p.isExpanded === 'boolean')
            fullView = p.isExpanded;
        if (p.isExpanded || !String(p.tool ?? '').startsWith(OWN_TOOL) || p.tool === NOTE_TOOL)
            return next(e);
        return next({ ...e, props: { ...p, input: {} } } as typeof e);
    });
    onHook('ui.render', { component: 'UserMessage' }, ($, e, next) => {
        const p = e.props as {
            text: string;
            origin?: {
                kind?: string;
                name?: string;
            };
        };
        if (!fullView && String(p.text ?? '').trim() === OPENING_AFTER_SUMMARY.trim())
            return Fragment({});
        if (fullView || p.origin?.kind !== 'plugin' || p.origin.name !== PLUGIN)
            return next(e);
        const line = promptLine(p.text);
        return line ? next({ ...e, props: { ...p, text: line } } as typeof e) : next(e);
    });
    onHook('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
        const p = e.props as {
            text: string;
        };
        if (fullView)
            return next(e);
        const line = foldedNote(p.text);
        return line ? next({ ...e, props: { ...p, text: line } } as typeof e) : next(e);
    });
}
