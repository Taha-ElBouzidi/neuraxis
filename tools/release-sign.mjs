import { sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PUBLIC_KEY_FILE = join(dirname(fileURLToPath(import.meta.url)), 'release-signing-key.pub.pem');
export const SECRET_NAME = 'release_signing_key';
export const payloadOf = (m) => Buffer.from(['havok-release', String(m.version), String(m.sha256), String(m.size)].join('\n'), 'utf8');
export function signManifest(m, privatePem) {
    return sign(null, payloadOf(m), createPrivateKey(privatePem)).toString('base64');
}
if (process.argv.includes('--check') && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let m = null;
    try {
        m = JSON.parse(readFileSync(0, 'utf8'));
    }
    catch { }
    process.exit(verifyManifest(m) ? 0 : 1);
}
export function verifyManifest(m, publicPem = existsSync(PUBLIC_KEY_FILE) ? readFileSync(PUBLIC_KEY_FILE, 'utf8') : '') {
    if (!publicPem || !m || typeof m.signature !== 'string' || !m.signature)
        return false;
    try {
        return verify(null, payloadOf(m), createPublicKey(publicPem), Buffer.from(m.signature, 'base64'));
    }
    catch {
        return false;
    }
}
