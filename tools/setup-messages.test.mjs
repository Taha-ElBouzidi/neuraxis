import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'setup-messages.mjs');
test('the minimum Node for the messages service is 22.13 (or 23.4), the first versions with node:sqlite unflagged', async () => {
    const { nodeOk } = await import('../hooks/messages-client.mjs');
    for (const v of ['18.20.0', '20.18.0', '22.5.0', '22.12.0', '23.3.0'])
        assert.equal(nodeOk(v), false, v);
    for (const v of ['22.13.0', '22.20.1', '23.4.0', '24.14.0', '25.0.0'])
        assert.equal(nodeOk(v), true, v);
});
const SERVICE = [join(dirname(TOOL), '..', 'messages'), join(dirname(TOOL), '..', '..', 'MAILBOX')].find((d) => existsSync(join(d, 'server.mjs')));
test('--check names what it would do and writes nothing in a fresh home', { skip: !SERVICE }, () => {
    const home = mkdtempSync(join(tmpdir(), 'setupmsg-'));
    try {
        const r = spawnSync(process.execPath, [TOOL, '--check', '--service', SERVICE], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming') }, windowsHide: true });
        assert.match(r.stdout, /check only: nothing was changed/, r.stdout + r.stderr);
        assert.match(r.stdout, /would: .*havok-server-token/);
        assert.match(r.stdout, /would: roster: /);
        assert.equal(existsSync(join(home, '.neuraxis')), false);
        assert.deepEqual(readdirSync(home), []);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
