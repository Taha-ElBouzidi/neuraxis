import { openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = join(BRAIN, '.git', 'havok-write.lock');
const STALE_MS = 10 * 60 * 1000;
const WAIT_MS = 15 * 60 * 1000;
const UNREADABLE_GRACE_MS = 5000;
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
const BOOT = Date.now() - os.uptime() * 1000;
const BOOT_MARGIN_MS = 60000;
function tryTake(by) {
    const me = JSON.stringify({ pid: process.pid, host: os.hostname(), by, at: new Date().toISOString(), boot: Math.round(BOOT) });
    try {
        const fd = openSync(LOCK, 'wx');
        try {
            writeSync(fd, me);
        }
        finally {
            closeSync(fd);
        }
        return me;
    }
    catch (e) {
        if (e.code !== 'EEXIST')
            throw e;
    }
    let raw = '', holder = null, age = 0;
    try {
        raw = readFileSync(LOCK, 'utf8');
        holder = JSON.parse(raw);
    }
    catch { }
    try {
        age = Date.now() - statSync(LOCK).mtimeMs;
    }
    catch {
        return null;
    }
    const earlierBoot = holder && Number(holder.boot) > 0 && Math.abs(Number(holder.boot) - BOOT) > BOOT_MARGIN_MS;
    const dead = holder && holder.host === os.hostname() && (earlierBoot || !alive(holder.pid));
    if (dead || age > STALE_MS || (!holder && age > UNREADABLE_GRACE_MS)) {
        try {
            if (readFileSync(LOCK, 'utf8') === raw)
                unlinkSync(LOCK);
        }
        catch { }
    }
    return null;
}
function release(token) {
    try {
        if (readFileSync(LOCK, 'utf8') === token)
            unlinkSync(LOCK);
    }
    catch { }
}
function holderText() {
    try {
        const h = JSON.parse(readFileSync(LOCK, 'utf8'));
        return h.by + ' (pid ' + h.pid + ', since ' + h.at + ')';
    }
    catch {
        return 'unknown';
    }
}
const pause = (n) => Math.min(250 * n, 2000) + Math.floor(Math.random() * 200);
export function withBrainLockSync(by, fn, waitMs = WAIT_MS) {
    const until = Date.now() + waitMs;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    let token = null;
    for (let n = 1; !(token = tryTake(by)); n += 1) {
        if (Date.now() > until)
            throw new Error('brain write lock still held after ' + Math.round(waitMs / 1000) + ' s by ' + holderText());
        Atomics.wait(nap, 0, 0, pause(n));
    }
    try {
        return fn();
    }
    finally {
        release(token);
    }
}
export async function withBrainLock(by, fn, waitMs = WAIT_MS) {
    const until = Date.now() + waitMs;
    let token = null;
    for (let n = 1; !(token = tryTake(by)); n += 1) {
        if (Date.now() > until)
            throw new Error('brain write lock still held after ' + Math.round(waitMs / 1000) + ' s by ' + holderText());
        await new Promise((r) => setTimeout(r, pause(n)));
    }
    try {
        return await fn();
    }
    finally {
        release(token);
    }
}
