import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryAppRefusalFor } from './memory-app-block.mjs';
import { appFromChain } from './provenance.mjs';
const cfg = { memoryWriteBlockedApps: ['codex', 'agy'], memoryWriteBlockedTo: 'lead@HOME' };
test('a listed app is refused with where to send the fact; others and unknown pass', () => {
    const r = memoryAppRefusalFor(cfg, { app: 'codex' });
    assert.equal(r.app, 'codex');
    assert.match(r.text, /nothing was saved or deleted/);
    assert.match(r.text, /lead@HOME/);
    assert.equal(memoryAppRefusalFor(cfg, { app: 'AGY' }).app, 'agy');
    assert.equal(memoryAppRefusalFor(cfg, { app: 'claude' }), null);
    assert.equal(memoryAppRefusalFor(cfg, { app: '' }), null);
    assert.equal(memoryAppRefusalFor(cfg, undefined), null);
    assert.equal(memoryAppRefusalFor({}, { app: 'codex' }), null, 'no list in brain.json: nothing blocked');
    assert.match(memoryAppRefusalFor({ memoryWriteBlockedApps: ['codex'] }, { app: 'codex' }).text, /the main agent/);
});
test('the app is the nearest assistant program above the writing process', () => {
    const procs = [
        { pid: 1, ppid: 0, name: 'explorer.exe' },
        { pid: 10, ppid: 1, name: 'claude.exe' },
        { pid: 11, ppid: 10, name: 'bash.exe' },
        { pid: 12, ppid: 11, name: 'node.exe' },
        { pid: 13, ppid: 12, name: 'agy.exe' },
        { pid: 14, ppid: 13, name: 'powershell.exe' },
        { pid: 15, ppid: 14, name: 'node.exe' },
        { pid: 20, ppid: 1, name: 'codex' },
        { pid: 21, ppid: 20, name: 'node' },
    ];
    assert.equal(appFromChain(procs, 12), 'claude', 'a Claude session\'s own command');
    assert.equal(appFromChain(procs, 15), 'agy', 'an agy helper started by a Claude session');
    assert.equal(appFromChain(procs, 21), 'codex');
    assert.equal(appFromChain(procs, 1), '');
    assert.equal(appFromChain([{ pid: 5, ppid: 6, name: 'a' }, { pid: 6, ppid: 5, name: 'b' }], 5), '', 'a loop ends');
});
