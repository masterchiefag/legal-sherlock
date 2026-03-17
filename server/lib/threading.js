import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

// Prepared statements (cached for reuse across calls)
const stmtLookupByMessageIds = db.prepare(
    'SELECT message_id, thread_id FROM documents WHERE message_id IN (SELECT value FROM json_each(?))'
);
const stmtLookupByChildRef = db.prepare(
    "SELECT thread_id FROM documents WHERE in_reply_to = ? OR email_references LIKE ? LIMIT 1"
);
const stmtFindOrphans = db.prepare(
    "SELECT id, thread_id FROM documents WHERE (message_id IN (SELECT value FROM json_each(?)) OR in_reply_to IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(?) WHERE email_references LIKE '%' || value || '%')) AND (thread_id IS NULL OR thread_id != ?)"
);
const stmtUnifyThread = db.prepare('UPDATE documents SET thread_id = ? WHERE thread_id = ?');
const stmtUnifyOrphan = db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?');

export function resolveThreadId(messageId, inReplyTo, references) {
    // Collect all candidate message IDs to look up in one query
    const refIds = references ? references.split(/\s+/).filter(Boolean) : [];
    const lookupIds = [];
    if (inReplyTo) lookupIds.push(inReplyTo);
    lookupIds.push(...refIds);

    if (lookupIds.length > 0) {
        // Single query: find thread_id for any known message_id in our lookup set
        const rows = stmtLookupByMessageIds.all(JSON.stringify(lookupIds));

        // Priority: inReplyTo first, then references in reverse order (most recent ancestor)
        if (inReplyTo) {
            const parent = rows.find(r => r.message_id === inReplyTo);
            if (parent?.thread_id) return parent.thread_id;
        }
        // Walk references in reverse for most recent ancestor
        for (const refId of [...refIds].reverse()) {
            const ref = rows.find(r => r.message_id === refId);
            if (ref?.thread_id) return ref.thread_id;
        }
    }

    // Check if any existing email references *our* message_id (late arrival scenario)
    if (messageId) {
        const child = stmtLookupByChildRef.get(messageId, `%${messageId}%`);
        if (child?.thread_id) return child.thread_id;
    }

    // New thread
    return uuidv4();
}

export function backfillThread(threadId, messageId, references) {
    if (!messageId && !references) return;

    const idsToCheck = [messageId, ...(references || '').split(/\s+/)].filter(Boolean);
    const idsJson = JSON.stringify(idsToCheck);

    // Single query to find all orphans that reference any of these IDs
    const orphans = stmtFindOrphans.all(idsJson, idsJson, idsJson, threadId);

    // Collect unique old thread_ids to unify in batch
    const oldThreadIds = new Set();
    const orphanIds = [];

    for (const orphan of orphans) {
        if (orphan.thread_id) {
            oldThreadIds.add(orphan.thread_id);
        } else {
            orphanIds.push(orphan.id);
        }
    }

    // Batch unify: one UPDATE per old thread_id instead of per orphan
    for (const oldThreadId of oldThreadIds) {
        stmtUnifyThread.run(threadId, oldThreadId);
    }
    for (const id of orphanIds) {
        stmtUnifyOrphan.run(threadId, id);
    }
}
