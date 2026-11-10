// Which vault routes a caller may use. Kept apart from brain-server.mjs so the rule is tested on its own
// (tools/vault-access.test.mjs).
//
// full    every vault route.
// recall  no vault route, unless its entry in havok-tokens.json also says "store": true. Then it may ADD a new secret
//         (POST /vault/set/<name>, never replacing one) and list the names it added itself; it can never read a value.
//
// Why the store permission exists (The owner, 2026-10-31): a machine the owner does not control (a work laptop he cannot
// wipe) keeps a recall token but sometimes must save a key it obtained. Store access adds it without that machine ever
// being able to read the other secrets.

// A machine reads its own WhatsApp bridge token, and no other secret (The owner, 2026-11-04: the chat assistant's service for every
// agent on any machine, with a per-machine bridge token from the vault; brain-client.mjs wa fetches it). the client company
// machines are not excluded (The owner, 2026-11-04); a machine has access once a token is issued for it.
export const OWN_SECRET_PREFIX = 'wa_bridge_token_';
export const ownSecretName = (machine) => OWN_SECRET_PREFIX + String(machine || '');

export function vaultAccess(caller, method, path) {
  if (!path.startsWith('/vault/')) return 'allow';
  if (caller.scope === 'full') return 'allow';
  if (method === 'GET' && caller.name && path === '/vault/get/' + ownSecretName(caller.name)) return 'allow';
  if (caller.store === true) {
    if (method === 'POST' && path.startsWith('/vault/set/')) return 'store';
    if (method === 'GET' && path === '/vault/list') return 'own-list';
  }
  return 'deny';
}

// Memory writes by token (M6, system review 2026-11-09). full: everything. Any other token:
// - never a delete with force (it would leave links to a memory that is gone, for every machine);
// - with "memoryWrites": "new-only" in its havok-tokens.json entry (a line or a machine that should only add facts):
//   it may only create a new contact_, reference_ or project_ memory, never change one and never delete.
// The other recall tokens (the locked-down client machine updates project, reference and feedback memories daily) keep writing.
const NEW_ONLY_PREFIXES = ['contact', 'reference', 'project'];
export function memoryAccess(caller, { method, slug, exists, force }) {
  if (caller && caller.scope === 'full') return 'allow';
  if (method === 'DELETE' && force) return 'a delete with force needs a full token: remove the links first';
  if (caller && caller.memoryWrites === 'new-only') {
    if (method === 'DELETE') return 'this token may only add new memories, never delete one';
    if (exists) return 'this token may only add new memories, never change one';
    if (!NEW_ONLY_PREFIXES.includes(String(slug || '').split('_')[0])) return 'this token may only add new ' + NEW_ONLY_PREFIXES.join(', ') + ' memories';
  }
  return 'allow';
}

export function mayReplace(caller, body) {
  return caller.scope === 'full' && body.replace === true;
}

// The set route appends "(stored by <caller name> <date>)" to every note it writes.
export function ownEntries(entries, callerName) {
  const mark = '(stored by ' + callerName + ' ';
  return entries.filter((e) => String(e.note || '').includes(mark));
}
