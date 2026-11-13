export const OWN_SECRET_PREFIX = 'wa_bridge_token_';
export const ownSecretName = (machine) => OWN_SECRET_PREFIX + String(machine || '');
const SECRET_NAME = /^[A-Za-z0-9_.-]+$/;
export function readList(meta) {
    const r = Array.isArray(meta && meta.read) ? meta.read : [];
    return [...new Set(r.filter((n) => typeof n === 'string' && SECRET_NAME.test(n) && !/[*?]/.test(n)))];
}
const getName = (path) => { try {
    return decodeURIComponent(path.slice('/vault/get/'.length));
}
catch {
    return '';
} };
export function vaultAccess(caller, method, path) {
    if (!path.startsWith('/vault/'))
        return 'allow';
    if (caller.scope === 'full')
        return 'allow';
    if (method === 'GET' && caller.name && path === '/vault/get/' + ownSecretName(caller.name))
        return 'allow';
    const granted = readList(caller);
    if (method === 'GET' && path.startsWith('/vault/get/') && granted.includes(getName(path)))
        return 'allow';
    if (caller.store === true) {
        if (method === 'POST' && path.startsWith('/vault/set/'))
            return 'store';
        if (method === 'GET' && path === '/vault/list')
            return 'own-list';
    }
    if (method === 'GET' && path === '/vault/list' && granted.length)
        return 'own-list';
    return 'deny';
}
export function listFor(entries, caller) {
    const granted = readList(caller);
    const own = caller.store === true ? ownEntries(entries, caller.name) : [];
    return entries.filter((e) => own.includes(e) || granted.includes(e.name));
}
const NEW_ONLY_PREFIXES = ['contact', 'reference', 'project'];
export function memoryAccess(caller, { method, slug, exists, force }) {
    if (caller && caller.scope === 'full')
        return 'allow';
    if (method === 'DELETE' && force)
        return 'a delete with force needs a full token: remove the links first';
    if (caller && caller.memoryWrites === 'new-only') {
        if (method === 'DELETE')
            return 'this token may only add new memories, never delete one';
        if (exists)
            return 'this token may only add new memories, never change one';
        if (!NEW_ONLY_PREFIXES.includes(String(slug || '').split('_')[0]))
            return 'this token may only add new ' + NEW_ONLY_PREFIXES.join(', ') + ' memories';
    }
    return 'allow';
}
export function mayReplace(caller, body) {
    return caller.scope === 'full' && body.replace === true;
}
export function ownEntries(entries, callerName) {
    const mark = '(stored by ' + callerName + ' ';
    return entries.filter((e) => String(e.note || '').includes(mark));
}
