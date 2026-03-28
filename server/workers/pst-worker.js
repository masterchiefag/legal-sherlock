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
import { resolveThreadId, backfillThread, updateCacheOnly, initCache } from '../lib/threading-cached.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const EML_PARSE_WORKER = path.join(__dirname, 'eml-parse-worker.js');

const { jobId, filename, filepath, originalname, investigation_id, resume } = workerData;

// Thread pool size for parallel email parsing
const PARSE_CONCURRENCY = Math.max(2, Math.min(os.cpus().length - 1, 6));
const PHASE2_CONCURRENCY = 4;
const DB_BATCH_SIZE = 500; // Larger batches = fewer transactions = faster
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB — skip writing larger files to disk

// Initialize from existing job counts on resume so UI doesn't reset to 0
const existingJob = resume
    ? db.prepare('SELECT total_emails, total_attachments FROM import_jobs WHERE id = ?').get(jobId)
    : null;
let totalEmails = existingJob?.total_emails || 0;
let totalAttachments = existingJob?.total_attachments || 0;
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
const seenMessageIds = new Set(); // deduplicate emails by message_id (OST/PST store same email in multiple folders)

// ═══════════════════════════════════════════════════
// Performance instrumentation
// ═══════════════════════════════════════════════════
const perfStats = {
    parseTime: 0,      // time in parseEml()
    threadTime: 0,     // time in resolveThreadId + backfillThread
    hashTime: 0,       // time hashing attachments
    writeTime: 0,      // time writing files to disk
    dbFlushTime: 0,    // time flushing DB batches
    dbFlushCount: 0,
    emailCount: 0,
    attWritten: 0,
    attSkippedDupe: 0,
    attSkippedSize: 0,
    largestAttMs: 0,
    largestAttName: '',
};

function logPerfSummary() {
    const total = perfStats.parseTime + perfStats.threadTime + perfStats.hashTime + perfStats.writeTime + perfStats.dbFlushTime;
    const pct = (ms) => total > 0 ? ((ms / total) * 100).toFixed(1) + '%' : '0%';
    console.log(`✦ PERF [${perfStats.emailCount} emails] parse=${(perfStats.parseTime/1000).toFixed(1)}s(${pct(perfStats.parseTime)}) thread=${(perfStats.threadTime/1000).toFixed(1)}s(${pct(perfStats.threadTime)}) hash=${(perfStats.hashTime/1000).toFixed(1)}s(${pct(perfStats.hashTime)}) write=${(perfStats.writeTime/1000).toFixed(1)}s(${pct(perfStats.writeTime)}) dbFlush=${(perfStats.dbFlushTime/1000).toFixed(1)}s(${pct(perfStats.dbFlushTime)}) | att: ${perfStats.attWritten} written, ${perfStats.attSkippedDupe} dupe-skip, ${perfStats.attSkippedSize} size-skip`);
    if (perfStats.largestAttName) console.log(`✦ PERF slowest write: ${perfStats.largestAttName} (${perfStats.largestAttMs}ms)`);
}

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
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);

        // Disable FTS triggers for bulk import
        db.exec('DROP TRIGGER IF EXISTS documents_ai');
        db.exec('DROP TRIGGER IF EXISTS documents_au');
        console.log('✦ PST Import: disabled FTS triggers for bulk import');

        // Drop non-essential indexes for faster bulk INSERTs (rebuilt after import)
        const BULK_DROP_INDEXES = [
            'idx_documents_status',
            'idx_documents_doc_type',
            'idx_documents_status_doctype',
            'idx_documents_thread_doctype',
            'idx_documents_content_hash',
            'idx_documents_is_duplicate',
            'idx_documents_inv_doctype',
        ];
        for (const idx of BULK_DROP_INDEXES) {
            db.exec(`DROP INDEX IF EXISTS ${idx}`);
        }
        console.log(`✦ PST Import: dropped ${BULK_DROP_INDEXES.length} non-essential indexes for bulk import`);

        // Checkpoint WAL to reduce write overhead
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            console.log('✦ PST Import: WAL checkpointed');
        } catch (e) {
            console.warn('✦ PST Import: WAL checkpoint failed:', e.message);
        }

        // Increase page cache for bulk operations
        db.pragma('cache_size = -64000'); // 64MB cache

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

        // Store total eml count and switch to importing phase
        db.prepare("UPDATE import_jobs SET total_eml_files = ?, phase = 'importing' WHERE id = ?").run(emlFiles.length, jobId);

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

        // Seed message_id dedup set from known emails (covers resume + multi-folder dedup)
        if (knownMessageIds.size > 0) {
            for (const mid of knownMessageIds) seenMessageIds.add(mid);
        }

        // Initialize threading cache — avoids 3-5 DB SELECTs per email
        initCache(investigation_id);

        // Initialize counter from existing emails so resume doesn't overwrite
        if (resume) {
            const existingCount = db.prepare("SELECT COUNT(*) as c FROM documents WHERE investigation_id = ? AND doc_type = 'email'").get(investigation_id);
            const existingAtts = db.prepare("SELECT COUNT(*) as c FROM documents WHERE investigation_id = ? AND doc_type = 'attachment'").get(investigation_id);
            totalEmails = existingCount.c;
            totalAttachments = existingAtts.c;
            console.log(`✦ PST Import (RESUME): starting counters at ${totalEmails} emails, ${totalAttachments} attachments`);
        }

        // Single-threaded parsing with postal-mime (5.8x faster than simpleParser)
        let fileIdx = 0;
        for (const emlPath of filesToProcess) {
            fileIdx++;
            try {
                if (fileIdx <= 3 || fileIdx % 50 === 0) {
                    console.log(`✦ PST Import: parsing file ${fileIdx}/${filesToProcess.length}: ${path.basename(emlPath)}`);
                }
                const t0 = Date.now();
                const eml = await parseEml(emlPath);
                const parseMs = Date.now() - t0;
                perfStats.parseTime += parseMs;
                if (parseMs > 5000) console.log(`✦ PERF WARNING: slow parse ${parseMs}ms for ${path.basename(emlPath)} (${eml.attachments.length} attachments)`);

                // Skip duplicate emails (same message in multiple Outlook folders)
                if (eml.messageId && seenMessageIds.has(eml.messageId)) {
                    continue;
                }
                if (eml.messageId) seenMessageIds.add(eml.messageId);

                await processEmail(eml);
                totalEmails++;
                perfStats.emailCount = totalEmails;

                if (totalEmails === 1 || totalEmails % DB_BATCH_SIZE === 0) {
                    const tFlush = Date.now();
                    flushPendingOps();
                    perfStats.dbFlushTime += Date.now() - tFlush;
                    perfStats.dbFlushCount++;
                    updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
                    console.log(`✦ PST Import: ${totalEmails} emails, ${totalAttachments} attachments processed`);
                    logPerfSummary();
                }
            } catch (err) {
                errorLog.push({ file: path.basename(emlPath), error: err.message });
            }
        }

        flushPendingOps();
        updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
        console.log(`✦ PST Import Phase 1 complete: ${totalEmails} new emails, ${totalAttachments} attachments${resume ? `, ${skipped} skipped (already imported)` : ''}`);
        logPerfSummary();

        // Bulk backfill threading — deferred from per-email processing for performance
        // Now that all emails are inserted, resolve threads in a single pass
        console.log('✦ PST Import: backfilling thread IDs...');
        const backfillStart = Date.now();
        const allEmails = db.prepare(
            "SELECT id, thread_id, message_id, in_reply_to, email_references FROM documents WHERE investigation_id = ? AND doc_type = 'email' AND message_id IS NOT NULL"
        ).all(investigation_id);
        let backfillUpdates = 0;
        const backfillTx = db.transaction(() => {
            for (const email of allEmails) {
                const resolvedThread = resolveThreadId(email.message_id, email.in_reply_to, email.email_references);
                if (resolvedThread !== email.thread_id) {
                    db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?').run(resolvedThread, email.id);
                    // Also update attachments of this email
                    db.prepare('UPDATE documents SET thread_id = ? WHERE parent_id = ?').run(resolvedThread, email.id);
                    backfillUpdates++;
                }
            }
        });
        backfillTx();
        console.log(`✦ PST Import: thread backfill done in ${((Date.now() - backfillStart) / 1000).toFixed(1)}s (${backfillUpdates} updates)`);

        // Record Phase 1 completion time
        db.prepare("UPDATE import_jobs SET phase1_completed_at = datetime('now') WHERE id = ?").run(jobId);

        // Rebuild indexes dropped for bulk import
        console.log('✦ PST Import: rebuilding indexes...');
        const rebuildStart = Date.now();
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_documents_inv_doctype ON documents(investigation_id, doc_type)');
        console.log(`✦ PST Import: indexes rebuilt in ${((Date.now() - rebuildStart) / 1000).toFixed(1)}s`);

        // Checkpoint WAL after bulk writes
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            console.log('✦ PST Import: WAL checkpointed after Phase 1');
        } catch (_) {}

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
            // Skip text extraction for oversized files (no file on disk)
            if (!doc.filename) {
                extracted++;
                return;
            }
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

        // Auto-cleanup: delete source PST/OST file after successful import
        try {
            fs.unlinkSync(filepath);
            console.log('✦ PST Import: deleted source file to free disk space');
        } catch (e) {
            console.warn('✦ PST Import: could not delete source file:', e.message);
        }

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

        // Rebuild indexes in case they were dropped
        try {
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_documents_inv_doctype ON documents(investigation_id, doc_type)');
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

    const tThread = Date.now();
    const threadId = resolveThreadId(eml.messageId, eml.inReplyTo, eml.references);
    perfStats.threadTime += Date.now() - tThread;

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

    // Defer backfill to end of Phase 1 — during bulk import, backfillThread does
    // expensive UPDATE...WHERE thread_id=? scans that account for 96% of flush time.
    // Instead, just update the in-memory cache and do a single backfill pass at the end.
    updateCacheOnly(threadId, eml.messageId, eml.references);

    // Write attachments async, hash in-memory for dedup
    const writePromises = [];

    for (const att of eml.attachments) {
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attFilename = `${attId}${attExt}`;
        const attPath = path.join(UPLOADS_DIR, attFilename);

        // Skip writing large attachments to disk (>100MB) — record in DB with note
        const isOversized = att.size > MAX_ATTACHMENT_SIZE;

        // Hash in memory — check in-memory map instead of DB query per attachment
        const tHash = Date.now();
        const attHash = isOversized ? null : crypto.createHash('md5').update(att.content).digest('hex');
        perfStats.hashTime += Date.now() - tHash;
        const isDuplicate = attHash && seenHashes.has(attHash) ? 1 : 0;

        // Skip file write for duplicates or oversized — reuse existing file or skip entirely
        let finalFilename = attFilename;
        if (isOversized) {
            finalFilename = null; // no file on disk
            perfStats.attSkippedSize++;
        } else if (isDuplicate) {
            finalFilename = seenHashes.get(attHash); // point to existing file
            perfStats.attSkippedDupe++;
        } else {
            seenHashes.set(attHash, attFilename);
            const tWrite = Date.now();
            writePromises.push(fsp.writeFile(attPath, att.content).then(() => {
                const writeMs = Date.now() - tWrite;
                perfStats.writeTime += writeMs;
                perfStats.attWritten++;
                if (writeMs > perfStats.largestAttMs) {
                    perfStats.largestAttMs = writeMs;
                    perfStats.largestAttName = `${att.filename} (${(att.size/1024).toFixed(0)}KB)`;
                }
            }));
        }

        const dbFilename = finalFilename;
        const oversizeNote = isOversized
            ? `[File too large: ${(att.size / 1e6).toFixed(0)}MB — raw file not saved to conserve disk space]`
            : null;
        batchBuffer.push(() => {
            insertAttachment.run(
                attId, dbFilename, att.filename,
                att.contentType, att.size,
                emailId, threadId,
                oversizeNote, null, null, null, null, null,
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
