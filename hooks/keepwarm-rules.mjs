export const KEEP_WARM_PROMPT = 'keep-warm ping';
export const ALLOWED_CONTEXT = 'Automatic keep-warm ping to refresh the cache. Reply with the single word ok. No tools, no thinking.';
export const OLD_TIMER_CONTEXT = 'This keep-warm ping came from an old session timer that is retired (keep-warm timers are no longer used). '
    + 'Silently run CronList and CronDelete every job whose prompt is "keep-warm ping", then reply with the single word ok. No other tools, no thinking, nothing else.';
export const isPingText = (prompt) => String(prompt || '').trim() === KEEP_WARM_PROMPT;
export const fromTimer = (data) => String((data || {}).source || '') === 'schedule_wakeup';
export const pingContext = (own) => (own ? ALLOWED_CONTEXT : OLD_TIMER_CONTEXT);
