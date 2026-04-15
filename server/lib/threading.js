import { v4 as uuidv4 } from 'uuid';

export function resolveThreadId(db, messageId, inReplyTo, references) {
    // 1. Check if any existing email has the same thread by looking up In-Reply-To
    if (inReplyTo) {
        const parent = db.prepare('SELECT thread_id FROM documents WHERE message_id = ?').get(inReplyTo);
        if (parent?.thread_id) return parent.thread_id;
    }

    // 2. Check References header (walk backwards for most recent ancestor first)
    if (references) {
        const refIds = references.split(/\s+/).filter(Boolean).reverse();
        for (const refId of refIds) {
            const ref = db.prepare('SELECT thread_id FROM documents WHERE message_id = ?').get(refId);
            if (ref?.thread_id) return ref.thread_id;
        }
    }

    // 3. Check if any existing email references *our* message_id (late arrival scenario)
    if (messageId) {
        const child = db.prepare(
            "SELECT thread_id FROM documents WHERE in_reply_to = ? OR email_references = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ? LIMIT 1"
        ).get(messageId, messageId, `${messageId} %`, `% ${messageId}`, `% ${messageId} %`);
        if (child?.thread_id) return child.thread_id;
    }

    // 4. New thread
    return uuidv4();
}

export function backfillThread(db, threadId, messageId, references) {
    // If we're creating a new thread but other emails reference us or
    // share references, unify them under this thread_id
    if (!messageId && !references) return;

    const idsToCheck = [messageId, ...(references || '').split(/\s+/)].filter(Boolean);
    for (const refId of idsToCheck) {
        // Find orphan emails that reference any of these IDs
        const orphans = db.prepare(
            "SELECT id, thread_id FROM documents WHERE (message_id = ? OR in_reply_to = ? OR email_references = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ?) AND (thread_id IS NULL OR thread_id != ?)"
        ).all(refId, refId, refId, `${refId} %`, `% ${refId}`, `% ${refId} %`, threadId);

        for (const orphan of orphans) {
            // Unify: update this orphan and all emails in its old thread
            if (orphan.thread_id) {
                db.prepare('UPDATE documents SET thread_id = ? WHERE thread_id = ?').run(threadId, orphan.thread_id);
            } else {
                db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?').run(threadId, orphan.id);
            }
        }
    }
}
