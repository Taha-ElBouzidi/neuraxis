// Release signatures (C2, system review 2026-11-09). A release manifest is trusted only when its signature verifies
// with the public key shipped in this brain (tools/release-signing-key.pub.pem), never because it came from the same
// folder as the zip: anyone who could write the release folder could change both. The private key is the vault secret
// release_signing_key, readable on the host only; release-publish.mjs signs with it.
//
// What is signed: one line per field, version, sha256 and size of the zip, so a signature cannot be moved to another
// zip or version. Ed25519.
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

// node tools/release-sign.mjs --check   (manifest JSON on stdin): exit 0 when its signature verifies, else 1. For the
// mod, which checks a release before it asks the updater to install it.
if (process.argv.includes('--check') && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let m = null;
  try { m = JSON.parse(readFileSync(0, 'utf8')); } catch { /* not a manifest */ }
  process.exit(verifyManifest(m) ? 0 : 1);
}

// True only for a manifest whose signature verifies with the given public key (or the shipped one).
export function verifyManifest(m, publicPem = existsSync(PUBLIC_KEY_FILE) ? readFileSync(PUBLIC_KEY_FILE, 'utf8') : '') {
  if (!publicPem || !m || typeof m.signature !== 'string' || !m.signature) return false;
  try { return verify(null, payloadOf(m), createPublicKey(publicPem), Buffer.from(m.signature, 'base64')); } catch { return false; }
}
