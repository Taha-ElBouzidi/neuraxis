import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const PRODUCT = 'Neuraxis';
export const PACKAGE_NAME = 'neuraxis';
export const OLD_PACKAGE_NAMES = ['infinite-context'];
export const PUBLIC_NAMES = [PACKAGE_NAME, ...OLD_PACKAGE_NAMES];
export const isPublicName = (name) => PUBLIC_NAMES.includes(String(name || ''));
export function isPublicInstall(brain) {
    try {
        return isPublicName(JSON.parse(readFileSync(join(brain, 'package.json'), 'utf8')).name);
    }
    catch {
        return false;
    }
}
export function envOf(env, key) {
    const e = env || {};
    const now = e['NEURAXIS_' + key];
    return now !== undefined ? now : e['INFINITE_CONTEXT_' + key];
}
