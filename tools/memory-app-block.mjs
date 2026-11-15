import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function memoryAppRefusalFor(cfg, by) {
    const apps = Array.isArray(cfg && cfg.memoryWriteBlockedApps) ? cfg.memoryWriteBlockedApps.map((x) => String(x).toLowerCase()) : [];
    const app = String((by && by.app) || '').toLowerCase();
    if (!app || !apps.includes(app))
        return null;
    const to = typeof cfg.memoryWriteBlockedTo === 'string' && cfg.memoryWriteBlockedTo ? cfg.memoryWriteBlockedTo : 'the main agent';
    return { app, text: `Memories are not written from ${app} sessions on this brain yet (brain.json memoryWriteBlockedApps): nothing was saved or deleted. Send the fact to ${to} as a message, with its source and date; it saves it. Recall stays open to you.` };
}
export function memoryAppRefusal(brainDir, by) {
    let cfg = {};
    try {
        cfg = JSON.parse(readFileSync(join(brainDir, 'brain.json'), 'utf8'));
    }
    catch { }
    return memoryAppRefusalFor(cfg, by);
}
