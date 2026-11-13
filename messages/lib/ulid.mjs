import { randomBytes } from 'node:crypto';
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRand = null;
function encodeTime(ms) {
    let out = '';
    for (let i = 0; i < 10; i++) {
        out = ENC[ms % 32] + out;
        ms = Math.floor(ms / 32);
    }
    return out;
}
function encodeRand(bytes) {
    let n = 0n;
    for (const b of bytes)
        n = (n << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < 16; i++) {
        out = ENC[Number(n & 31n)] + out;
        n >>= 5n;
    }
    return out;
}
function increment(bytes) {
    const next = Buffer.from(bytes);
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i] < 255) {
            next[i]++;
            return next;
        }
        next[i] = 0;
    }
    throw new Error('ulid random part overflowed inside one millisecond');
}
export function ulid(now = Date.now()) {
    let rand;
    if (now <= lastTime) {
        now = lastTime;
        rand = increment(lastRand);
    }
    else
        rand = randomBytes(10);
    lastTime = now;
    lastRand = rand;
    return encodeTime(now) + encodeRand(rand);
}
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
