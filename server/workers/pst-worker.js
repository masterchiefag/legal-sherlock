import { workerData, parentPort } from 'worker_threads';
import pkg from 'pst-extractor';
const { PSTFile, PSTFolder, PSTMessage } = pkg;
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { extractText } from '../lib/extract.js';
import { resolveThreadId, backfillThread } from '../lib/threading.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const { jobId, filename, filepath, originalname } = workerData;

let totalEmails = 0;
let totalAttachments = 0;
let errorLog = [];

// Batch size for transaction commits
const BATCH_SIZE = 50;
let batchBuffer = [];

// Prepared statements for Phase 1
const insertEmail = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, message_id, in_reply_to, email_references,
        email_from, email_to, email_cc, email_subject, email_date
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAttachment = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?)
`);

const updateProgress = db.prepare(
    "UPDATE import_jobs SET total_emails = ?, total_attachments = ?, phase = ? WHERE id = ?"
);

const updateExtractionProgress = db.prepare(
    "UPDATE import_jobs SET progress_percent = ?, phase = 'extracting' WHERE id = ?"
);

const updateDocText = db.prepare(
    "UPDATE documents SET text_content = ?, status = 'ready' WHERE id = ?"
);

// Batched transaction wrapper
const flushBatch = db.transaction((ops) => {
    for (const op of ops) {
        op();
    }
});

function flushPendingOps() {
    if (batchBuffer.length === 0) return;
    flushBatch(batchBuffer);
    batchBuffer = [];
}

async function main() {
    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'importing' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Disable FTS INSERT trigger for bulk import
        // ═══════════════════════════════════════════
        db.exec('DROP TRIGGER IF EXISTS documents_ai');
        console.log('✦ PST Import: disabled FTS INSERT trigger for bulk import');

        const pstFile = new PSTFile(filepath);

        // ═══════════════════════════════════════════
        // Phase 1: Walk PST, insert emails + write attachment files
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1: Importing emails and attachments...');
        await walkFolder(pstFile.getRootFolder());

        // Flush any remaining batched operations
        flushPendingOps();

        console.log(`✦ PST Import Phase 1 complete: ${totalEmails} emails, ${totalAttachments} attachments`);

        // ═══════════════════════════════════════════
        // Phase 2: Extract text from attachments
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 2: Extracting text from attachments...');
        updateProgress.run(totalEmails, totalAttachments, 'extracting', jobId);

        const pendingDocs = db.prepare(
            "SELECT id, filename, mime_type FROM documents WHERE status = 'processing' AND doc_type = 'attachment'"
        ).all();

        const totalPending = pendingDocs.length;
        let extracted = 0;

        // Batch text extraction updates in transactions too
        const extractionBatch = [];

        for (const doc of pendingDocs) {
            const filePath = path.join(UPLOADS_DIR, doc.filename);
            let text = '';
            try {
                text = await extractText(filePath, doc.mime_type);
            } catch (e) {
                text = `[Could not extract text: ${e.message}]`;
            }

            extractionBatch.push(() => updateDocText.run(text, doc.id));
            extracted++;

            // Flush extraction batch every 20 documents
            if (extractionBatch.length >= 20) {
                db.transaction((ops) => { for (const op of ops) op(); })(extractionBatch);
                extractionBatch.length = 0;
            }

            if (extracted % 5 === 0 || extracted === totalPending) {
                const pct = Math.round((extracted / totalPending) * 100);
                updateExtractionProgress.run(pct, jobId);
            }
        }

        // Flush remaining extraction batch
        if (extractionBatch.length > 0) {
            db.transaction((ops) => { for (const op of ops) op(); })(extractionBatch);
        }

        console.log(`✦ PST Import Phase 2 complete: extracted text from ${extracted} attachments`);

        // ═══════════════════════════════════════════
        // Recreate FTS INSERT trigger + rebuild index
        // ═══════════════════════════════════════════
        console.log('✦ Rebuilding FTS index...');
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
            END;
        `);
        db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
        console.log('✦ FTS index rebuilt');

        db.prepare(`
            UPDATE import_jobs
            SET status = 'completed',
                phase = 'completed',
                total_emails = ?,
                total_attachments = ?,
                progress_percent = 100,
                error_log = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(totalEmails, totalAttachments, JSON.stringify(errorLog), jobId);

    } catch (err) {
        console.error("Worker fatal error:", err);
        // Ensure FTS trigger is restored even on failure
        try {
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                    INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                    VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
                END;
            `);
        } catch (_) { /* best effort */ }

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
                    processAndInsertEmail(email);
                    totalEmails++;

                    // Flush batch and update progress periodically
                    if (totalEmails % BATCH_SIZE === 0) {
                        flushPendingOps();
                        updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);

                        // Hint GC to clear memory
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
function processAndInsertEmail(msg) {
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

    // Queue email insert into batch
    batchBuffer.push(() => {
        insertEmail.run(
            emailId, emailFilename, `${originalname} — ${subject}`, 'message/rfc822', sizeBytes, textBody,
            threadId, messageId, inReplyTo, references,
            from, msg.displayTo || '', msg.displayCC || '', subject, date
        );
    });

    batchBuffer.push(() => backfillThread(threadId, messageId, references));

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

        // Get the accurate stream length to avoid PST nodeEOF bugs
        const streamLength = att.fileInputStream?.length?.toNumber() || 0;
        let totalWritten = 0;

        if (streamLength > 0) {
            // Stream from PST to disk
            const fd = fs.openSync(attPath, 'w');

            while (totalWritten < streamLength) {
                const remaining = streamLength - totalWritten;
                const chunkSize = Math.min(8176, remaining);
                const buf = Buffer.alloc(chunkSize);

                att.fileInputStream?.read(buf);
                fs.writeSync(fd, buf, 0, chunkSize, null);
                totalWritten += chunkSize;
            }
            fs.closeSync(fd);
        }

        // Queue attachment insert (no text extraction — deferred to Phase 2)
        const capturedAttId = attId;
        const capturedAttFilename = attFilename;
        const capturedAttName = attName;
        const capturedContentType = contentType;
        const capturedTotalWritten = totalWritten;
        const capturedEmailId = emailId;
        const capturedThreadId = threadId;

        batchBuffer.push(() => {
            insertAttachment.run(
                capturedAttId, capturedAttFilename, capturedAttName,
                capturedContentType, capturedTotalWritten,
                capturedEmailId, capturedThreadId
            );
        });

        totalAttachments++;
    }
}

// Start worker
main();
