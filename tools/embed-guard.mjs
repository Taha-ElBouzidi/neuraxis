import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
export const ILLEGAL_INSTRUCTION = 3221225501;
export function probeKey() { return [platform(), process.version, (cpus()[0] && cpus()[0].model) || ''].join('|'); }
export const WASM_MODULE = fileURLToPath(new URL('./embed-wasm.mjs', import.meta.url));
const PROBE_SCRIPT = fileURLToPath(new URL('./embed-probe.mjs', import.meta.url));
export function savedBackend(stateFile) {
    try {
        const j = JSON.parse(readFileSync(stateFile, 'utf8'));
        return j.ok === probeKey() ? (j.backend === 'wasm' ? 'wasm' : 'native') : '';
    }
    catch {
        return '';
    }
}
function saveBackend(stateFile, backend) {
    if (!stateFile)
        return;
    try {
        writeFileSync(stateFile, JSON.stringify({ ok: probeKey(), backend, at: new Date().toISOString() }));
    }
    catch { }
}
export function probeBackendSync(stateFile, model, timeoutMs = 300000) {
    const known = savedBackend(stateFile);
    if (known)
        return known;
    for (const [backend, mod] of [['native', null], ['wasm', WASM_MODULE]]) {
        const r = spawnSync(process.execPath, [PROBE_SCRIPT, model].concat(mod ? [mod] : []), { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
        if (r.status === 0) {
            saveBackend(stateFile, backend);
            return backend;
        }
    }
    return '';
}
export function probeReason(code, signal, err) {
    if (code === ILLEGAL_INSTRUCTION || code === -1073741795)
        return 'the embedding model cannot run on this CPU (illegal instruction 0xC000001D: no AVX)';
    if (signal)
        return 'the embedding probe was ended by ' + signal;
    return 'the embedding probe failed (exit ' + code + (err ? ': ' + String(err).trim().slice(0, 160) : '') + ')';
}
export function makeGuardedEmbedder({ model, module, timeoutMs, loadTimeoutMs, onEvent = () => { }, probe = false, stateFile = '', probeScript = new URL('./embed-probe.mjs', import.meta.url) }) {
    let w = null, ready = false, loadTimer = null, seq = 0;
    let probeState = probe ? 'unknown' : 'ok';
    const canFallBack = probe && !module;
    if (probe && stateFile) {
        const known = savedBackend(stateFile);
        if (known) {
            probeState = 'ok';
            if (known === 'wasm' && canFallBack)
                module = WASM_MODULE;
        }
    }
    function runProbe() {
        probeState = 'running';
        onEvent(module === WASM_MODULE ? 'probe-wasm-start' : 'probe-start');
        let err = '';
        const args = [probeScript instanceof URL ? fileURLToPath(probeScript) : String(probeScript), model].concat(module ? [module] : []);
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const timer = setTimeout(() => { child.kill(); }, loadTimeoutMs);
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); probeState = 'the embedding probe could not start: ' + String(e && e.message).slice(0, 120); onEvent('probe-failed'); });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) {
                probeState = 'ok';
                onEvent('probe-ok');
                saveBackend(stateFile, module === WASM_MODULE ? 'wasm' : 'native');
            }
            else if (canFallBack && module !== WASM_MODULE) {
                onEvent('probe-failed');
                module = WASM_MODULE;
                runProbe();
            }
            else {
                probeState = probeReason(code, signal, err);
                onEvent('probe-failed');
            }
        });
    }
    const pending = new Map();
    function drop(reason) {
        if (loadTimer) {
            clearTimeout(loadTimer);
            loadTimer = null;
        }
        const old = w;
        w = null;
        ready = false;
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.fail(new Error(reason));
        }
        pending.clear();
        if (old)
            old.terminate().catch(() => { });
    }
    function start() {
        const me = new Worker(new URL('./embed-worker.mjs', import.meta.url), { workerData: { model, module } });
        w = me;
        loadTimer = setTimeout(() => { if (w === me && !ready) {
            onEvent('load-timeout');
            drop('the embedding model did not load in ' + loadTimeoutMs + ' ms');
        } }, loadTimeoutMs);
        me.on('message', (m) => {
            if (w !== me)
                return;
            if (m.ready) {
                ready = true;
                clearTimeout(loadTimer);
                loadTimer = null;
                return;
            }
            if (m.loadError) {
                onEvent('load-failed');
                drop('the embedding model failed to load: ' + m.loadError.slice(0, 120));
                return;
            }
            const p = pending.get(m.id);
            if (!p)
                return;
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error)
                p.fail(new Error(m.error));
            else
                p.ok({ data: m.data });
        });
        me.on('error', (e) => { if (w === me)
            drop('the embedding worker failed: ' + String(e && e.message).slice(0, 120)); });
        me.on('exit', (code) => { if (w === me)
            drop('the embedding worker exited with code ' + code); });
    }
    function embed(text, opts) {
        if (probeState !== 'ok') {
            if (probeState === 'unknown')
                runProbe();
            return Promise.reject(new Error(probeState === 'running' ? 'the embedding model is being checked on this machine' : probeState));
        }
        if (!w)
            start();
        const me = w;
        return new Promise((ok, fail) => {
            const id = ++seq;
            const timer = setTimeout(() => {
                pending.delete(id);
                if (w === me && ready) {
                    onEvent('stuck');
                    fail(new Error('an embedding gave no answer in ' + timeoutMs + ' ms'));
                    drop('the embedding worker was restarted after a call gave no answer in ' + timeoutMs + ' ms');
                }
                else {
                    fail(new Error('the embedding model was still loading after ' + timeoutMs + ' ms'));
                }
            }, timeoutMs);
            pending.set(id, { ok, fail, timer });
            me.postMessage({ id, text, opts });
        });
    }
    return { embed, close: () => drop('the embedder was closed'), state: () => (probeState !== 'ok' ? 'probe: ' + probeState : w ? (ready ? 'ready' : 'loading') : 'idle') };
}
