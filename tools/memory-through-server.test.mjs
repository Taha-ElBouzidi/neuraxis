import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(BRAIN, 'hooks', 'git').replace(/\\/g, '/');
const MEM = '---\nname: reference_x\ndescription: a test memory for the commit guard\ntype: reference\n---\nbody\n';
function repo(flag) {
    const root = mkdtempSync(join(tmpdir(), 'mem-guard-'));
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@x');
    git('config', 'core.hooksPath', HOOKS);
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'brain.json'), JSON.stringify(flag ? { memoryWritesThroughServer: true } : {}));
    mkdirSync(join(root, 'memory'));
    return { root, git };
}
function commit(root, env = {}) {
    const r = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: root, encoding: 'utf8', env: { ...process.env, HAVOK_BRAIN_SERVER_COMMIT: '', HAVOK_SAVE_FALLBACK: '', ...env } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
test('a hand commit that stages a memory is refused where memories go through the server', () => {
    const { root, git } = repo(true);
    try {
        writeFileSync(join(root, 'memory', 'reference_x.md'), MEM);
        git('add', '-A');
        const r = commit(root);
        assert.notEqual(r.code, 0);
        assert.match(r.out, /brain-client\.mjs write/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('the brain server and the save-brain fallback may commit a memory', () => {
    for (const env of [{ HAVOK_BRAIN_SERVER_COMMIT: '1' }, { HAVOK_SAVE_FALLBACK: '1' }]) {
        const { root, git } = repo(true);
        try {
            writeFileSync(join(root, 'memory', 'reference_x.md'), MEM);
            git('add', '-A');
            assert.equal(commit(root, env).code, 0, JSON.stringify(env));
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});
test('code and the generated MEMORY.md commit as before; a brain without the flag commits memories by hand', () => {
    const a = repo(true);
    try {
        writeFileSync(join(a.root, 'tool.mjs'), 'export const x = 1\n');
        writeFileSync(join(a.root, 'memory', 'MEMORY.md'), '# index\n');
        a.git('add', '-A');
        assert.equal(commit(a.root).code, 0);
    }
    finally {
        rmSync(a.root, { recursive: true, force: true });
    }
    const b = repo(false);
    try {
        writeFileSync(join(b.root, 'memory', 'reference_x.md'), MEM);
        b.git('add', '-A');
        assert.equal(commit(b.root).code, 0);
    }
    finally {
        rmSync(b.root, { recursive: true, force: true });
    }
});
test('a refused push with other changes in the tree leaves them alone: no rebase, no stash', () => {
    const base = mkdtempSync(join(tmpdir(), 'mem-push-'));
    try {
        const remote = join(base, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
        const clone = (name) => {
            const d = join(base, name);
            execFileSync('git', ['clone', '-q', remote, d], { stdio: 'ignore' });
            const git = (...a) => execFileSync('git', a, { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
            git('config', 'user.name', 't');
            git('config', 'user.email', 't@x');
            git('config', 'commit.gpgsign', 'false');
            return { d, git };
        };
        const a = clone('a');
        writeFileSync(join(a.d, 'shared.txt'), 'one\n');
        writeFileSync(join(a.d, 'brain.json'), '{}');
        a.git('add', '-A');
        a.git('commit', '-q', '-m', 'first');
        a.git('push', '-q', 'origin', 'master');
        const b = clone('b');
        writeFileSync(join(b.d, 'other.txt'), 'from b\n');
        b.git('add', '-A');
        b.git('commit', '-q', '-m', 'b');
        b.git('push', '-q', 'origin', 'master');
        a.git('config', 'core.hooksPath', HOOKS);
        writeFileSync(join(a.d, 'shared.txt'), 'one\nunsaved edit of another session\n');
        writeFileSync(join(a.d, 'mine.txt'), 'mine\n');
        a.git('add', 'mine.txt');
        const r = spawnSync('git', ['commit', '-q', '-m', 'mine'], { cwd: a.d, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(join(a.d, 'shared.txt'), 'utf8'), 'one\nunsaved edit of another session\n');
        assert.equal(a.git('stash', 'list').trim(), '');
        assert.match(String(r.stderr), /not rebasing/);
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
test('save-brain on such a host refuses memories and a save with no paths, and points to the brain server', () => {
    const { root } = repo(true);
    try {
        mkdirSync(join(root, 'tools'));
        for (const f of ['save-brain.mjs', 'brain-git-lock.mjs', 'public-install.mjs'])
            copyFileSync(join(BRAIN, 'tools', f), join(root, 'tools', f));
        const save = (...a) => spawnSync(process.execPath, [join(root, 'tools', 'save-brain.mjs'), ...a], { cwd: root, encoding: 'utf8' });
        for (const args of [['a memory'], ['a memory', 'memory/reference_x.md'], ['a memory', 'memory/']]) {
            const r = save(...args);
            assert.equal(r.status, 1, args.join(' '));
            assert.match(r.stderr, /brain-client\.mjs write/);
        }
        assert.equal(save('--fallback', 'msg').status, 1);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
