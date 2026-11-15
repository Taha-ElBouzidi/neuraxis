import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, buildReport, issueUrl } from './report-problem.mjs';
const env = { home: 'C:\\Users\\alice', user: 'alice', host: 'ALICE-PC' };
test('scrub replaces home folder, user, computer, mail, keys and memory names', () => {
    const t = scrub('C:\\Users\\alice\\neuraxis\\tools failed on ALICE-PC for alice (alice@example.com) token=abc123 '
        + 'key sk-ant1234567890abcdef and ' + 'Z'.repeat(40) + ' while reading memory/project_wedding_budget.md and C:/Users/alice/x', env);
    for (const bad of ['alice', 'ALICE-PC', 'example.com', 'abc123', 'sk-ant', 'ZZZZ', 'wedding'])
        assert.ok(!t.includes(bad), bad + ' left in: ' + t);
    assert.match(t, /<home>/);
    assert.match(t, /<machine>/);
    assert.match(t, /<email>/);
    assert.match(t, /<secret>/);
    assert.match(t, /<memory>/);
});
test('the report: what, version and track, system, command, the last 40 error lines, all scrubbed', () => {
    const err = Array.from({ length: 60 }, (_, i) => 'line ' + i + ' at C:\\Users\\alice\\neuraxis').join('\n');
    const r = buildReport({ what: 'update failed for alice', command: 'node tools/update.mjs', errorText: err, info: { version: '0.4.117', track: 'release', repo: 'o/r' }, env });
    assert.match(r.body, /0\.4\.117 \(update track release\)/);
    assert.match(r.body, /the last 40 of 60/);
    assert.ok(!r.body.includes('line 19 '), 'only the last 40 lines');
    assert.ok(r.body.includes('line 59'));
    assert.ok(!r.body.includes('alice') && !r.title.includes('alice'));
});
test('the issue address carries the labels and is cut to fit', () => {
    const u = issueUrl({ repo: 'o/r', title: 'Problem: x', body: 'b'.repeat(20000), version: '0.4.117' });
    assert.ok(u.startsWith('https://github.com/o/r/issues/new?template=problem-report.md&labels=problem-report%2Cv0.4.117&title='));
    assert.ok(u.length <= 7700, String(u.length));
    assert.match(decodeURIComponent(u), /cut to fit the address/);
});
