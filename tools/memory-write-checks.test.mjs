import test from 'node:test';
import assert from 'node:assert/strict';
import { writeChecks } from './memory-write-checks.mjs';
const HEAD = 'name: reference_x\ndescription: d\ntype: reference\nmetadata:\n  type: reference\n  asserted: 2026-11-14\n';
const DESC = 'How the living room TV switches to the PS5, and what to do when it does not';
const BODY = 'The TV switches to the PS5 through TCL T-Link. Source: The person, 2026-11-14. Applies to the living room TV, because the PS5 is on HDMI 1.';
test('a complete memory passes with no warning', () => {
    assert.deepEqual(writeChecks({ head: HEAD, body: BODY, desc: DESC }), { warnings: [] });
});
test('a short description, a missing asserted date and a thin body are refused, each with a reason', () => {
    assert.equal(writeChecks({ head: HEAD, body: BODY, desc: 'TV and PS5' }).refuse.error, 'thin description');
    assert.equal(writeChecks({ head: HEAD.replace('  asserted: 2026-11-14\n', ''), body: BODY, desc: DESC }).refuse.error, 'missing asserted date');
    assert.equal(writeChecks({ head: HEAD, body: 'See [[reference_living_room_tv]].', desc: DESC }).refuse.error, 'thin body');
});
test('a body with no source passes with a warning', () => {
    const r = writeChecks({ head: HEAD, body: 'The TV switches to the PS5 through T-Link on HDMI 1, and it puts the PS5 to sleep when the TV goes off at night.', desc: DESC });
    assert.equal(r.refuse, undefined);
    assert.match(r.warnings[0], /no source named/);
});
