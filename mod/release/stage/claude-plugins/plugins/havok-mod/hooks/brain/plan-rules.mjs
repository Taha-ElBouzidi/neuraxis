export const PLANS = ['small', 'standard', 'large'];
export const DEFAULT_PLAN = 'small';
const LINES = {
    small: 'PLAN: SMALL (a plan with tight usage limits, such as 20 dollars a month). Start no helper agent (sub-agent)'
        + ' and no background task, loop or schedule unless the person asks for one in this conversation; do the work'
        + ' yourself, one step at a time. When they ask for a helper, start one at a time, on the small or balanced model'
        + ' with low effort. Use low or medium effort yourself, and keep the strongest model and high effort for what the'
        + ' person asks you to think hard about. This comes before any rule or method that says to split work into helpers.',
    standard: 'PLAN: STANDARD. Start a helper agent on your own only for a large task that splits into parts that do not'
        + ' depend on each other, at most two at a time, on the small or balanced model. No background task, loop or'
        + ' schedule the person did not ask for. Keep the strongest model and high effort for planning, hard bugs and'
        + ' decisions with real consequences.',
    large: 'PLAN: LARGE. Helper agents may run in the background and in parallel for parts of a task that do not depend'
        + ' on each other, each on the model its part needs; match the number of helpers to the size of the task, never'
        + ' more. Background tasks the person did not ask for are still only for work that needs them.',
};
export function planOf(cfg, publicInstall) {
    const p = cfg && typeof cfg.plan === 'string' ? cfg.plan.trim().toLowerCase() : '';
    if (PLANS.includes(p))
        return p;
    return publicInstall ? DEFAULT_PLAN : null;
}
export const planLine = (plan) => LINES[plan] || '';
export const SUB_AGENT_RULE = 'START HELPERS (SUB-AGENTS) ONLY AS THE PLAN LINE ALLOWS, AND GIVE EACH ONE A COMPLETE BRIEF. The PLAN line in your context says when you may start one on your own; on a small plan, only when the person asks. A helper does not get memory recall and does not see this conversation, so its brief must stand alone: the goal, the facts it needs (relevant memories copied in), exact paths, what it must not do, the output format, and how to check its own result. Check what every helper returns before relying on it.';
export const SUB_AGENT_SHORT = 'HELPERS (SUB-AGENTS) ONLY AS THE PLAN LINE ALLOWS (small plan: only when asked), EACH WITH A BRIEF THAT STANDS ALONE (goal, facts, exact paths, limits, output, self-check). Check what they return.';
export const OLD_SUB_AGENT_RULE = 'USE SUB-AGENTS FOR INDEPENDENT WORK, AND GIVE EACH ONE A COMPLETE BRIEF. When a task splits into parts that do not depend on each other, run them as sub-agents in the background and in parallel, so the conversation is never blocked. A sub-agent does not get memory recall and does not see this conversation, so its brief must stand alone: the goal, the facts it needs (relevant memories copied in), exact paths, what it must not do, the output format, and how to check its own result. Check what every sub-agent returns before relying on it.';
export const OLD_SUB_AGENT_SHORT = 'SPLIT INDEPENDENT WORK INTO SUB-AGENTS, EACH WITH A BRIEF THAT STANDS ALONE (goal, facts, exact paths, limits, output, self-check). Check what they return.';
export function migrateSubAgentRule(text) {
    const q = (s) => '"' + s.split('"').join('\\"') + '"';
    const oldRule = 'rule: ' + q(OLD_SUB_AGENT_RULE);
    if (!String(text).includes(oldRule))
        return null;
    let t = String(text).replace(oldRule, 'rule: ' + q(SUB_AGENT_RULE));
    t = t.replace('rule_short: ' + q(OLD_SUB_AGENT_SHORT), 'rule_short: ' + q(SUB_AGENT_SHORT));
    return t;
}
