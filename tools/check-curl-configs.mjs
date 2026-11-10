import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(BRAIN, "hooks/pre-turn.mjs"), "utf8");
const cfg = {
    url: "https://brain.example.ts.net:8443", token: "TOKEN", cacert: "<cert>.pem",
    connectTo: "brain.example.ts.net:8443:203.0.113.10:8443", ct: 4,
};
const bodies = [...src.matchAll(/const conf =([\s\S]*?);\r?\n/g)].map((m) => m[1]);
console.log("curl configs found:", bodies.length);
const EXPECTED = 5;
if (bodies.length !== EXPECTED) {
    console.log(`FAIL: expected ${EXPECTED} curl configs in pre-turn.mjs, found ${bodies.length}.`);
    console.log("If a config was added or removed on purpose, update EXPECTED here.");
    process.exit(1);
}
let bad = 0;
bodies.forEach((expr, i) => {
    let out;
    try {
        const names = ["cfg", "payload", "token", "prompt", "queries", "text", "texts", "body", "json"];
        const vals = [cfg, "{}", "TOKEN", "p", [], "t", ["t"], "{}", "{}"];
        out = Function(...names, '"use strict"; return (' + expr + ")")(...vals);
    }
    catch (e) {
        console.log(`  [${i}] FAIL, could not evaluate: ${e.message.slice(0, 80)}`);
        bad++;
        return;
    }
    if (typeof out !== "string") {
        console.log(`  [${i}] FAIL, not a string`);
        bad++;
        return;
    }
    const lines = out.split("\n").filter(Boolean);
    const ct = lines.filter((l) => l.startsWith("connect-to = "));
    const url = lines.filter((l) => l.startsWith("url = "));
    const literal = lines.some((l) => l.includes("\n") || l.includes("@@n"));
    const ok = ct.length === 1 && url.length === 1 && !literal;
    if (!ok) {
        bad++;
        console.log(`  [${i}] BROKEN  connect-to lines:${ct.length} url lines:${url.length} literal-escape:${literal}`);
        console.log("       " + lines.find((l) => l.includes("connect-to") || l.includes("url ="))?.slice(0, 140));
    }
    else {
        console.log(`  [${i}] ok`);
    }
});
console.log(bad
    ? `FAIL: ${bad} of ${bodies.length} configs malformed on the relay branch`
    : `PASS: all ${bodies.length} configs put every directive on its own line`);
process.exit(bad ? 1 : 0);
