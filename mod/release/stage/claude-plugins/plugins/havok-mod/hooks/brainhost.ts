import type { Engine } from './shared';
export type Host = {
    url: string;
    cert: string;
    tokenFile: string;
};
export type HostAnswer = {
    ok: true;
    status: number;
    headers: Record<string, string>;
    text: string;
} | {
    ok: false;
    why: string;
    timedOut: boolean;
};
const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const SPAWN_MARGIN_MS = 1500;
export const REQUEST_JS = [
    "const [u,m,ca,tf,ms,hj,op]=process.argv.slice(1);const fs=require('fs');",
    "let t=String(process.env.HAVOK_SERVER_TOKEN||'').trim();if(!t){try{t=fs.readFileSync(tf,'utf8').trim()}catch{}}",
    "const out=(o)=>process.stdout.write(JSON.stringify(o));",
    "if(!t&&op!=='open'){out({error:'no server token on this machine'});process.exit(0)}",
    "let b='';try{b=fs.readFileSync(0,'utf8')}catch{}",
    "const url=new URL(u);const lib=require(url.protocol==='https:'?'https':'http');",
    "const h=Object.assign({},JSON.parse(hj||'{}'));if(t)h.authorization='Bearer '+t;if(b)h['content-type']='application/json';",
    "const o={method:m,headers:h,timeout:Number(ms)};if(ca&&url.protocol==='https:')o.ca=fs.readFileSync(ca);",
    "const r=lib.request(url,o,(res)=>{let d='';res.setEncoding('utf8');res.on('data',(c)=>d+=c);res.on('end',()=>out({status:res.statusCode,headers:res.headers,text:d}))});",
    "r.on('timeout',()=>r.destroy(new Error('no answer within '+ms+' ms')));r.on('error',(e)=>out({error:String(e&&e.message||e)}));",
    'if(b)r.write(b);r.end();',
].join('');
async function readText($: Engine, path: string): Promise<string> {
    try {
        return String(await $.fs.read(path));
    }
    catch {
        return '';
    }
}
async function pluginRoot($: Engine, home: string): Promise<string> {
    try {
        const installed = JSON.parse(await readText($, `${slash(home)}/.claude/plugins/installed_plugins.json`)) as {
            plugins?: Record<string, {
                installPath?: string;
            }[]>;
        };
        const entry = (installed.plugins?.['havok-brain@havok-brain'] ?? []).find((x) => x && x.installPath);
        return entry?.installPath ? slash(entry.installPath) : '';
    }
    catch {
        return '';
    }
}
const LOOPBACK_HTTP = /^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i;
export async function resolveHost($: Engine, o: {
    home: string;
    machine: string;
    brainDir: string;
    url?: string;
}): Promise<Host | null> {
    const brain = slash(o.brainDir) || (await pluginRoot($, o.home));
    const tokenFile = `${slash(o.home)}/.claude/havok-server-token`;
    const cert = brain ? `${brain}/server-cert.pem` : '';
    let url = slash(o.url ?? '') || slash(String((await $.env.get('HAVOK_SERVER_URL')) ?? ''));
    if (!url && brain) {
        try {
            const ep = JSON.parse(await readText($, `${brain}/server-endpoint.json`)) as {
                url?: string;
                host?: string;
            };
            url = slash(String(ep.url ?? ''));
            if (url && String(ep.host ?? '').toUpperCase() === o.machine.toUpperCase())
                url = url.replace(/\/\/[^/:]+/, '//127.0.0.1');
        }
        catch {
            url = '';
        }
    }
    if (!/^https:\/\//i.test(url) && !LOOPBACK_HTTP.test(url))
        return null;
    return { url, cert: /^https:/i.test(url) && cert && (await $.fs.exists(cert).catch(() => false)) ? cert : '', tokenFile };
}
let direct: 'unknown' | 'yes' | 'no' = 'unknown';
export function directState() { return direct; }
export function directReset() { direct = 'unknown'; }
async function extraCa($: Engine): Promise<string> { try {
    return String((await $.env.get('NODE_EXTRA_CA_CERTS')) ?? '').trim();
}
catch {
    return '';
} }
async function envToken($: Engine): Promise<string> { try {
    return String((await $.env.get('HAVOK_SERVER_TOKEN')) ?? '').trim();
}
catch {
    return '';
} }
const CERT_REFUSED = /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|certificate/i;
async function directRequest($: Engine, host: Host, method: string, path: string, o: {
    body?: unknown;
    headers?: Record<string, string>;
    budgetMs: number;
    open?: boolean;
}): Promise<HostAnswer | null> {
    if (direct === 'no')
        return null;
    if (/^https:/i.test(host.url) && !(await extraCa($)))
        return null;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (!o.open || host.tokenFile) {
        let token = await envToken($);
        if (!token)
            token = String((await $.fs.read(host.tokenFile).catch(() => '')) ?? '').trim();
        if (token)
            headers.authorization = 'Bearer ' + token;
        else if (!o.open)
            return { ok: false, why: 'no server token on this machine', timedOut: false };
    }
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (body !== undefined)
        headers['content-type'] = 'application/json';
    const call = $.http.fetch(host.url + path, { method, headers, ...(body !== undefined ? { body } : {}) })
        .then((r): HostAnswer => ({ ok: true, status: Number(r.status), headers: (r.headers ?? {}) as Record<string, string>, text: String(r.text ?? '') }))
        .catch((err: unknown): HostAnswer | null => {
        const s = String(err);
        if (CERT_REFUSED.test(s)) {
            direct = 'no';
            $.ui.log(`brain host: the engine fetch refused the certificate (${s.slice(0, 120)}); the helper takes every request`, { to: 'debug' });
            return null;
        }
        return { ok: false, why: s.slice(0, 160), timedOut: false };
    });
    const timer = new AbortController();
    const late = $.clock.sleep(o.budgetMs, { signal: timer.signal }).then((): HostAnswer => ({ ok: false, why: `no answer within ${o.budgetMs} ms`, timedOut: true }), (): HostAnswer => ({ ok: false, why: 'cancelled', timedOut: false }));
    try {
        const r = await Promise.race([call, late]);
        if (r && r.ok && direct === 'unknown') {
            direct = 'yes';
            $.ui.log('brain host: requests go through the engine fetch (no helper process)', { to: 'debug' });
        }
        return r;
    }
    finally {
        timer.abort();
    }
}
let helperMs = 0;
export function takeHelperMs(): number { const n = helperMs; helperMs = 0; return Math.round(n); }
export async function hostRequest($: Engine, host: Host, method: string, path: string, o: {
    body?: unknown;
    headers?: Record<string, string>;
    budgetMs: number;
    open?: boolean;
    spawnMs?: number;
}): Promise<HostAnswer> {
    const fast = await directRequest($, host, method, path, o);
    if (fast)
        return fast;
    const argv = ['node', '-e', REQUEST_JS, host.url + path, method, host.cert, host.tokenFile, String(o.budgetMs), JSON.stringify(o.headers ?? {}), ...(o.open ? ['open'] : [])];
    const from = await $.clock.now();
    const run = $.process.run(argv, { stdin: o.body === undefined ? '' : JSON.stringify(o.body), timeoutMs: o.budgetMs + SPAWN_MARGIN_MS })
        .then((r): HostAnswer => {
        let v: {
            status?: number;
            headers?: Record<string, string>;
            text?: string;
            error?: string;
        } | null = null;
        try {
            v = JSON.parse(r.stdout.trim());
        }
        catch {
            v = null;
        }
        if (!v)
            return { ok: false, why: `no answer (exit ${r.exitCode})`, timedOut: false };
        if (v.error !== undefined)
            return { ok: false, why: String(v.error).slice(0, 160), timedOut: /no answer within/.test(String(v.error)) };
        return { ok: true, status: Number(v.status), headers: v.headers ?? {}, text: String(v.text ?? '') };
    })
        .catch((err: unknown): HostAnswer => ({ ok: false, why: String(err).slice(0, 160), timedOut: false }));
    const timer = new AbortController();
    const late = $.clock.sleep(o.budgetMs + (o.spawnMs ?? 0), { signal: timer.signal }).then((): HostAnswer => ({ ok: false, why: `no answer within ${o.budgetMs} ms`, timedOut: true }), (): HostAnswer => ({ ok: false, why: 'stopped', timedOut: false }));
    try {
        return await Promise.race([run, late]);
    }
    finally {
        timer.abort();
        helperMs += Math.max(0, (await $.clock.now()) - from);
    }
}
