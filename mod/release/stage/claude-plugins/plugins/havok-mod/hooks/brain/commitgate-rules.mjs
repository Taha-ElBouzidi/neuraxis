export const COMMIT_CMD = /\bgit\b[^|;&]*\bcommit\b/;
export const VERIFY_MS = 120000;
export function needsVerify(stagedNames) {
    const files = String(stagedNames || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const touchesRules = files.some((f) => f === 'index/rules.json' || (f.startsWith('memory/') && f.endsWith('.md')));
    const risky = files.filter((f) => !/^(memory|index)\//.test(f));
    return { files, risky, verify: files.length > 0 && (risky.length > 0 || touchesRules) };
}
export function failedReason(riskyCount, detail) {
    return 'Brain verification FAILED, commit blocked. This commit touches ' + riskyCount
        + ' non-memory file(s) and would leave the shared brain broken for every machine.\n\n' + detail + '\n\nFix, then re-run: node tools/verify.mjs';
}
export const HUNG_REASON = 'Brain verification did not finish within 120 s, so this commit was not checked and did not run. Run node tools/verify.mjs to see what hangs, then commit again.';
