import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const file = args[0];
const at = args.indexOf('--marketplace');
const problems = [];
let raw = '';
try {
    raw = readFileSync(file, 'utf8');
}
catch (e) {
    console.log('FAIL: cannot read ' + file + ': ' + e.message);
    process.exit(1);
}
if (raw.charCodeAt(0) === 0xfeff) {
    console.log('FAIL: the file starts with a byte order mark');
    process.exit(1);
}
let j = null;
try {
    j = JSON.parse(raw);
}
catch (e) {
    console.log('FAIL: not JSON: ' + e.message);
    process.exit(1);
}
if (raw.replace(/\r?\n$/, '') !== JSON.stringify(j, null, 2))
    problems.push('the text is not the canonical form the build writes (a duplicate key, or a hand edit)');
const keys = Object.keys(j ?? {}).sort().join(',');
if (keys !== 'enabledPlugins,extraKnownMarketplaces,prependPlugins')
    problems.push(`keys are "${keys}", only enabledPlugins, extraKnownMarketplaces, prependPlugins are allowed`);
const mk = j?.extraKnownMarketplaces ?? {};
if (Object.keys(mk).join(',') !== 'havok-org')
    problems.push('extraKnownMarketplaces must hold havok-org only');
if (Object.keys(mk['havok-org'] ?? {}).join(',') !== 'source')
    problems.push('the havok-org entry must hold source only');
const src = mk['havok-org']?.source;
if (src?.source !== 'directory' || Object.keys(src ?? {}).sort().join(',') !== 'path,source')
    problems.push('havok-org must be { source: { source: "directory", path } }');
if (src?.path !== 'C:\\Program Files\\Havok\\claude-plugins')
    problems.push(`the marketplace path is "${src?.path}", expected C:\\Program Files\\Havok\\claude-plugins`);
if (JSON.stringify(j?.enabledPlugins) !== '{"havok-mod@havok-org":true}')
    problems.push('enabledPlugins must be exactly { "havok-mod@havok-org": true }');
if (JSON.stringify(j?.prependPlugins) !== '["havok-mod@havok-org","sec-default@builtin"]')
    problems.push('prependPlugins must be exactly ["havok-mod@havok-org", "sec-default@builtin"] (our mod first, then the guard)');
const market = at >= 0 ? args[at + 1] : src?.path;
const mfile = market && join(market, '.claude-plugin', 'marketplace.json');
if (!mfile || !existsSync(mfile))
    problems.push(`no marketplace at ${mfile}`);
else {
    let m = null;
    try {
        m = JSON.parse(readFileSync(mfile, 'utf8'));
    }
    catch (e) {
        problems.push('marketplace.json is not JSON: ' + e.message);
    }
    const entry = m?.plugins?.find((p) => p.name === 'havok-mod');
    if (m?.name !== 'havok-org')
        problems.push('the marketplace is not named havok-org');
    if ((m?.plugins ?? []).length !== 1)
        problems.push('the marketplace must list havok-mod only');
    if (!entry || entry.source !== './plugins/havok-mod')
        problems.push('havok-mod must be listed as ./plugins/havok-mod');
    else {
        const dir = join(market, entry.source);
        for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'])
            if (!existsSync(join(dir, f)))
                problems.push(`the plugin lacks ${f}`);
        let hooks = null;
        try {
            hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8'));
        }
        catch {
            hooks = null;
        }
        if (JSON.stringify(hooks) !== '{"modules":["./register.ts"]}')
            problems.push('the plugin\'s hooks.json must be exactly { "modules": ["./register.ts"] }');
    }
}
if (problems.length) {
    console.log('FAIL: ' + problems.join('; '));
    process.exit(1);
}
console.log(`OK: ${file} is valid JSON with only the three keys; havok-mod@havok-org first, sec-default@builtin after it; marketplace found at ${market}`);
