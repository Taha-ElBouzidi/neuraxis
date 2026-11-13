import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from './ulid.mjs';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reply_to TEXT,
  thread TEXT NOT NULL,
  depth INTEGER NOT NULL,
  idem_key TEXT,
  expect_reply INTEGER NOT NULL,
  deadline INTEGER,
  created INTEGER NOT NULL,
  lease_holder TEXT,
  lease_until INTEGER,
  offers INTEGER NOT NULL DEFAULT 0,
  held_reason TEXT,
  held_at INTEGER,
  held_count INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  delivered_by TEXT,
  reply_id TEXT,
  replied_at INTEGER,
  timed_out_at INTEGER,
  receipt_seen INTEGER,
  undeliverable_at INTEGER,
  undeliverable_reason TEXT,
  failed_at INTEGER,
  failed_reason TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(recipient, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages(sender, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, delivered_at, seq);
CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender, created);
CREATE TABLE IF NOT EXISTS events(
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  msg TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_msg ON events(msg);
CREATE TABLE IF NOT EXISTS seqs(recipient TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  address TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  consumer TEXT,
  state TEXT,
  version TEXT
);
-- Version 1.4.1: when an address left the archived list (restored_at), so messages held for it waits for its next start.
CREATE TABLE IF NOT EXISTS restores(address TEXT PRIMARY KEY, archived INTEGER NOT NULL, restored_at INTEGER);
CREATE TABLE IF NOT EXISTS consumers(id TEXT PRIMARY KEY, address TEXT NOT NULL, last_seen INTEGER NOT NULL);
`;
export function openStore(dataDir, { leaseMs, consumerStaleMs, listeningMs, log, isArchived = () => false }) {
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, 'mailbox.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    db.exec(SCHEMA);
    const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!cols.includes('receipt_seen')) {
        db.exec('ALTER TABLE messages ADD COLUMN receipt_seen INTEGER');
        db.exec('UPDATE messages SET receipt_seen = delivered_at WHERE delivered_at IS NOT NULL');
    }
    if (!cols.includes('undeliverable_at'))
        db.exec('ALTER TABLE messages ADD COLUMN undeliverable_at INTEGER');
    if (!cols.includes('undeliverable_reason'))
        db.exec('ALTER TABLE messages ADD COLUMN undeliverable_reason TEXT');
    if (!cols.includes('failed_at'))
        db.exec('ALTER TABLE messages ADD COLUMN failed_at INTEGER');
    if (!cols.includes('failed_reason'))
        db.exec('ALTER TABLE messages ADD COLUMN failed_reason TEXT');
    if (!cols.includes('failed_count'))
        db.exec('ALTER TABLE messages ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0');
    const ccols = db.prepare('PRAGMA table_info(consumers)').all().map((c) => c.name);
    if (!ccols.includes('first_seen')) {
        db.exec('ALTER TABLE consumers ADD COLUMN first_seen INTEGER');
        db.exec('UPDATE consumers SET first_seen = last_seen WHERE first_seen IS NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS messages_unseen ON messages(sender) WHERE delivered_at IS NOT NULL AND receipt_seen IS NULL');
    db.exec('BEGIN IMMEDIATE; COMMIT;');
    db.prepare("INSERT INTO seqs(recipient, seq) VALUES('__write_probe__', 0) ON CONFLICT(recipient) DO NOTHING").run();
    const q = {
        get: db.prepare('SELECT * FROM messages WHERE id = ?'),
        byKey: db.prepare('SELECT * FROM messages WHERE sender = ? AND idem_key = ?'),
        nextSeq: db.prepare('INSERT INTO seqs(recipient, seq) VALUES(?, 1) ON CONFLICT(recipient) DO UPDATE SET seq = seq + 1 RETURNING seq'),
        insert: db.prepare(`INSERT INTO messages(id, seq, sender, recipient, text, bytes, reply_to, thread, depth, idem_key,
      expect_reply, deadline, created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        event: db.prepare('INSERT INTO events(msg, at, kind, detail) VALUES(?,?,?,?)'),
        events: db.prepare('SELECT at, kind, detail FROM events WHERE msg = ? ORDER BY n'),
        told: db.prepare("SELECT 1 AS x FROM events WHERE msg = ? AND kind = 'sender_told' AND detail = ? LIMIT 1"),
        pending: db.prepare('SELECT * FROM messages WHERE recipient = ? AND delivered_at IS NULL AND undeliverable_at IS NULL ORDER BY seq LIMIT ?'),
        pendingCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND delivered_at IS NULL AND undeliverable_at IS NULL'),
        lease: db.prepare('UPDATE messages SET lease_holder = ?, lease_until = ?, offers = offers + ? WHERE id = ?'),
        deliver: db.prepare('UPDATE messages SET delivered_at = ?, delivered_by = ?, lease_holder = NULL, lease_until = NULL, held_reason = NULL WHERE id = ? AND delivered_at IS NULL'),
        hold: db.prepare('UPDATE messages SET held_reason = ?, held_at = ?, held_count = held_count + 1 WHERE id = ?'),
        failDelivery: db.prepare('UPDATE messages SET delivered_at = NULL, delivered_by = NULL, receipt_seen = NULL, failed_at = ?, failed_reason = ?, failed_count = failed_count + 1, lease_holder = ?, lease_until = ? WHERE id = ?'),
        unlease: db.prepare('UPDATE messages SET lease_holder = NULL, lease_until = NULL WHERE id = ?'),
        renewLeases: db.prepare('UPDATE messages SET lease_until = ? WHERE lease_holder = ? AND recipient = ? AND delivered_at IS NULL AND undeliverable_at IS NULL'),
        leasedBy: db.prepare('SELECT id, lease_holder FROM messages WHERE recipient = ? AND delivered_at IS NULL AND undeliverable_at IS NULL AND lease_holder IS NOT NULL'),
        repliesBy: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to = ? AND sender = ?'),
        markReplied: db.prepare('UPDATE messages SET reply_id = ?, replied_at = ? WHERE id = ? AND reply_id IS NULL'),
        dueTimeouts: db.prepare('SELECT id FROM messages WHERE undeliverable_at IS NULL AND expect_reply = 1 AND reply_id IS NULL AND timed_out_at IS NULL AND deadline IS NOT NULL AND deadline < ?'),
        markTimeout: db.prepare('UPDATE messages SET timed_out_at = ? WHERE id = ?'),
        nextDeadline: db.prepare('SELECT MIN(deadline) AS at FROM messages WHERE undeliverable_at IS NULL AND expect_reply = 1 AND reply_id IS NULL AND timed_out_at IS NULL AND deadline IS NOT NULL'),
        consumerSeen: db.prepare('INSERT INTO consumers(id, address, first_seen, last_seen) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, address = excluded.address'),
        consumer: db.prepare('SELECT * FROM consumers WHERE id = ?'),
        restoreGet: db.prepare('SELECT * FROM restores WHERE address = ?'),
        restoreAll: db.prepare('SELECT * FROM restores'),
        restoreSet: db.prepare('INSERT INTO restores(address, archived, restored_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET archived = excluded.archived, restored_at = COALESCE(excluded.restored_at, restores.restored_at)'),
        newConsumer: db.prepare('SELECT 1 AS x FROM consumers WHERE address = ? AND first_seen > ? LIMIT 1'),
        pendingRecipients: db.prepare('SELECT DISTINCT recipient FROM messages WHERE delivered_at IS NULL AND undeliverable_at IS NULL'),
        agentSeen: db.prepare(`INSERT INTO agents(address, machine, first_seen, last_seen, consumer, state, version) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen, consumer = excluded.consumer,
      state = COALESCE(excluded.state, agents.state), version = COALESCE(excluded.version, agents.version)`),
        agent: db.prepare('SELECT * FROM agents WHERE address = ?'),
        agentsNamed: db.prepare("SELECT * FROM agents WHERE address LIKE ? ESCAPE '\\'"),
        agents: db.prepare('SELECT * FROM agents ORDER BY address'),
        unseenCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND delivered_at IS NOT NULL AND receipt_seen IS NULL'),
        markSeen: db.prepare('UPDATE messages SET receipt_seen = ? WHERE id = ? AND sender = ? AND delivered_at IS NOT NULL AND receipt_seen IS NULL'),
        undeliverablePending: db.prepare('SELECT id, recipient FROM messages WHERE delivered_at IS NULL AND undeliverable_at IS NULL'),
        markUndeliverable: db.prepare('UPDATE messages SET undeliverable_at = ?, undeliverable_reason = ?, lease_holder = NULL, lease_until = NULL WHERE id = ? AND delivered_at IS NULL AND undeliverable_at IS NULL'),
        sentBy: db.prepare('SELECT * FROM messages WHERE sender = ? ORDER BY created DESC LIMIT ?'),
    };
    function tx(fn) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const r = fn();
            db.exec('COMMIT');
            return r;
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
    function durableTx(fn) {
        db.exec('PRAGMA synchronous=FULL');
        try {
            return tx(fn);
        }
        finally {
            db.exec('PRAGMA synchronous=NORMAL');
        }
    }
    function event(id, kind, detail, at = Date.now()) {
        q.event.run(id, at, kind, detail == null ? null : String(detail));
        log(`${kind} ${id}${detail ? ' ' + detail : ''}`);
    }
    function consumerAlive(id, now) {
        if (!id)
            return false;
        const c = q.consumer.get(id);
        return !!c && now - c.last_seen < consumerStaleMs;
    }
    function leaseLive(m, now) {
        return !!m.lease_holder && (m.lease_until || 0) > now && consumerAlive(m.lease_holder, now);
    }
    function touchConsumer(consumer, address, now) {
        if (consumer)
            q.consumerSeen.run(consumer, address, now, now);
    }
    function seen(address, machine, { consumer = null, state = null, version = null } = {}, now = Date.now()) {
        q.agentSeen.run(address, machine, now, now, consumer, state, version);
        touchConsumer(consumer, address, now);
    }
    function restartPending(address) {
        const row = q.restoreGet.get(address);
        if (!row || row.archived || !row.restored_at)
            return false;
        return !q.newConsumer.get(address, row.restored_at);
    }
    const heldFor = (address) => isArchived(address) || restartPending(address);
    function markArchived(address) { q.restoreSet.run(address, 1, null); }
    function reconcileArchived(isArchivedNow, extra = [], now = Date.now()) {
        const all = new Set([...extra, ...q.agents.all().map((a) => a.address), ...q.pendingRecipients.all().map((r) => r.recipient), ...q.restoreAll.all().map((r) => r.address)]);
        const restored = [];
        for (const address of all) {
            const arch = !!isArchivedNow(address);
            const row = q.restoreGet.get(address);
            if (arch && !(row && row.archived))
                q.restoreSet.run(address, 1, null);
            else if (!arch && row && row.archived) {
                q.restoreSet.run(address, 0, now);
                restored.push(address);
                log('RESTORED ' + address + ' (held messages wait for its next start)');
            }
        }
        return restored;
    }
    function stateOf(m, now = Date.now()) {
        if (m.undeliverable_at)
            return 'undeliverable';
        if (m.reply_id)
            return 'done';
        if (m.delivered_at && !m.expect_reply)
            return 'done';
        if (!m.delivered_at && heldFor(m.recipient))
            return 'held';
        if (m.expect_reply && m.deadline && now > m.deadline)
            return 'timeout';
        if (m.delivered_at)
            return 'in_progress';
        if (leaseLive(m, now))
            return m.held_reason ? 'held' : 'offered';
        return 'accepted';
    }
    function agentView(a, now = Date.now()) {
        if (!a)
            return { listening: false, last_seen: null, state: 'never_seen' };
        if (isArchived(a.address))
            return { listening: false, state: 'archived', archived: true, last_seen: new Date(a.last_seen).toISOString() };
        if (restartPending(a.address))
            return { listening: false, state: 'restored, waiting for its next start', restored_waiting_for_start: true, last_seen: new Date(a.last_seen).toISOString() };
        const fresh = now - a.last_seen < listeningMs;
        return {
            listening: fresh && a.state !== 'stopped',
            state: fresh ? (a.state || 'listening') : 'not_listening',
            ...(fresh && a.state === 'busy' ? { busy: true } : {}),
            last_seen: new Date(a.last_seen).toISOString(),
        };
    }
    function view(m, { withText = false, withHistory = false } = {}, now = Date.now()) {
        const out = {
            id: m.id,
            seq: m.seq,
            from: m.sender,
            to: m.recipient,
            state: stateOf(m, now),
            reply_to: m.reply_to || null,
            thread: m.thread,
            expect_reply: !!m.expect_reply,
            sent_at: new Date(m.created).toISOString(),
            deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
            offers: m.offers,
            held: !m.delivered_at && isArchived(m.recipient) ? { reason: 'the recipient is archived; held until it is restored', at: new Date(m.created).toISOString(), times: 0, archived: true } : !m.delivered_at && restartPending(m.recipient) ? { reason: 'the recipient was restored but has not started again; held until it does', at: new Date(m.created).toISOString(), times: 0, restored_waiting_for_start: true } : m.held_reason ? { reason: m.held_reason, at: new Date(m.held_at).toISOString(), times: m.held_count } : null,
            delivered_at: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
            reply_id: m.reply_id || null,
            replied_at: m.replied_at ? new Date(m.replied_at).toISOString() : null,
            age_s: Math.max(0, Math.round((now - m.created) / 1000)),
            receipt: {
                delivered: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
                done: m.replied_at ? new Date(m.replied_at).toISOString() : (m.delivered_at && !m.expect_reply ? new Date(m.delivered_at).toISOString() : null),
            },
            failed: m.failed_at && !m.delivered_at ? { at: new Date(m.failed_at).toISOString(), reason: m.failed_reason, times: m.failed_count } : null,
            undeliverable: m.undeliverable_at ? { at: new Date(m.undeliverable_at).toISOString(), reason: m.undeliverable_reason } : null,
            bytes: m.bytes,
        };
        if (withText)
            out.text = m.text;
        if (withHistory)
            out.history = q.events.all(m.id).map((e) => ({ at: new Date(e.at).toISOString(), event: e.kind, detail: e.detail || undefined }));
        return out;
    }
    function insert({ sender, recipient, text, bytes, replyTo, parent, idemKey, expectReply, replyTimeoutMs }) {
        return durableTx(() => {
            const now = Date.now();
            const id = ulid(now);
            const seq = q.nextSeq.get(recipient).seq;
            const thread = parent ? parent.thread : id;
            const depth = parent ? parent.depth + 1 : 0;
            const deadline = expectReply ? now + replyTimeoutMs : null;
            q.insert.run(id, seq, sender, recipient, text, bytes, replyTo || null, thread, depth, idemKey || null, expectReply ? 1 : 0, deadline, now);
            event(id, 'sent', `from=${sender} to=${recipient} seq=${seq} bytes=${bytes}${replyTo ? ' reply_to=' + replyTo : ''}${idemKey ? ' key=yes' : ''}`, now);
            if (parent && !parent.reply_id) {
                q.markReplied.run(id, now, parent.id);
                event(parent.id, 'replied', `reply=${id}`, now);
            }
            return q.get.get(id);
        });
    }
    function lease(recipient, consumer, max, now = Date.now()) {
        return tx(() => {
            touchConsumer(consumer, recipient, now);
            const out = [];
            if (heldFor(recipient))
                return out;
            for (const m of q.pending.all(recipient, max)) {
                const live = leaseLive(m, now);
                if (live && m.lease_holder !== consumer)
                    break;
                const isNew = !(live && m.lease_holder === consumer);
                q.lease.run(consumer, now + leaseMs, isNew ? 1 : 0, m.id);
                if (isNew)
                    event(m.id, 'offered', `consumer=${consumer}`, now);
                out.push(q.get.get(m.id));
            }
            return out;
        });
    }
    function ack(recipient, consumer, ids, now = Date.now()) {
        return durableTx(() => {
            const acked = [];
            const already = [];
            const refused = [];
            for (const id of ids) {
                const m = q.get.get(id);
                if (!m || m.recipient !== recipient) {
                    refused.push(id);
                    continue;
                }
                if (m.delivered_at) {
                    already.push(id);
                    continue;
                }
                q.deliver.run(now, consumer, id);
                event(id, 'delivered', `consumer=${consumer}`, now);
                acked.push(id);
            }
            return { acked, already, refused };
        });
    }
    function renew(recipient, consumer, now = Date.now()) {
        return q.renewLeases.run(now + leaseMs, consumer, recipient).changes;
    }
    function setAside(recipient, consumer, ids, reason, now = Date.now()) {
        return durableTx(() => {
            const setAsideIds = [];
            const refused = [];
            for (const id of ids) {
                const m = q.get.get(id);
                const mine = !!m && m.recipient === recipient && !m.reply_id && !m.undeliverable_at &&
                    (m.delivered_at ? m.delivered_by === consumer : !leaseLive(m, now) || m.lease_holder === consumer);
                if (!mine) {
                    refused.push(id);
                    continue;
                }
                if (m.delivered_at)
                    q.failDelivery.run(now, reason, null, null, id);
                q.markUndeliverable.run(now, reason, id);
                event(id, 'set_aside', reason, now);
                setAsideIds.push(id);
            }
            return { setAside: setAsideIds, refused };
        });
    }
    function hold(recipient, consumer, ids, reason, now = Date.now()) {
        return tx(() => {
            const held = [];
            for (const id of ids) {
                const m = q.get.get(id);
                if (!m || m.recipient !== recipient || m.delivered_at)
                    continue;
                if (m.held_reason !== reason || now - (m.held_at || 0) > 60000)
                    event(id, 'held', reason, now);
                q.hold.run(reason, now, id);
                if (m.lease_holder === consumer)
                    q.lease.run(consumer, now + leaseMs, 0, id);
                held.push(id);
            }
            return held;
        });
    }
    function failDelivery(recipient, consumer, ids, reason, now = Date.now()) {
        return durableTx(() => {
            const failed = [];
            const refused = [];
            for (const id of ids) {
                const m = q.get.get(id);
                const mine = !!m && m.recipient === recipient && !m.reply_id && !m.undeliverable_at &&
                    (m.delivered_at ? m.delivered_by === consumer : !leaseLive(m, now) || m.lease_holder === consumer);
                if (!mine) {
                    refused.push(id);
                    continue;
                }
                q.failDelivery.run(now, reason, consumer, now + leaseMs, id);
                event(id, 'delivery_failed', reason, now);
                failed.push(id);
            }
            return { failed, refused };
        });
    }
    function release(recipient, consumer, previous, now = Date.now()) {
        return tx(() => {
            touchConsumer(consumer, recipient, now);
            const named = new Set(previous || []);
            const released = [];
            for (const r of q.leasedBy.all(recipient)) {
                if (r.lease_holder === consumer)
                    continue;
                if (named.has(r.lease_holder) || !consumerAlive(r.lease_holder, now)) {
                    q.unlease.run(r.id);
                    event(r.id, 'released', `old_consumer=${r.lease_holder}`, now);
                    released.push(r.id);
                }
            }
            return released;
        });
    }
    function markSeen(sender, ids, now = Date.now()) {
        for (const id of ids)
            q.markSeen.run(now, id, sender);
    }
    function sweepRetired(isRetired, now = Date.now()) {
        const hit = q.undeliverablePending.all().filter((m) => isRetired(m.recipient));
        if (!hit.length)
            return [];
        tx(() => { for (const m of hit) {
            q.markUndeliverable.run(now, 'the address ' + m.recipient + ' was retired', m.id);
            event(m.id, 'undeliverable', 'recipient retired', now);
        } });
        return hit.map((m) => q.get.get(m.id));
    }
    function wasTold(id, what) { return !!q.told.get(id, what); }
    function markTold(id, what, now = Date.now()) { event(id, 'sender_told', what, now); }
    function nextDeadline() { const r = q.nextDeadline.get(); return r && r.at ? Number(r.at) : null; }
    function sweepTimeouts(now = Date.now()) {
        const due = q.dueTimeouts.all(now);
        if (!due.length)
            return 0;
        tx(() => { for (const { id } of due) {
            q.markTimeout.run(now, id);
            event(id, 'timeout', 'no reply by the deadline', now);
        } });
        return due.length;
    }
    return {
        db,
        get: (id) => q.get.get(id),
        byKey: (sender, key) => q.byKey.get(sender, key),
        repliesBy: (id, sender) => q.repliesBy.get(id, sender).n,
        pendingCount: (recipient) => q.pendingCount.get(recipient).n,
        agent: (address) => q.agent.get(address),
        agentsNamed: (name) => q.agentsNamed.all(name.replace(/[\\%_]/g, (c) => '\\' + c) + '@%'),
        agents: () => q.agents.all(),
        sentBy: (sender, limit) => q.sentBy.all(sender, limit),
        event: (id, kind, detail) => event(id, kind, detail),
        unseenCount: (sender) => q.unseenCount.get(sender).n,
        markSeen, sweepRetired, wasTold, markTold, nextDeadline, restartPending, markArchived, reconcileArchived,
        insert, lease, ack, hold, failDelivery, setAside, renew, release, seen, sweepTimeouts, stateOf, view, agentView,
    };
}
