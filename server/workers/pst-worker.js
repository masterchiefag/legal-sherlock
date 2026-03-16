import { workerData, parentPort } from 'worker_threads';
import pkg from 'pst-extractor';
const { PSTFile, PSTFolder, PSTMessage } = pkg;
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { extractText } from '../lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const { jobId, filename, filepath, originalname } = workerData;

let totalEmails = 0;
let totalAttachments = 0;
let errorLog = [];

async function main() {
    try {
        db.prepare("UPDATE import_jobs SET status = 'processing' WHERE id = ?").run(jobId);
        
        const pstFile = new PSTFile(filepath);
        
        // Wrap everything in an async walk
        await walkFolder(pstFile.getRootFolder());

        db.prepare(`
            UPDATE import_jobs 
            SET status = 'completed', 
                total_emails = ?, 
                total_attachments = ?, 
                error_log = ?, 
                completed_at = datetime('now') 
            WHERE id = ?
        `).run(totalEmails, totalAttachments, JSON.stringify(errorLog), jobId);

    } catch (err) {
        console.error("Worker fatal error:", err);
        db.prepare(`
            UPDATE import_jobs 
            SET status = 'failed', 
                error_log = ?, 
                completed_at = datetime('now') 
            WHERE id = ?
        `).run(JSON.stringify([{ error: err.message, fatal: true }]), jobId);
    }
}

async function walkFolder(folder) {
    if (folder.contentCount > 0) {
        let email = folder.getNextChild();
        while (email) {
            if (email instanceof PSTMessage) {
                try {
                    await processAndInsertEmail(email);
                    totalEmails++;
                    
                    // Periodically update progress
                    if (totalEmails % 50 === 0) {
                        db.prepare("UPDATE import_jobs SET total_emails = ?, total_attachments = ? WHERE id = ?")
                          .run(totalEmails, totalAttachments, jobId);
                        
                        // Explicitly hint to GC to clear memory
                        if (global.gc) global.gc();
                    }
                } catch (err) {
                    errorLog.push({ subject: email.subject || 'Unknown', error: err.message });
                }
            }
            email = folder.getNextChild();
        }
    }

    if (folder.hasSubfolders) {
        const subFolders = folder.getSubFolders();
        for (const sub of subFolders) {
            await walkFolder(sub);
        }
    }
}

// ═══════════════════════════════════════════════════
// Email processing logic specifically tuned for low memory
// ═══════════════════════════════════════════════════
async function processAndInsertEmail(msg) {
    const emailId = uuidv4();
    const emailFilename = `${emailId}.pst-msg`;

    const from = msg.senderName
        ? (msg.senderEmailAddress ? `${msg.senderName} <${msg.senderEmailAddress}>` : msg.senderName)
        : msg.senderEmailAddress || '';

    let messageId = msg.internetMessageId || '';
    if (messageId) messageId = messageId.replace(/^</, '').replace(/>$/, '').trim();

    let inReplyTo = msg.inReplyToId || '';
    if (inReplyTo) inReplyTo = inReplyTo.replace(/^</, '').replace(/>$/, '').trim();

    let references = '';
    const headers = msg.transportMessageHeaders || '';
    const refMatch = headers.match(/^References:\s*(.+?)(?:\r?\n(?!\s))/ms);
    if (refMatch) references = refMatch[1].replace(/[\r\n\s]+/g, ' ').trim();

    const subject = msg.subject || '(no subject)';
    const textBody = msg.body || '';
    const date = msg.clientSubmitTime ? msg.clientSubmitTime.toISOString() : null;
    const sizeBytes = textBody.length;

    const threadId = resolveThreadId(messageId, inReplyTo, references);

    // Write primary email to DB
    db.prepare(`
        INSERT INTO documents (
            id, filename, original_name, mime_type, size_bytes, text_content, status,
            doc_type, thread_id, message_id, in_reply_to, email_references,
            email_from, email_to, email_cc, email_subject, email_date
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        emailId, emailFilename, `${originalname} — ${subject}`, 'message/rfc822', sizeBytes, textBody,
        threadId, messageId, inReplyTo, references,
        from, msg.displayTo || '', msg.displayCC || '', subject, date
    );

    backfillThread(threadId, messageId, references);

    // Process attachments by streaming to disk (low memory profile)
    const numAttachments = msg.numberOfAttachments;
    for (let i = 0; i < numAttachments; i++) {
        const att = msg.getAttachment(i);
        if (!att) continue;

        const attId = uuidv4();
        const attName = att.longFilename || att.filename || `attachment_${i}`;
        const attExt = path.extname(attName) || '.bin';
        const attFilename = `${attId}${attExt}`;
        const attPath = path.join(UPLOADS_DIR, attFilename);
        const contentType = att.mimeTag || 'application/octet-stream';

        // Stream from PST to disk
        const fd = fs.openSync(attPath, 'w');
        const blockSize = 8176;
        let bytesRead;
        let totalWritten = 0;
        do {
            const buf = Buffer.alloc(blockSize);
            bytesRead = att.fileInputStream?.read(buf) || 0;
            if (bytesRead > 0) {
                fs.writeSync(fd, buf, 0, bytesRead, null);
                totalWritten += bytesRead;
            }
        } while (bytesRead === blockSize);
        fs.closeSync(fd);

        let attText = '';
        try {
            attText = await extractText(attPath, contentType);
        } catch (e) {
            attText = `[Could not extract text: ${e.message}]`;
        }

        db.prepare(`
            INSERT INTO documents (
                id, filename, original_name, mime_type, size_bytes, text_content, status,
                doc_type, parent_id, thread_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'attachment', ?, ?)
        `).run(attId, attFilename, attName, contentType, totalWritten, attText, emailId, threadId);

        totalAttachments++;
    }
}

// ═══════════════════════════════════════════════════
// Thread resolution utilities (duplicated from documents.js for worker isolation)
// ═══════════════════════════════════════════════════
function resolveThreadId(messageId, inReplyTo, references) {
    if (inReplyTo) {
        const parent = db.prepare('SELECT thread_id FROM documents WHERE message_id = ?').get(inReplyTo);
        if (parent?.thread_id) return parent.thread_id;
    }
    if (references) {
        const refIds = references.split(/\s+/).filter(Boolean).reverse();
        for (const refId of refIds) {
            const ref = db.prepare('SELECT thread_id FROM documents WHERE message_id = ?').get(refId);
            if (ref?.thread_id) return ref.thread_id;
        }
    }
    if (messageId) {
        const child = db.prepare(
            "SELECT thread_id FROM documents WHERE in_reply_to = ? OR email_references LIKE ? LIMIT 1"
        ).get(messageId, `%${messageId}%`);
        if (child?.thread_id) return child.thread_id;
    }
    return uuidv4();
}

function backfillThread(threadId, messageId, references) {
    if (!messageId && !references) return;
    const idsToCheck = [messageId, ...(references || '').split(/\s+/)].filter(Boolean);
    for (const refId of idsToCheck) {
        const orphans = db.prepare(
            "SELECT id, thread_id FROM documents WHERE (message_id = ? OR in_reply_to = ? OR email_references LIKE ?) AND (thread_id IS NULL OR thread_id != ?)"
        ).all(refId, refId, `%${refId}%`, threadId);
        for (const orphan of orphans) {
            if (orphan.thread_id) {
                db.prepare('UPDATE documents SET thread_id = ? WHERE thread_id = ?').run(threadId, orphan.thread_id);
            } else {
                db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?').run(threadId, orphan.id);
            }
        }
    }
}

// Start worker
main();
