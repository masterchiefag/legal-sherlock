import { workerData, Worker } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { resolveThreadId, backfillThread, initCache } from '../lib/threading-cached.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const EML_PARSE_WORKER = path.join(__dirname, 'eml-parse-worker.js');

const { jobId, filename, filepath, originalname, investigation_id, resume } = workerData;

// Thread pool size for parallel email parsing
const PARSE_CONCURRENCY = Math.max(2, Math.min(os.cpus().length - 1, 6));
const PHASE2_CONCURRENCY = 4;
const DB_BATCH_SIZE = 100;

let totalEmails = 0;
let totalAttachments = 0;
let errorLog = [];
let batchBuffer = [];

// Prepared statements
const insertEmail = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, message_id, in_reply_to, email_references,
        email_from, email_to, email_cc, email_subject, email_date,
        email_bcc, email_headers_raw, email_received_chain,
        email_originating_ip, email_auth_results, email_server_info, email_delivery_date,
        investigation_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAttachment = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate, investigation_id
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?)
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

const updateDocMeta = db.prepare(
    `UPDATE documents SET doc_author = ?, doc_title = ?, doc_created_at = ?,
     doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ? WHERE id = ?`
);

// Batched transaction wrapper
const flushBatch = db.transaction((ops) => {
    for (const op of ops) op();
});

function flushPendingOps() {
    if (batchBuffer.length === 0) return;
    flushBatch(batchBuffer);
    batchBuffer = [];
}

// In-memory hash set for fast dedup within this import
const seenHashes = new Map(); // hash → filename (so duplicates can reference existing file)

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

// Bounded concurrency helper
async function runConcurrent(items, concurrency, fn) {
    let index = 0;
    async function worker() {
        while (index < items.length) {
            const i = index++;
            await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

async function main() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-import-'));

    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'importing' WHERE id = ?").run(jobId);

        // Disable FTS triggers for bulk import
        db.exec('DROP TRIGGER IF EXISTS documents_ai');
        db.exec('DROP TRIGGER IF EXISTS documents_au');
        console.log('✦ PST Import: disabled FTS triggers for bulk import');

        // ═══════════════════════════════════════════
        // Phase 0: Run readpst to extract .eml files
        // ═══════════════════════════════════════════
        console.log(`✦ PST Import: extracting with readpst: ${filepath}`);

        try {
            await execFileAsync('which', ['readpst']);
        } catch (_) {
            throw new Error('readpst not found. Install it with: brew install libpst');
        }

        try {
            await execFileAsync('readpst', ['-e', '-D', '-o', tmpDir, filepath], {
                maxBuffer: 50 * 1024 * 1024,
                timeout: 30 * 60 * 1000,
            });
        } catch (err) {
            const emlCount = findEmlFiles(tmpDir).length;
            if (emlCount === 0) {
                throw new Error(`readpst failed: ${err.stderr?.substring(0, 500) || err.message}`);
            }
            console.warn('✦ PST Import: readpst exited with warnings but produced output:', err.stderr?.substring(0, 200));
        }

        const emlFiles = findEmlFiles(tmpDir);
        console.log(`✦ PST Import: readpst extracted ${emlFiles.length} .eml files`);

        // ═══════════════════════════════════════════
        // Phase 1: Parse .eml files sequentially, async file writes
        // Sequential because: threading/backfill needs consistent DB state,
        // and SQLite single-writer means concurrent DB ops just contend.
        // Optimization: async file writes + in-memory dedup hash set.
        // Resume mode: skip emails already imported (by message_id).
        // ═══════════════════════════════════════════

        // Build set of already-imported message_ids for resume
        const knownMessageIds = new Set();
        if (resume) {
            const existing = db.prepare(
                "SELECT message_id FROM documents WHERE investigation_id = ? AND doc_type = 'email' AND message_id IS NOT NULL"
            ).all(investigation_id);
            for (const row of existing) knownMessageIds.add(row.message_id);
            console.log(`✦ PST Import (RESUME): ${knownMessageIds.size} emails already imported, will skip`);
        }
        let skipped = 0;

        console.log(`✦ PST Import Phase 1: Importing emails and attachments (${PARSE_CONCURRENCY} parse threads)...`);

        // Filter out already-imported emails quickly in resume mode
        let filesToProcess = emlFiles;
        if (resume && knownMessageIds.size > 0) {
            console.log(`✦ PST Import (RESUME): fast-scanning headers to skip known emails...`);
            const scanStart = Date.now();
            filesToProcess = [];
            for (const emlPath of emlFiles) {
                try {
                    const headerChunk = await fsp.readFile(emlPath, { encoding: 'utf8', flag: 'r' }).then(
                        content => content.substring(0, 4096)
                    );
                    const msgIdMatch = headerChunk.match(/^Message-ID:\s*<?([^>\r\n]+)>?/mi);
                    if (msgIdMatch && knownMessageIds.has(msgIdMatch[1].trim())) {
                        skipped++;
                        continue;
                    }
                } catch (_) { /* parse anyway if header scan fails */ }
                filesToProcess.push(emlPath);
            }
            console.log(`✦ PST Import (RESUME): skipped ${skipped} in ${Date.now() - scanStart}ms, ${filesToProcess.length} to process`);
        }

        // Initialize threading cache — avoids 3-5 DB SELECTs per email
        initCache(investigation_id);

        // Single-threaded parsing with postal-mime (5.8x faster than simpleParser)
        for (const emlPath of filesToProcess) {
            try {
                const eml = await parseEml(emlPath);

                await processEmail(eml);
                totalEmails++;

                if (totalEmails === 1 || totalEmails % DB_BATCH_SIZE === 0) {
                    flushPendingOps();
                    updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
                    console.log(`✦ PST Import: ${totalEmails} emails, ${totalAttachments} attachments processed`);
                }
            } catch (err) {
                errorLog.push({ file: path.basename(emlPath), error: err.message });
            }
        }

        flushPendingOps();
        updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
        console.log(`✦ PST Import Phase 1 complete: ${totalEmails} new emails, ${totalAttachments} attachments${resume ? `, ${skipped} skipped (already imported)` : ''}`);

        // Record Phase 1 completion time
        db.prepare("UPDATE import_jobs SET phase1_completed_at = datetime('now') WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Phase 2: Extract text from attachments (concurrent I/O, batched DB writes)
        // Text extraction (pdf-parse, mammoth) is async I/O-bound, so concurrency helps.
        // DB writes are collected and flushed in batches to avoid lock contention.
        // ═══════════════════════════════════════════
        console.log(`✦ PST Import Phase 2: Extracting text (concurrency=${PHASE2_CONCURRENCY})...`);
        updateProgress.run(totalEmails, totalAttachments, 'extracting', jobId);

        const pendingDocs = db.prepare(
            "SELECT id, filename, mime_type FROM documents WHERE status = 'processing' AND doc_type = 'attachment' AND investigation_id = ?"
        ).all(investigation_id);

        const totalPending = pendingDocs.length;
        let extracted = 0;
        let extractionOps = [];

        await runConcurrent(pendingDocs, PHASE2_CONCURRENCY, async (doc) => {
            const filePath = path.join(UPLOADS_DIR, doc.filename);
            let text = '';
            try {
                text = await extractText(filePath, doc.mime_type);
            } catch (e) {
                text = `[Could not extract text: ${e.message}]`;
            }

            let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
            try {
                meta = await extractMetadata(filePath, doc.mime_type);
            } catch (_) { /* best effort */ }

            const docId = doc.id;
            extractionOps.push(
                () => updateDocText.run(text, docId),
                () => updateDocMeta.run(meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords, docId)
            );
            extracted++;

            // Flush DB writes in batches — all at once, not per-document
            if (extractionOps.length >= DB_BATCH_SIZE) {
                const ops = extractionOps;
                extractionOps = [];
                flushBatch(ops);
            }

            if (extracted % 50 === 0 || extracted === totalPending) {
                const pct = Math.round((extracted / totalPending) * 100);
                updateExtractionProgress.run(pct, jobId);
                console.log(`✦ PST Import Phase 2: ${extracted}/${totalPending} (${pct}%)`);
            }
        });

        if (extractionOps.length > 0) flushBatch(extractionOps);

        console.log(`✦ PST Import Phase 2 complete: extracted text from ${extracted} attachments`);

        // ═══════════════════════════════════════════
        // Recreate FTS triggers + rebuild index
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
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            console.log('✦ PST Import: cleaned up temp directory');
        } catch (_) { /* best effort */ }
    }
}

async function processEmail(eml) {
    const emailId = uuidv4();
    const emailFilename = `${emailId}.eml`;
    const textBody = eml.textBody || '';
    const sizeBytes = textBody.length;
    const subject = eml.subject || '(no subject)';

    const threadId = resolveThreadId(eml.messageId, eml.inReplyTo, eml.references);

    batchBuffer.push(() => {
        insertEmail.run(
            emailId, emailFilename, `${originalname} — ${subject}`, 'message/rfc822', sizeBytes, textBody,
            threadId, eml.messageId, eml.inReplyTo, eml.references,
            eml.from, eml.to, eml.cc, subject, eml.date,
            eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
            eml.originatingIp || null, eml.authResults || null,
            eml.serverInfo || null, eml.deliveryDate || null,
            investigation_id
        );
    });

    batchBuffer.push(() => backfillThread(threadId, eml.messageId, eml.references));

    // Write attachments async, hash in-memory for dedup
    const writePromises = [];

    for (const att of eml.attachments) {
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attFilename = `${attId}${attExt}`;
        const attPath = path.join(UPLOADS_DIR, attFilename);

        // Hash in memory — check in-memory map instead of DB query per attachment
        const attHash = crypto.createHash('md5').update(att.content).digest('hex');
        const isDuplicate = seenHashes.has(attHash) ? 1 : 0;

        // Skip file write for duplicates — reuse existing file, save ~80% of I/O
        let finalFilename = attFilename;
        if (isDuplicate) {
            finalFilename = seenHashes.get(attHash); // point to existing file
        } else {
            seenHashes.set(attHash, attFilename);
            writePromises.push(fsp.writeFile(attPath, att.content));
        }

        const dbFilename = finalFilename;
        batchBuffer.push(() => {
            insertAttachment.run(
                attId, dbFilename, att.filename,
                att.contentType, att.size,
                emailId, threadId,
                null, null, null, null, null, null,
                attHash, isDuplicate, investigation_id
            );
        });

        totalAttachments++;
    }

    // Wait for all file writes to finish before moving to next email
    if (writePromises.length > 0) await Promise.all(writePromises);
}

// Start worker
main();
