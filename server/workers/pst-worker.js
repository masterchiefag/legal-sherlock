import { workerData } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { resolveThreadId, backfillThread } from '../lib/threading.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const { jobId, filepath, originalname } = workerData;

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
        email_from, email_to, email_cc, email_subject, email_date,
        email_bcc, email_headers_raw, email_received_chain,
        email_originating_ip, email_auth_results, email_server_info, email_delivery_date
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAttachment = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?)
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

// Recursively find all .eml files in a directory
function findEmlFiles(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findEmlFiles(fullPath));
        } else if (entry.name.endsWith('.eml')) {
            results.push(fullPath);
        }
    }
    return results;
}

async function main() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-import-'));

    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'importing' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Disable FTS triggers for bulk import
        // ═══════════════════════════════════════════
        db.exec('DROP TRIGGER IF EXISTS documents_ai');
        db.exec('DROP TRIGGER IF EXISTS documents_au');
        console.log('✦ PST Import: disabled FTS triggers for bulk import');

        // ═══════════════════════════════════════════
        // Phase 1a: Run readpst to extract .eml files
        // ═══════════════════════════════════════════
        console.log(`✦ PST Import: extracting with readpst: ${filepath}`);

        // Verify readpst is installed
        try {
            await execFileAsync('which', ['readpst']);
        } catch (_) {
            throw new Error('readpst not found. Install it with: brew install libpst');
        }

        try {
            await execFileAsync('readpst', ['-e', '-D', '-o', tmpDir, filepath], {
                maxBuffer: 50 * 1024 * 1024, // 50MB stdout buffer
                timeout: 30 * 60 * 1000, // 30 min timeout
            });
        } catch (err) {
            // readpst may exit non-zero but still produce valid output
            const emlCount = findEmlFiles(tmpDir).length;
            if (emlCount === 0) {
                throw new Error(`readpst failed: ${err.stderr?.substring(0, 500) || err.message}`);
            }
            console.warn('✦ PST Import: readpst exited with warnings but produced output:', err.stderr?.substring(0, 200));
        }

        const emlFiles = findEmlFiles(tmpDir);
        console.log(`✦ PST Import: readpst extracted ${emlFiles.length} .eml files`);

        // ═══════════════════════════════════════════
        // Phase 1b: Parse each .eml and insert into DB
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1: Importing emails and attachments...');

        for (const emlPath of emlFiles) {
            try {
                const eml = await parseEml(emlPath);
                processEmail(eml);
                totalEmails++;

                // Flush batch and update progress periodically
                if (totalEmails === 1 || totalEmails % BATCH_SIZE === 0) {
                    flushPendingOps();
                    updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
                    console.log(`✦ PST Import: ${totalEmails} emails, ${totalAttachments} attachments processed`);
                }
            } catch (err) {
                errorLog.push({ file: path.basename(emlPath), error: err.message });
            }
        }

        // Flush any remaining batched operations
        flushPendingOps();
        updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);

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

        const extractionBatch = [];

        // Prepare statement for updating doc metadata
        const updateDocMeta = db.prepare(
            `UPDATE documents SET doc_author = ?, doc_title = ?, doc_created_at = ?,
             doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ? WHERE id = ?`
        );

        for (const doc of pendingDocs) {
            const filePath = path.join(UPLOADS_DIR, doc.filename);
            let text = '';
            try {
                text = await extractText(filePath, doc.mime_type);
            } catch (e) {
                text = `[Could not extract text: ${e.message}]`;
            }

            // Extract document metadata (author, title, dates, etc.)
            let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
            try {
                meta = await extractMetadata(filePath, doc.mime_type);
            } catch (_) { /* best effort */ }

            extractionBatch.push(() => updateDocText.run(text, doc.id));
            extractionBatch.push(() => updateDocMeta.run(
                meta.author, meta.title, meta.createdAt,
                meta.modifiedAt, meta.creatorTool, meta.keywords, doc.id
            ));
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
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
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
        // Ensure FTS triggers are restored even on failure
        try {
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                    INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                    VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
                END;
            `);
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                    INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
                    VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
                    INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                    VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
                END;
            `);
            db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
        } catch (_) { /* best effort */ }

        db.prepare(`
            UPDATE import_jobs
            SET status = 'failed',
                error_log = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify([{ error: err.message, fatal: true }]), jobId);
    } finally {
        // Clean up temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            console.log('✦ PST Import: cleaned up temp directory');
        } catch (_) { /* best effort */ }
    }
}

function processEmail(eml) {
    const emailId = uuidv4();
    const emailFilename = `${emailId}.eml`;

    const textBody = eml.textBody || '';
    const sizeBytes = textBody.length;
    const subject = eml.subject || '(no subject)';

    const threadId = resolveThreadId(eml.messageId, eml.inReplyTo, eml.references);

    // Queue email insert into batch (with transport metadata)
    batchBuffer.push(() => {
        insertEmail.run(
            emailId, emailFilename, `${originalname} — ${subject}`, 'message/rfc822', sizeBytes, textBody,
            threadId, eml.messageId, eml.inReplyTo, eml.references,
            eml.from, eml.to, eml.cc, subject, eml.date,
            eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
            eml.originatingIp || null, eml.authResults || null,
            eml.serverInfo || null, eml.deliveryDate || null
        );
    });

    batchBuffer.push(() => backfillThread(threadId, eml.messageId, eml.references));

    // Write attachments to disk
    for (const att of eml.attachments) {
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attFilename = `${attId}${attExt}`;
        const attPath = path.join(UPLOADS_DIR, attFilename);

        fs.writeFileSync(attPath, att.content);

        // Compute content hash for deduplication
        const attHash = crypto.createHash('md5').update(att.content).digest('hex');
        const existingWithHash = db.prepare(`SELECT id FROM documents WHERE content_hash = ? LIMIT 1`).get(attHash);
        const capturedIsDuplicate = existingWithHash ? 1 : 0;

        const capturedAttId = attId;
        const capturedAttFilename = attFilename;
        const capturedAttName = att.filename;
        const capturedContentType = att.contentType;
        const capturedSize = att.size;
        const capturedEmailId = emailId;
        const capturedThreadId = threadId;
        const capturedHash = attHash;

        batchBuffer.push(() => {
            insertAttachment.run(
                capturedAttId, capturedAttFilename, capturedAttName,
                capturedContentType, capturedSize,
                capturedEmailId, capturedThreadId,
                null, null, null, null, null, null,
                capturedHash, capturedIsDuplicate
            );
        });

        totalAttachments++;
    }
}

// Start worker
main();
