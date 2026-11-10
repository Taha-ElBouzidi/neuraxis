import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
const c = {
    reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[96m", white: "\x1b[97m", blue: "\x1b[94m",
    green: "\x1b[92m", yellow: "\x1b[33m", red: "\x1b[91m", orange: "\x1b[38;5;208m",
};
const sep = `${c.dim} | ${c.reset}`;
const level = (p) => (p >= 80 ? c.red : p >= 50 ? c.yellow : c.green);
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function gitBranch(start) {
    try {
        let dir = resolve(start);
        for (let i = 0; i < 25; i++) {
            const git = join(dir, ".git");
            if (existsSync(git)) {
                let head = join(git, "HEAD");
                if (!statSync(git).isDirectory()) {
                    const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m);
                    if (!m)
                        return "";
                    head = join(m[1].trim(), "HEAD");
                }
                const ref = readFileSync(head, "utf8").trim();
                const b = ref.match(/refs\/heads\/(.+)$/);
                return b ? b[1] : ref.slice(0, 7);
            }
            const up = dirname(dir);
            if (up === dir)
                return "";
            dir = up;
        }
    }
    catch { }
    return "";
}
function bar(pct, cleanedAt) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const filled = Math.floor(p / 10);
    const col = level(p);
    return `${col}${"█".repeat(filled)}${c.dim}${"░".repeat(10 - filled)}${c.reset} ${col}${p}%${c.reset}${cleanedAt ? ` ${c.blue}${cleanedAt}${c.reset}` : ""}`;
}
const RESERVE_BAR = 95;
function limit(label, w, withDay, reserved = false) {
    if (!w || typeof w.used_percentage !== "number")
        return "";
    const p = Math.round(w.used_percentage);
    let clock = "";
    if (w.resets_at) {
        const d = new Date(w.resets_at * 1000);
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        clock = ` ${c.blue}${withDay ? days[d.getDay()] + " " : ""}${hhmm(d)}${c.reset}`;
    }
    if (reserved && w.used_percentage >= RESERVE_BAR)
        return `${c.red}${label} ${p}% reserved${c.reset}${clock}`;
    return `${c.dim}${label}${c.reset} ${level(p)}${p}%${c.reset}${clock}`;
}
let raw = "";
try {
    raw = readFileSync(0, "utf8");
}
catch { }
let d = {};
try {
    d = JSON.parse(raw.replace(/^﻿/, "").trim() || "{}");
}
catch { }
const parts = [];
const top = [];
const model = (d.model?.display_name || "").replace(" (1M context)", " 1M");
const effort = d.effort?.level ? ` ${c.dim}${d.effort.level}${c.reset}` : "";
const modelAt = parts.length;
if (model)
    parts.push(`${c.orange}${model}${c.reset}${effort}`);
const cwd = d.workspace?.current_dir || d.cwd || "";
if (cwd) {
    const branch = gitBranch(cwd);
    parts.push(`${c.cyan}${basename(cwd) || cwd}${c.reset}${branch ? ` ${c.white}${branch}${c.reset}` : ""}`);
}
let mod = null, modOff = false;
{
    const sid = String(d.session_id || "");
    try {
        if (/^[A-Za-z0-9_-]{6,80}$/.test(sid)) {
            const f = join(process.env.USERPROFILE || process.env.HOME || homedir(), ".claude", "havok-mod", "status", sid + ".json");
            if (existsSync(f)) {
                mod = JSON.parse(readFileSync(f, "utf8"));
                let wrote = 0;
                try {
                    if (d.transcript_path)
                        wrote = statSync(d.transcript_path).mtimeMs;
                }
                catch { }
                modOff = wrote - Date.parse(mod.at) > 2 * 60 * 1000;
            }
            else {
                const home = process.env.USERPROFILE || process.env.HOME || homedir();
                let machine = null;
                try {
                    machine = JSON.parse(readFileSync(join(home, ".claude", "havok-mod", "machine.json"), "utf8"));
                }
                catch { }
                if (machine && typeof machine === "object" && !Array.isArray(machine) && machine.keepPreTurn !== true && d.transcript_path && existsSync(d.transcript_path)) {
                    const wrote = statSync(d.transcript_path).mtimeMs;
                    const alive = join(home, ".claude", "havok-mod", "alive", sid + ".json");
                    modOff = !existsSync(alive) || wrote - statSync(alive).mtimeMs > 2 * 60 * 1000;
                }
            }
        }
    }
    catch {
        mod = null;
    }
}
{
    const own = mod && !modOff && mod.own && typeof mod.own === "object" ? mod.own : null;
    if (own && (own.model || own.effort)) {
        const fam = (m) => (/fable/i.test(m) ? "Fable" : /opus/i.test(m) ? "Opus" : /sonnet/i.test(m) ? "Sonnet" : /haiku/i.test(m) ? "Haiku" : m);
        const name = own.model ? fam(String(own.model)) : model;
        const lvl = own.effort || d.effort?.level || "";
        const text = `${c.orange}${name}${c.reset}${lvl ? ` ${c.dim}${lvl}${c.reset}` : ""} ${c.dim}(own)${c.reset}`;
        if (model)
            parts[modelAt] = text;
        else
            parts.splice(modelAt, 0, text);
    }
}
let backupArmed = false;
{
    const sid = String(d.session_id || "");
    const userHome = process.env.USERPROFILE || process.env.HOME || homedir();
    if (/^[A-Za-z0-9_-]{6,80}$/.test(sid)) {
        const f = join(userHome, ".claude", "havok-backup-armed", sid + ".json");
        let cur = null;
        try {
            cur = JSON.parse(readFileSync(f, "utf8"));
        }
        catch { }
        const now = Date.now();
        const firstLook = !!(modOff && !(cur && cur.armed === true) && !(cur && Number(cur.suspect) > 0 && now - Number(cur.suspect) >= 30000));
        if (firstLook && !(cur && Number(cur.suspect) > 0)) {
            try {
                mkdirSync(dirname(f), { recursive: true });
                writeFileSync(f, JSON.stringify({ armed: false, suspect: now, at: new Date(now).toISOString() }));
                cur = { armed: false, suspect: now };
            }
            catch { }
        }
        else if (!modOff && cur && Number(cur.suspect) > 0 && cur.armed !== true) {
            try {
                writeFileSync(f, JSON.stringify({ armed: false, at: new Date(now).toISOString() }));
            }
            catch { }
        }
        if (firstLook)
            modOff = false;
        else if (modOff && !(cur && cur.armed === true)) {
            try {
                mkdirSync(dirname(f), { recursive: true });
                writeFileSync(f, JSON.stringify({ armed: true, why: "status line: havok-mod off in this session", at: new Date().toISOString() }));
                cur = { armed: true };
                let plugin = "";
                try {
                    plugin = String((JSON.parse(readFileSync(join(userHome, ".claude", "plugins", "installed_plugins.json"), "utf8"))?.plugins?.["havok-brain@havok-brain"] || []).find((x) => x && x.installPath)?.installPath || "");
                }
                catch { }
                let brain = "";
                try {
                    brain = readFileSync(join(userHome, ".claude", "havok-brain-path"), "utf8").split(/\r?\n/)[0].trim();
                }
                catch { }
                const tool = [plugin, brain].filter(Boolean).map((p) => join(p, "tools", "backup-arm.mjs")).find((t) => existsSync(t));
                if (tool)
                    spawn(process.execPath, [tool, "recompute"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
            }
            catch { }
        }
        backupArmed = !!(cur && cur.armed === true);
    }
}
{
    let pct = typeof d.context_window?.used_percentage === "number" ? d.context_window.used_percentage : null;
    const own = mod && !modOff ? mod.context : null;
    if (own && own.window > 0 && own.tokens >= 0)
        pct = (own.tokens / own.window) * 100;
    const at = mod && !modOff && mod.cleanedAt ? new Date(mod.cleanedAt) : null;
    if (pct !== null)
        parts.push(`${c.dim}ctx${c.reset} ${bar(pct, at && !isNaN(at) ? hhmm(at) : "")}`);
}
const firstLineParts = parts.length;
{
    const mark = join(process.env.USERPROFILE || homedir(), ".claude", "havok-remote-embed-down");
    let seg = `${c.dim}brain${c.reset} ${c.green}on${c.reset}`;
    try {
        if (existsSync(mark)) {
            const t = statSync(mark).mtimeMs;
            seg = Date.now() - t < 10 * 60 * 1000
                ? `${c.dim}brain${c.reset} ${c.red}offline since ${hhmm(new Date(t))}${c.reset}`
                : `${c.dim}brain${c.reset} ${c.yellow}retrying (failed ${hhmm(new Date(t))})${c.reset}`;
        }
    }
    catch { }
    parts.push(seg);
}
const proxyFile = (() => {
    try {
        return String(JSON.parse(readFileSync(join(process.env.USERPROFILE || process.env.HOME || homedir(), ".claude", "havok-mod", "machine.json"), "utf8")).checks?.proxyStateFile || "");
    }
    catch {
        return "";
    }
})();
if (proxyFile && existsSync(proxyFile)) {
    let seg = `${c.dim}VPN${c.reset} ${c.dim}?${c.reset}`;
    try {
        const s = JSON.parse(readFileSync(proxyFile, "utf8"));
        const age = Date.now() - Number(s.at || 0);
        if (age > 4 * 60 * 1000)
            seg = `${c.dim}VPN${c.reset} ${c.yellow}? ${hhmm(new Date(Number(s.at)))}${c.reset}`;
        else if (s.ok)
            seg = `${c.dim}VPN${c.reset} ${c.green}on${c.reset}`;
        else
            seg = `${c.dim}VPN${c.reset} ${c.red}OFF ${s.checked || ""}${c.reset}`;
        if (s.machineExit && age <= 4 * 60 * 1000)
            seg += ` ${c.yellow}exit ON${c.reset}`;
    }
    catch { }
    parts.push(seg);
}
if (mod) {
    if (modOff)
        parts.push(`${c.red}havok-mod off${c.reset}`);
    else if (Date.now() - Date.parse(mod.at) <= 10 * 60 * 1000) {
        const cols = Number(process.env.COLUMNS) || 0;
        const word = cols > 0 && cols < 120 ? "Messages" : "Agent messages";
        const mail = mod.mail === "on" ? `${c.green}${word} on${c.reset}` : mod.mail === "down" ? `${c.red}${word} down${c.reset}` : `${c.dim}${word} off${c.reset}`;
        const w = mod.warm;
        let warm = "";
        if (w && w.on === false)
            warm = `${c.dim}Keep warm off${c.reset}`;
        else if (w && w.on === true) {
            const next = w.next ? new Date(w.next) : null;
            warm = `${c.dim}Keep warm ping${c.reset} ${c.white}${w.pings}/${w.max}${c.reset}${next && !isNaN(next) ? ` ${c.blue}${hhmm(next)}${c.reset}` : ""}`;
            const l = w.last;
            if (l && typeof l.ok === "boolean")
                warm += l.ok ? (Number(l.read) > 0 ? ` ${c.green}last ok${c.reset}` : ` ${c.yellow}last cold${c.reset}`) : ` ${c.red}last failed${c.reset}`;
        }
        let rc = "";
        const r = mod.rc;
        const clean = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 60);
        if (r && r.on === false)
            rc = `${c.red}RC off${c.reset}`;
        else if (r && r.on === true) {
            const name = clean(r.name), want = clean(r.want);
            rc = want && name !== want ? `${c.red}RC ${name}, not ${want}${c.reset}` : `${c.dim}RC${c.reset} ${c.green}${name}${c.reset}`;
        }
        parts.push(`${mail}${warm ? `${sep}${warm}` : ""}${rc ? `${sep}${rc}` : ""}`);
        if (mod.cleanup === "re-apply failed")
            parts.push(`${c.yellow}clean-up not re-applied${c.reset}`);
        const dn = Number(mod.decisions);
        if (Number.isFinite(dn) && dn > 0)
            parts.push(`${c.yellow}${dn} decision${dn === 1 ? "" : "s"} to review${c.reset}`);
    }
    if (!modOff && mod.update?.state === "waiting")
        parts.push(`${c.yellow}update waiting${c.reset}`);
    else if (!modOff && mod.update?.state === "failed")
        parts.push(`${c.red}update ${String(mod.update.version).slice(0, 20)} failed${c.reset}`);
}
else if (modOff)
    parts.push(`${c.red}havok-mod off${c.reset}`);
if (backupArmed)
    parts.push(`${c.red}backup armed${c.reset}`);
{
    const sid = String(d.session_id || "");
    try {
        if (/^[A-Za-z0-9_-]{6,80}$/.test(sid)) {
            const f = join(process.env.USERPROFILE || process.env.HOME || homedir(), ".claude", "havok-mod", "backup", sid + ".json");
            if (existsSync(f)) {
                const n = JSON.parse(readFileSync(f, "utf8"));
                const t = new Date(n.at);
                if (!isNaN(t) && Date.now() - t < 30 * 60 * 1000)
                    parts.push(`${c.red}backup ran ${String(n.event || "").replace(/[^A-Za-z]/g, "").slice(0, 20)} ${hhmm(t)}${c.reset}`);
            }
        }
    }
    catch { }
}
const configDir = String(process.env.CLAUDE_CONFIG_DIR || "").trim();
try {
    if (d.rate_limits)
        writeFileSync(join(configDir || join(process.env.USERPROFILE || homedir(), ".claude"), "havok-limits.json"), JSON.stringify({ at: Date.now(), five: d.rate_limits.five_hour || null, week: d.rate_limits.seven_day || null }));
}
catch { }
function heldByReserve() {
    const userHome = process.env.USERPROFILE || homedir();
    const claude = join(userHome, ".claude");
    const readText = (f) => {
        try {
            return readFileSync(f, "utf8").trim();
        }
        catch {
            return "";
        }
    };
    const json = (f) => {
        try {
            return JSON.parse(readText(f) || "null");
        }
        catch {
            return null;
        }
    };
    const plugin = (json(join(claude, "plugins", "installed_plugins.json"))?.plugins?.["havok-brain@havok-brain"] || []).find((x) => x && x.installPath);
    const brainDir = readText(join(claude, "havok-brain-path")).split(/\r?\n/)[0].trim() || String(plugin?.installPath || "");
    const accounts = (brainDir && json(join(brainDir, "brain.json"))?.limitReserve?.accounts) || {};
    const email = String(json(join(configDir || userHome, ".claude.json"))?.oauthAccount?.emailAddress || "").trim().toLowerCase();
    const key = Object.keys(accounts).find((k) => k.trim().toLowerCase() === email);
    const v = key === undefined ? "" : accounts[key];
    if (v === false)
        return false;
    const main = typeof v === "string" ? v.trim().toLowerCase() : "";
    const inherited = String(process.env.CLAUDE_CODE_EXECPATH || "").trim() !== "";
    if (main && !inherited && String(process.env.HAVOK_MOD_AGENT || "").trim().toLowerCase() === main)
        return false;
    const sid = String(d.session_id || "");
    if (sid && readText(join(claude, "havok-main-session.txt")) === sid)
        return false;
    if (/^[\w-]+$/.test(sid) && Number(readText(join(claude, "havok-limit-bypass", sid + ".txt"))) > Date.now())
        return false;
    return true;
}
const held = heldByReserve();
const five = limit("5h", d.rate_limits?.five_hour, false, held);
if (five)
    top.push(five);
const week = limit("week", d.rate_limits?.seven_day, true, held);
if (week)
    top.push(week);
{
    try {
        const q = JSON.parse(readFileSync(join(process.env.USERPROFILE || homedir(), ".agy-runs", "quota.json"), "utf8").replace(/^﻿/, ""));
        if (q.ok && Array.isArray(q.pools)) {
            const used = (v) => (typeof v === "number" ? Math.round(100 - v) : null);
            const tag = (p) => (/GEMINI/i.test(p.pool) ? "gem" : /CLAUDE/i.test(p.pool) ? "cl" : "?");
            const bits = q.pools.map((p) => {
                const w = used(p.weekly), h = used(p.fiveHour);
                return `${c.dim}${tag(p)}${c.reset} ${w == null ? "" : level(w) + w + "%" + c.reset}${h == null ? "" : c.dim + "/" + c.reset + level(h) + h + "%" + c.reset}`;
            });
            const age = Date.now() - Date.parse(q.at);
            const stale = age > 24 * 3600 * 1000 ? ` ${c.yellow}${Math.round(age / 86400000)}d old${c.reset}` : "";
            parts.push(`${c.dim}agy${c.reset} ${bits.join(" ")}${stale}`);
        }
    }
    catch { }
}
const visible = (t) => t.replace(/\x1b\[[0-9;]*m/g, "").length;
const width = Number(process.env.COLUMNS) || 0;
const room = width - 4;
function wrap(list) {
    if (!list.length)
        return [];
    if (!(width > 0) || visible(list.join(sep)) <= room)
        return [list.join(sep)];
    const out = [];
    let cur = [];
    for (const part of list) {
        if (cur.length && visible([...cur, part].join(sep)) > room) {
            out.push(cur.join(sep));
            cur = [];
        }
        cur.push(part);
    }
    if (cur.length)
        out.push(cur.join(sep));
    return out;
}
process.stdout.write([...wrap([...parts.slice(0, firstLineParts), ...top]), ...wrap(parts.slice(firstLineParts))].join("\n"));
