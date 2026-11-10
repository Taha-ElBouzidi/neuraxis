import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
export function compareVersions(a, b) {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i += 1)
        if ((x[i] || 0) !== (y[i] || 0))
            return (x[i] || 0) - (y[i] || 0);
    return 0;
}
export function releasePath(rest) {
    const m = /^(.+?)(\.zip)?$/.exec(String(rest));
    return m && VERSION_RE.test(m[1]) ? { version: m[1], zip: !!m[2] } : null;
}
export const zipName = (version) => 'havok-release-' + version + '.zip';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function readManifest(file) {
    try {
        const m = JSON.parse(readFileSync(file, 'utf8'));
        if (m && VERSION_RE.test(String(m.version)) && SHA_RE.test(String(m.sha256)) && Number.isInteger(m.size))
            return m;
    }
    catch { }
    return null;
}
export function releaseManifest(root, version) {
    if (!VERSION_RE.test(String(version)))
        return null;
    return readManifest(join(root, version, 'release.json'));
}
export function releaseZip(root, version) {
    const m = releaseManifest(root, version);
    if (!m)
        return null;
    const f = join(root, version, zipName(version));
    try {
        return statSync(f).size === m.size ? f : null;
    }
    catch {
        return null;
    }
}
export function releaseSummary(root) {
    const m = readManifest(join(root, 'latest.json'));
    if (!m || !releaseZip(root, m.version))
        return null;
    return { version: m.version, sha256: m.sha256, size: m.size, ...(m.signature ? { signature: m.signature } : {}) };
}
export function publishRelease(root, { zip, version, parts = {}, now = Date.now(), sign = null }) {
    if (!VERSION_RE.test(String(version)))
        throw new Error('bad version "' + String(version).slice(0, 40) + '": expected three numbers like 0.1.12');
    if (!zip || !existsSync(zip))
        throw new Error('no zip at ' + zip);
    const buf = readFileSync(zip);
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50)
        throw new Error(zip + ' is not a zip file');
    const latest = readManifest(join(root, 'latest.json'));
    if (latest && compareVersions(version, latest.version) <= 0)
        throw new Error('version ' + version + ' is not above the latest published release ' + latest.version);
    if (existsSync(join(root, version)))
        throw new Error('version ' + version + ' was already published once; publish a higher number');
    const manifest = { version, file: zipName(version), sha256: sha(buf), size: buf.length, publishedAt: new Date(now).toISOString(), parts: { mod: version, ...parts } };
    if (sign)
        manifest.signature = sign(manifest);
    mkdirSync(join(root, version), { recursive: true });
    copyFileSync(zip, join(root, version, zipName(version)));
    if (sha(readFileSync(join(root, version, zipName(version)))) !== manifest.sha256)
        throw new Error('the copied zip does not match its source');
    writeFileSync(join(root, version, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(root, 'latest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
    renameSync(join(root, 'latest.json.tmp'), join(root, 'latest.json'));
    return manifest;
}
