import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicInstall, isPublicName, envOf } from './public-install.mjs';
import { noticeFor } from './update.mjs';
test('an install under the new name or the old one is a public install; any other name is not', () => {
    const d = mkdtempSync(join(tmpdir(), 'pub-'));
    try {
        for (const [name, want] of [['neuraxis', true], ['infinite-context', true], ['havok-brain', false], ['', false]]) {
            writeFileSync(join(d, 'package.json'), JSON.stringify({ name }));
            assert.equal(isPublicInstall(d), want, name);
        }
        assert.equal(isPublicInstall(join(d, 'missing')), false);
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
    assert.equal(isPublicName('neuraxis'), true);
});
test('the new environment variable wins and the old one is still read', () => {
    assert.equal(envOf({ NEURAXIS_AUTO_UPDATE: '0', INFINITE_CONTEXT_AUTO_UPDATE: '1' }, 'AUTO_UPDATE'), '0');
    assert.equal(envOf({ INFINITE_CONTEXT_AUTO_UPDATE: 'notify' }, 'AUTO_UPDATE'), 'notify');
    assert.equal(envOf({}, 'AUTO_UPDATE'), undefined);
});
test('the first update across the rename tells the person the new name once; later updates do not', () => {
    const across = noticeFor({ status: 'updated', from: '0.4.89', to: '0.4.90' });
    assert.match(across, /now called Neuraxis \(it was Infinite Context\)/);
    const later = noticeFor({ status: 'updated', from: '0.4.90', to: '0.4.91' });
    assert.doesNotMatch(later, /Infinite Context/);
    assert.match(later, /^NEURAXIS UPDATE/);
});
