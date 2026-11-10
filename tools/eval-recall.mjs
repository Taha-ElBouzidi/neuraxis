import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(BRAIN, 'hooks', 'pre-turn.mjs');
import { existsSync as __ex, readFileSync as __rf } from 'node:fs';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn, resolve as __rs, join as __jn } from 'node:path';
const __BRAIN = __rs(__dn(__fu(import.meta.url)), '..');
const GENERIC_CASES = [
    ['do not say it is fixed before testing it', ['feedback_verify_before_claiming']],
    ['tell me straight away when memory is unreachable', ['feedback_say_when_the_brain_is_down']],
    ['open the memory file instead of the one line summary', ['feedback_open_the_memory_not_the_description']],
    ['save what you learn as you learn it', ['feedback_write_it_the_moment_you_learn_it']],
    ['just do it if it can be undone, ask if it cannot', ['feedback_reversible_act_irreversible_ask']],
    ['which model should I use for this', ['feedback_best_model_for_each_task']],
    ['how do I brief an agent running in the background', ['feedback_sub_agents_get_a_ready_brief']],
    ['there are two notes saying different things about the same fact', ['feedback_one_fact_one_memory']],
    ['make me some slides for the investor meeting on friday', ['reference_how_to_make_a_presentation_deck']],
    ['turn this into a clean pdf report I can print and send', ['reference_how_to_make_a_printable_document']],
    ['can you draft a proposal for the new client', ['reference_how_to_write_a_document']],
    ['find out which accounting software is best for a small shop and how much it costs', ['reference_how_to_research_with_sources']],
    ['split this into parallel agents so it goes faster', ['reference_how_to_brief_sub_agents_and_pick_models']],
    ['remember that my accountant is called Sara', ['reference_how_to_save_a_memory']],
    ['build the export feature for the app', ['reference_how_to_plan_test_and_verify']],
    ['the script crashes with a null error every time I run it', ['reference_how_to_debug_systematically']],
    ['is the analysis finished and correct, can I send it', ['reference_how_to_review_work_before_calling_it_done']],
    ['I want to lose 5 kilos before summer', ['reference_how_to_set_and_follow_a_goal']],
    ['prep me for my call with the supplier tomorrow', ['reference_how_to_handle_meetings_and_follow_ups']],
    ['set up a folder to track my job applications', ['reference_how_to_start_a_new_project']],
    ['change your name and answer me in french from now on', ['reference_how_to_set_up_the_assistant']],
    ['I keep asking you to do the weekly report the same way, keep that', ['reference_how_to_turn_a_repeated_task_into_a_method']],
    ['reply to the landlord email about the deposit', ['reference_how_to_write_an_email']],
    ['send a cold email to a supplier we have never worked with', ['reference_how_to_write_a_first_message_to_someone_new']],
    ['text my brother on whatsapp that I will be late tonight', ['reference_how_to_write_chat_messages']],
    ['make a short explainer video for the new feature', ['reference_how_to_make_a_video_presentation']],
    ['read me this summary as audio while I drive', ['reference_how_to_make_voice_audio']],
    ['write the system prompt that all my agents will share', ['reference_how_to_write_a_context']],
    ['add this rule to the global context so every machine sees it', ['reference_how_to_use_shared_contexts']],
    ['this conversation is huge, archive the old parts', ['reference_how_to_clean_up_the_context']],
    ['recall is not working, what do you remember about this', ['reference_how_to_use_the_brain']],
    ['store this api key somewhere safe', ['reference_how_to_use_the_vault']],
    ['clone the repo from our own git server and push the fix', ['reference_how_to_use_the_git_server']],
    ['ask the agent on the other machine to check its logs', ['reference_how_to_message_another_agent']],
];
const casesFlag = process.argv.indexOf('--cases');
const CASES_FILE = casesFlag > -1 ? process.argv[casesFlag + 1] : null;
const MULTIHOP = process.argv.includes('--multihop') || !!CASES_FILE;
const REAL = process.argv.includes('--real');
export const CASES = CASES_FILE ? JSON.parse(__rf(CASES_FILE, 'utf8'))
    : MULTIHOP
        ? JSON.parse(__rf(__jn(__BRAIN, 'eval-multihop.json'), 'utf8'))
        : REAL ? JSON.parse(__rf(__jn(__BRAIN, 'eval-single-real.json'), 'utf8'))
            : __ex(__jn(__BRAIN, 'eval-cases.json'))
                ? JSON.parse(__rf(__jn(__BRAIN, 'eval-cases.json'), 'utf8'))
                : GENERIC_CASES;
let hits = 0, misses = [], totalMs = 0, totalTokens = 0, silent = 0, returnedTotal = 0, pieces = 0, piecesFound = 0;
const paceFlag = process.argv.indexOf('--pace');
const PACE_MS = paceFlag > -1 ? Number(process.argv[paceFlag + 1]) : 1600;
const pause = (ms) => { if (ms > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
for (const [q, expected, context] of CASES) {
    pause(PACE_MS);
    const t0 = Date.now();
    const payload = context ? { prompt: q, context } : { prompt: q };
    const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    const ms = Date.now() - t0;
    totalMs += ms;
    let ctx = '';
    try {
        ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '';
    }
    catch { }
    totalTokens += Math.round(ctx.length / 4);
    const returned = ctx.split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).replace(/^\[(keyword|meaning|both|linked)\]\s*/, '').split(':')[0].trim());
    if (!returned.length)
        silent++;
    returnedTotal += returned.length;
    pieces += expected.length;
    piecesFound += expected.filter((e) => returned.includes(e)).length;
    const hit = MULTIHOP ? expected.every((e) => returned.includes(e)) : expected.some((e) => returned.includes(e));
    if (hit)
        hits++;
    else
        misses.push({ q, expected, returned });
}
const n = CASES.length;
console.log(`queries          ${n}`);
console.log(`${MULTIHOP ? 'all found       ' : 'recall@5        '} ${hits}/${n} = ${(100 * hits / n).toFixed(1)}%`);
console.log(`memories         ${(returnedTotal / n).toFixed(1)} avg per prompt`);
if (MULTIHOP)
    console.log(`pieces found     ${piecesFound}/${pieces} = ${(100 * piecesFound / pieces).toFixed(1)}%`);
console.log(`returned nothing ${silent}`);
console.log(`latency          ${(totalMs / n).toFixed(0)}ms avg per prompt`);
console.log(`injected         ${Math.round(totalTokens / n)} tokens avg per prompt`);
console.log(`\nMISSES (${misses.length}):`);
for (const m of misses) {
    console.log(`  "${m.q}"`);
    console.log(`     wanted : ${m.expected.join(' | ')}`);
    console.log(`     got    : ${m.returned.length ? m.returned.join(', ') : '(nothing)'}`);
}
