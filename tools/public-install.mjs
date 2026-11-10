// Which brain is an install of the public repository, under its current name or the one it had before.
//
// The product was renamed from Infinite Context to Neuraxis in 0.4.90 (the owner's decision, 2026-11-05). An install
// cloned before the rename has package.json name "infinite-context" until its first update; the update itself brings
// the new package.json. Every check that asks "is this an install of the public repository" goes through here, so an
// install keeps updating, keeps its kit and keeps its plan settings across the rename. The environment variables
// follow the same rule: the new NEURAXIS_ name first, the old INFINITE_CONTEXT_ name still read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRODUCT = 'Neuraxis';
export const PACKAGE_NAME = 'neuraxis';
export const OLD_PACKAGE_NAMES = ['infinite-context'];
export const PUBLIC_NAMES = [PACKAGE_NAME, ...OLD_PACKAGE_NAMES];

export const isPublicName = (name) => PUBLIC_NAMES.includes(String(name || ''));

export function isPublicInstall(brain) {
  try { return isPublicName(JSON.parse(readFileSync(join(brain, 'package.json'), 'utf8')).name); } catch { return false; }
}

// envOf(env, 'AUTO_UPDATE') reads NEURAXIS_AUTO_UPDATE, then INFINITE_CONTEXT_AUTO_UPDATE.
export function envOf(env, key) {
  const e = env || {};
  const now = e['NEURAXIS_' + key];
  return now !== undefined ? now : e['INFINITE_CONTEXT_' + key];
}
