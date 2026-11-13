#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
let c;
try {
    c = JSON.parse(readFileSync(join(HOME, '.neuraxis', 'messages', 'config.json'), 'utf8'));
}
catch {
    console.error('no settings: run node tools/setup-messages.mjs first');
    process.exit(2);
}
Object.assign(process.env, {
    MAIL_PORT: String(c.port || 8499),
    MAIL_HOST: String(c.host || '127.0.0.1'),
    MAIL_DATA_DIR: String(c.dataDir),
    MAIL_ROSTER: String(c.roster),
    MAIL_BRAIN_HOME: String(c.brainHome),
    MAIL_HOME_MACHINE: String(c.machine || ''),
});
process.chdir(String(c.service));
await import(pathToFileURL(join(String(c.service), 'server.mjs')).href);
