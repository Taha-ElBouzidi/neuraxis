import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2] || join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const edits = [
    ['known_marketplaces.json', (j) => j, 'havok-org'],
    ['installed_plugins.json', (j) => j.plugins, 'havok-mod@havok-org'],
];
for (const [name, holder, key] of edits) {
    const file = join(dir, 'plugins', name);
    if (!existsSync(file))
        continue;
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(text);
    const h = holder(j);
    if (!h || typeof h !== 'object' || !Object.prototype.hasOwnProperty.call(h, key))
        continue;
    copyFileSync(file, `${file}.bak-${stamp}`);
    delete h[key];
    writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
    console.log(`${key} removed from ${file} (backup ${file}.bak-${stamp})`);
}
