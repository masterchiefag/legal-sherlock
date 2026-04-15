import { v4 as uuidv4 } from 'uuid';

/**
 * Cached threading resolver — keeps message_id → thread_id mappings in memory
 * to avoid repeated DB lookups during bulk import.
 *
 * Call initCache(db, investigationId) before bulk import, then use
 * resolveThreadId/backfillThread as normal.  The cache is populated from
 * existing DB data and updated as new emails are processed.
 *
 * The db parameter is the per-investigation database connection.
 */

// In-memory caches
const msgIdToThreadId = new Map();   // message_id → thread_id
const inReplyToIndex = new Map();    // in_reply_to → thread_id
const referencesIndex = new Map();   // message_id referenced by others → thread_id

// Prepared statements (created once per initCache call)
let stmtLookupByMsgId;
let stmtLookupByInReplyTo;
let stmtOrphans;
let stmtUnifyThread;
let stmtUnifySingle;

export function initCache(db, investigationId) {
    // Clear previous cache
    msgIdToThreadId.clear();
    inReplyToIndex.clear();
    referencesIndex.clear();

    // Pre-populate cache from existing emails in this investigation
    const existing = db.prepare(
        "SELECT message_id, in_reply_to, email_references, thread_id FROM documents WHERE doc_type = 'email' AND message_id IS NOT NULL"
    ).all();

    for (const row of existing) {
        if (row.message_id) msgIdToThreadId.set(row.message_id, row.thread_id);
        if (row.in_reply_to) inReplyToIndex.set(row.in_reply_to, row.thread_id);
        if (row.email_references) {
            for (const ref of row.email_references.split(/\s+/).filter(Boolean)) {
                referencesIndex.set(ref, row.thread_id);
            }
        }
    }

    // Prepare statements once
    stmtLookupByMsgId = db.prepare('SELECT thread_id FROM documents WHERE message_id = ? LIMIT 1');
    stmtLookupByInReplyTo = db.prepare(
        "SELECT thread_id FROM documents WHERE in_reply_to = ? OR email_references = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ? LIMIT 1"
    );
    stmtOrphans = db.prepare(
        "SELECT id, thread_id FROM documents WHERE (message_id = ? OR in_reply_to = ? OR email_references = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ?) AND (thread_id IS NULL OR thread_id != ?)"
    );
    stmtUnifyThread = db.prepare('UPDATE documents SET thread_id = ? WHERE thread_id = ?');
    stmtUnifySingle = db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?');

    console.log(`✦ Threading cache initialized: ${msgIdToThreadId.size} message_ids cached`);
}

export function resolveThreadId(messageId, inReplyTo, references) {
    // 1. Check cache for In-Reply-To
    if (inReplyTo) {
        const cached = msgIdToThreadId.get(inReplyTo);
        if (cached) return cached;
        // Fallback to DB only if not in cache
        const parent = stmtLookupByMsgId.get(inReplyTo);
        if (parent?.thread_id) {
            msgIdToThreadId.set(inReplyTo, parent.thread_id);
            return parent.thread_id;
        }
    }

    // 2. Check References (walk backwards)
    if (references) {
        const refIds = references.split(/\s+/).filter(Boolean).reverse();
        for (const refId of refIds) {
            const cached = msgIdToThreadId.get(refId);
            if (cached) return cached;
            const ref = stmtLookupByMsgId.get(refId);
            if (ref?.thread_id) {
                msgIdToThreadId.set(refId, ref.thread_id);
                return ref.thread_id;
            }
        }
    }

    // 3. Check if any existing email references our message_id (late arrival)
    if (messageId) {
        const cached = referencesIndex.get(messageId) || inReplyToIndex.get(messageId);
        if (cached) return cached;
        const child = stmtLookupByInReplyTo.get(messageId, messageId, `${messageId} %`, `% ${messageId}`, `% ${messageId} %`);
        if (child?.thread_id) return child.thread_id;
    }

    // 4. New thread
    return uuidv4();
}

/**
 * Cache-only thread resolution — no DB fallback. Used during bulk backfill
 * after all emails are inserted and cache is fully populated.
 * Returns null if no match found (caller should keep existing thread_id).
 */
export function resolveThreadIdFromCache(messageId, inReplyTo, references) {
    if (inReplyTo) {
        const cached = msgIdToThreadId.get(inReplyTo);
        if (cached) return cached;
    }

    if (references) {
        const refIds = references.split(/\s+/).filter(Boolean).reverse();
        for (const refId of refIds) {
            const cached = msgIdToThreadId.get(refId);
            if (cached) return cached;
        }
    }

    if (messageId) {
        const cached = referencesIndex.get(messageId) || inReplyToIndex.get(messageId);
        if (cached) return cached;
    }

    return null;
}

/**
 * Update in-memory cache only — no DB writes. Used during bulk import
 * to defer expensive backfill operations to end of Phase 1.
 */
export function updateCacheOnly(threadId, messageId, inReplyTo, references) {
    if (messageId) msgIdToThreadId.set(messageId, threadId);
    if (inReplyTo) inReplyToIndex.set(inReplyTo, threadId);
    if (references) {
        for (const ref of references.split(/\s+/).filter(Boolean)) {
            referencesIndex.set(ref, threadId);
        }
    }
}

export function backfillThread(threadId, messageId, references) {
    if (!messageId && !references) return;

    // Update cache for the new email
    if (messageId) msgIdToThreadId.set(messageId, threadId);
    if (references) {
        for (const ref of references.split(/\s+/).filter(Boolean)) {
            referencesIndex.set(ref, threadId);
        }
    }

    const idsToCheck = [messageId, ...(references || '').split(/\s+/)].filter(Boolean);
    for (const refId of idsToCheck) {
        const orphans = stmtOrphans.all(refId, refId, refId, `${refId} %`, `% ${refId}`, `% ${refId} %`, threadId);

        for (const orphan of orphans) {
            if (orphan.thread_id) {
                stmtUnifyThread.run(threadId, orphan.thread_id);
                // Update cache: remap old thread_id → new thread_id
                for (const [k, v] of msgIdToThreadId) {
                    if (v === orphan.thread_id) msgIdToThreadId.set(k, threadId);
                }
            } else {
                stmtUnifySingle.run(threadId, orphan.id);
            }
        }
    }
}
