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
import mainDb from '../db.js';
import { openWorkerDb } from '../lib/investigation-db.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { parseMsg } from '../lib/msg-parser.js';
import { listZipContents, extractFileFromZip, detectPdfEmbeddedFiles, extractPdfEmbeddedFiles, extractTnefContents, cleanupTmpDir, SKIP_EXTS as CONTAINER_SKIP_EXTS, mimeFromExt as containerMimeFromExt } from '../lib/container-helpers.js';
import { disableFtsTriggers, enableFtsTriggers, rebuildFtsIndex, dropBulkIndexes, recreateBulkIndexes, refreshInvestigationCounts, walCheckpoint, backfillDuplicateText } from '../lib/worker-helpers.js';
import { resolveThreadId, backfillThread, updateCacheOnly, resolveThreadIdFromCache, initCache } from '../lib/threading-cached.js';
import { getSetting } from '../lib/settings.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const EML_PARSE_WORKER = path.join(__dirname, 'eml-parse-worker.js');

console.log('✦ DEBUG: workerData destructured');
const { jobId, filename, filepath, originalname, investigation_id, custodian, resume, extractionOnly, preserveSource } = workerData;
console.log('✦ DEBUG: constants initializing');

// Open per-investigation DB (documents, import_jobs, FTS, etc.)
const db = openWorkerDb(investigation_id);

// Ensure investigation subdirectory exists
const INV_UPLOADS_DIR = path.join(UPLOADS_DIR, investigation_id);
fs.mkdirSync(INV_UPLOADS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════
// Doc identifier generation: CASE_CUST_00001 for emails, CASE_CUST_00001_001 for attachments
// ═══════════════════════════════════════════════════
function getCustodianInitials(name) {
    if (!name) return 'XXX';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0].substring(0, 2) + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 3).toUpperCase();
}

const investigation = mainDb.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigation_id);
const caseCode = investigation?.short_code || 'CASE';
const custCode = getCustodianInitials(custodian);
const docIdPrefix = `${caseCode}_${custCode}`;

// Get next sequence number (resume-safe: continues from max existing)
const maxExisting = db.prepare(
    "SELECT MAX(CAST(SUBSTR(doc_identifier, ?, 5) AS INTEGER)) as max_seq FROM documents WHERE doc_identifier LIKE ? AND doc_type IN ('email', 'chat')"
).get(docIdPrefix.length + 2, `${docIdPrefix}_%`);
let docSeq = (maxExisting?.max_seq || 0);

function nextDocIdentifier() {
    docSeq++;
    return `${docIdPrefix}_${String(docSeq).padStart(5, '0')}`;
}

function attIdentifier(parentIdentifier, attIndex) {
    return `${parentIdentifier}_${String(attIndex).padStart(3, '0')}`;
}

// Read operational settings from DB (live-configurable via admin UI)
const PARSE_CONCURRENCY = getSetting('import_parse_concurrency') || Math.max(2, Math.min(os.cpus().length - 1, 6));
const PHASE2_CONCURRENCY = getSetting('import_phase2_concurrency') || 4;
const DB_BATCH_SIZE = getSetting('import_db_batch_size') || 500;
const MAX_ATTACHMENT_SIZE = (getSetting('import_max_attachment_size_mb') || 100) * 1024 * 1024;

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
        investigation_id, custodian, folder_path, text_content_size, doc_identifier, recipient_count
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAttachment = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate, investigation_id, custodian, doc_identifier
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?)
`);

const updateProgress = db.prepare(
    "UPDATE import_jobs SET total_emails = ?, total_attachments = ?, phase = ? WHERE id = ?"
);

const updateExtractionProgress = db.prepare(
    "UPDATE import_jobs SET progress_percent = ?, phase = 'extracting' WHERE id = ?"
);

const updateDocText = db.prepare(
    "UPDATE documents SET text_content = ?, text_content_size = ?, status = 'ready' WHERE id = ?"
);

const updateDocTextOcr = db.prepare(
    "UPDATE documents SET text_content = ?, text_content_size = ?, status = 'ready', ocr_applied = ?, ocr_time_ms = ? WHERE id = ?"
);

const updateDocMeta = db.prepare(
    `UPDATE documents SET doc_author = ?, doc_title = ?, doc_created_at = ?,
     doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ?,
     doc_last_modified_by = ?, doc_printed_at = ?, doc_last_accessed_at = ? WHERE id = ?`
);

console.log('✦ DEBUG: prepared statements done');
// Batched transaction wrapper
const flushBatch = db.transaction((ops) => {
    for (const op of ops) op();
});

function flushPendingOps() {
    if (batchBuffer.length === 0) return;
    try {
        flushBatch(batchBuffer);
        batchBuffer = [];
    } catch (err) {
        console.error(`✦ FLUSH ERROR (${batchBuffer.length} ops): ${err.message}`);
        // Clear the buffer even on failure — otherwise it grows unbounded
        // and every subsequent flush retries the same broken ops
        batchBuffer = [];
        throw err; // re-throw so caller sees the failure
    }
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
    console.log(`✦ DEBUG Worker started: jobId=${jobId}, resume=${resume}, extractionOnly=${extractionOnly}, investigation_id=${investigation_id}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-import-'));

    try {
        console.log('✦ DEBUG: updating job status to processing...');
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);
        console.log('✦ DEBUG: job status updated');

        // Disable FTS triggers for bulk import
        console.log('✦ DEBUG: dropping FTS triggers...');
        disableFtsTriggers(db);

        // Drop non-essential indexes for faster bulk INSERTs (rebuilt after import)
        // Skip for extractionOnly — Phase 2 only does UPDATEs, indexes aren't a bottleneck
        if (!extractionOnly) {
        dropBulkIndexes(db);
        }

        // Checkpoint WAL to reduce write overhead
        console.log('✦ DEBUG: checkpointing WAL...');
        walCheckpoint(db);

        // Increase page cache for bulk operations
        console.log('✦ DEBUG: setting cache size...');
        db.pragma('cache_size = -64000'); // 64MB cache
        console.log('✦ DEBUG: cache size set, checking extractionOnly...');

        // ═══════════════════════════════════════════
        // Phase 0 & 1: Skip if extractionOnly (source file deleted, just do Phase 2)
        // ═══════════════════════════════════════════
        if (extractionOnly) {
            console.log(`✦ PST Import (EXTRACTION ONLY): source file deleted, skipping Phase 0 & 1, jumping to Phase 2`);
            const existingCounts = db.prepare("SELECT COUNT(*) as emails FROM documents WHERE investigation_id = ? AND doc_type = 'email'").get(investigation_id);
            const existingAttCounts = db.prepare("SELECT COUNT(*) as atts FROM documents WHERE investigation_id = ? AND doc_type = 'attachment'").get(investigation_id);
            totalEmails = existingCounts.emails;
            totalAttachments = existingAttCounts.atts;
        } else {

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
        initCache(db, investigation_id);

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

                // Derive folder path from PST directory structure
                const relPath = path.relative(tmpDir, emlPath);
                const folderPath = path.dirname(relPath).replace(/\\/g, '/');
                eml._folderPath = folderPath === '.' ? '/' : '/' + folderPath;

                const result = await processEmail(eml);
                if (eml._warnings?.length > 0) {
                    for (const w of eml._warnings) {
                        errorLog.push({ type: w.type, subject: eml.subject, docId: result.emailId, raw: w.raw });
                    }
                }
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
                } else if (totalEmails % 50 === 0) {
                    // Lightweight progress update for UI polling (no flush)
                    updateProgress.run(totalEmails, totalAttachments, 'importing', jobId);
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
        const updateEmailThread = db.prepare('UPDATE documents SET thread_id = ? WHERE id = ?');
        const updateAttThread = db.prepare('UPDATE documents SET thread_id = ? WHERE parent_id = ?');
        const backfillTx = db.transaction(() => {
            for (const email of allEmails) {
                const resolvedThread = resolveThreadIdFromCache(email.message_id, email.in_reply_to, email.email_references);
                if (resolvedThread && resolvedThread !== email.thread_id) {
                    updateEmailThread.run(resolvedThread, email.id);
                    updateAttThread.run(resolvedThread, email.id);
                    backfillUpdates++;
                }
            }
        });
        backfillTx();
        console.log(`✦ PST Import: thread backfill done in ${((Date.now() - backfillStart) / 1000).toFixed(1)}s (${backfillUpdates} updates)`);

        // Record Phase 1 completion time
        db.prepare("UPDATE import_jobs SET phase1_completed_at = datetime('now') WHERE id = ?").run(jobId);

        // Rebuild indexes dropped for bulk import
        recreateBulkIndexes(db);

        // Checkpoint WAL after bulk writes
        walCheckpoint(db);

        // ═══════════════════════════════════════════
        // Phase 1.5: Extract embedded MSG attachments
        // readpst -e stores forwarded/attached emails as opaque .msg files.
        // These contain document attachments (PDFs, DOCX, etc.) invisible
        // to search and review. Parse them with msgreader and insert their
        // contents as children: Email → MSG attachment → extracted files.
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1.5: Extracting embedded MSG attachments...');
        db.prepare("UPDATE import_jobs SET phase = 'msg_extraction' WHERE id = ?").run(jobId);

        // Query MSG files by name, MIME type, AND extensionless octet-stream blobs.
        // readpst -e embeds forwarded emails inside .eml files as binary attachments
        // with generic names like "attachment_12345" and application/octet-stream MIME.
        // We detect these by reading the OLE magic bytes (D0 CF 11 E0) from disk.
        const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0]);

        // Step 1: Get explicitly named .msg files + embedded .eml attachments
        const explicitMsgs = db.prepare(`
            SELECT id, filename, original_name, doc_identifier, custodian, parent_id, content_hash,
                   mime_type
            FROM documents
            WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
              AND (LOWER(original_name) LIKE '%.msg' OR LOWER(filename) LIKE '%.msg'
                   OR mime_type = 'application/vnd.ms-outlook'
                   OR mime_type = 'message/rfc822')
        `).all(investigation_id);

        // Step 2: Get extensionless octet-stream blobs that could be embedded MSGs
        const candidateBlobs = db.prepare(`
            SELECT id, filename, original_name, doc_identifier, custodian, parent_id, content_hash
            FROM documents
            WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
              AND mime_type = 'application/octet-stream'
              AND original_name NOT LIKE '%.%'
              AND size_bytes > 1000
              AND size_bytes < ?
        `).all(investigation_id, MAX_ATTACHMENT_SIZE);

        // Step 3: Check OLE magic bytes on candidates
        let oleMsgCount = 0;
        const detectedMsgs = [];
        for (const blob of candidateBlobs) {
            try {
                const blobPath = path.join(UPLOADS_DIR, blob.filename);
                if (!fs.existsSync(blobPath)) continue;
                const fd = fs.openSync(blobPath, 'r');
                const header = Buffer.alloc(4);
                fs.readSync(fd, header, 0, 4, 0);
                fs.closeSync(fd);
                if (header.equals(OLE_MAGIC)) {
                    detectedMsgs.push(blob);
                    oleMsgCount++;
                }
            } catch (_) { /* skip unreadable files */ }
        }

        const msgDocs = [...explicitMsgs, ...detectedMsgs];
        console.log(`✦ Phase 1.5: Found ${msgDocs.length} MSG attachments to process (${explicitMsgs.length} by name/MIME, ${oleMsgCount} detected by OLE magic from ${candidateBlobs.length} candidates)`);

        let msgProcessed = 0;
        let msgAttInserted = 0;
        let msgAttDupes = 0;
        let msgErrors = 0;
        let msgSkipped = 0;
        let msgTextUpdated = 0;
        const msgBatchBuffer = [];

        const insertMsgChild = db.prepare(`
            INSERT INTO documents (
                id, filename, original_name, mime_type, size_bytes, text_content, status,
                doc_type, parent_id, thread_id,
                doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
                content_hash, is_duplicate, investigation_id, custodian, doc_identifier
            ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?)
        `);

        const updateMsgText = db.prepare(
            "UPDATE documents SET text_content = ?, text_content_size = ? WHERE id = ?"
        );

        const flushMsgBatch = db.transaction((ops) => {
            for (const op of ops) op();
        });

        const msgAttsByExt = {}; // track extracted attachment types for summary

        for (let mi = 0; mi < msgDocs.length; mi++) {
            const msgDoc = msgDocs[mi];
            const msgPath = path.join(UPLOADS_DIR, msgDoc.filename);

            if (!fs.existsSync(msgPath)) {
                msgSkipped++;
                if (msgSkipped <= 5) console.log(`  ✦ Phase 1.5: MSG file missing on disk: ${msgDoc.original_name} (${msgDoc.filename})`);
                continue;
            }

            try {
                const msgBuffer = fs.readFileSync(msgPath);
                const isEmlContainer = msgDoc.mime_type === 'message/rfc822';

                // Parse as MSG (OLE binary) or EML (RFC 5322 text)
                let metadata, msgAtts;
                if (isEmlContainer) {
                    const eml = await parseEml(msgBuffer);
                    metadata = {
                        subject: eml.subject,
                        from: eml.from,
                        to: eml.to,
                        textBody: eml.textBody,
                        date: eml.date,
                    };
                    msgAtts = eml.attachments;
                } else {
                    const result = parseMsg(msgBuffer);
                    metadata = result.metadata;
                    msgAtts = result.attachments;
                }

                // Verbose logging for first 5 containers so we can confirm parsing works early
                if (msgProcessed < 5) {
                    console.log(`  ✦ Phase 1.5 [${msgProcessed + 1}]: ${isEmlContainer ? '(EML)' : '(MSG)'} "${metadata.subject}" from ${metadata.from || '?'}`);
                    console.log(`    Body: ${metadata.textBody?.length || 0} chars, Attachments: ${msgAtts.length} [${msgAtts.map(a => a.filename).join(', ')}]`);
                }

                // Update the container document's text_content with the embedded email body
                // so the forwarded email's content becomes searchable
                if (metadata.textBody && metadata.textBody.length > 0) {
                    const bodyText = `[Embedded email] From: ${metadata.from || 'unknown'}\nTo: ${metadata.to || ''}\nSubject: ${metadata.subject || ''}\nDate: ${metadata.date || ''}\n\n${metadata.textBody}`;
                    msgBatchBuffer.push(() => {
                        updateMsgText.run(bodyText, bodyText.length, msgDoc.id);
                    });
                    msgTextUpdated++;
                }

                // Get the thread_id from the parent email (for the MSG's children)
                const parentThread = db.prepare(
                    "SELECT thread_id FROM documents WHERE id = ?"
                ).get(msgDoc.parent_id);
                const threadId = parentThread?.thread_id || null;

                let childIdx = 0;
                for (const att of msgAtts) {
                    childIdx++;
                    // Track by extension for summary
                    const ext = (att.filename.match(/\.([^.]+)$/) || [, 'unknown'])[1].toLowerCase();
                    msgAttsByExt[ext] = (msgAttsByExt[ext] || 0) + 1;
                    const attId = uuidv4();
                    const attExt = path.extname(att.filename) || '.bin';
                    const attBasename = `${attId}${attExt}`;
                    const attFilename = `${investigation_id}/${attBasename}`;
                    const attPath = path.join(UPLOADS_DIR, attFilename);

                    // Hash for dedup
                    const attHash = crypto.createHash('md5').update(att.content).digest('hex');
                    const isDuplicate = seenHashes.has(attHash) ? 1 : 0;

                    let finalFilename = attFilename;
                    if (isDuplicate) {
                        finalFilename = seenHashes.get(attHash);
                        msgAttDupes++;
                    } else {
                        seenHashes.set(attHash, attFilename);
                        await fsp.writeFile(attPath, att.content);
                    }

                    const docIdentifier = msgDoc.doc_identifier
                        ? `${msgDoc.doc_identifier}_${String(childIdx).padStart(3, '0')}`
                        : null;

                    msgBatchBuffer.push(() => {
                        insertMsgChild.run(
                            attId, finalFilename, att.filename,
                            att.contentType, att.size,
                            msgDoc.id, threadId,
                            null, null, null, null, null, null,
                            attHash, isDuplicate, investigation_id, msgDoc.custodian || custodian || null,
                            docIdentifier
                        );
                    });

                    msgAttInserted++;
                    totalAttachments++;
                }

                msgProcessed++;
            } catch (err) {
                msgErrors++;
                if (msgErrors <= 20) {
                    console.warn(`  ✦ Phase 1.5 error: ${msgDoc.original_name} — ${err.message}`);
                }
                errorLog.push({ phase: 'msg_extraction', docId: msgDoc.id, filename: msgDoc.original_name, error: err.message });
            }

            // Flush in batches
            if (msgBatchBuffer.length >= DB_BATCH_SIZE) {
                try {
                    flushMsgBatch(msgBatchBuffer);
                    msgBatchBuffer.length = 0;
                } catch (err) {
                    console.error(`✦ Phase 1.5 FLUSH ERROR: ${err.message}`);
                    msgBatchBuffer.length = 0;
                }
            }

            if ((mi + 1) % 500 === 0 || mi === msgDocs.length - 1) {
                updateProgress.run(totalEmails, totalAttachments, 'msg_extraction', jobId);
                console.log(`✦ Phase 1.5: ${mi + 1}/${msgDocs.length} MSGs — ${msgAttInserted} files extracted (${msgAttDupes} dupes, ${msgErrors} errors)`);
            }
        }

        // Final flush
        if (msgBatchBuffer.length > 0) {
            try {
                flushMsgBatch(msgBatchBuffer);
                msgBatchBuffer.length = 0;
            } catch (err) {
                console.error(`✦ Phase 1.5 final FLUSH ERROR: ${err.message}`);
            }
        }

        console.log(`✦ Phase 1.5 complete: ${msgProcessed} MSGs processed, ${msgAttInserted} attachments extracted (${msgAttDupes} dupes), ${msgTextUpdated} MSG bodies updated, ${msgSkipped} skipped, ${msgErrors} errors`);

        // Log per-extension breakdown of extracted MSG attachments
        if (Object.keys(msgAttsByExt).length > 0) {
            const sorted = Object.entries(msgAttsByExt).sort((a, b) => b[1] - a[1]);
            console.log(`✦ Phase 1.5 extracted attachment types:`);
            for (const [ext, count] of sorted.slice(0, 15)) {
                console.log(`    .${ext}: ${count}`);
            }
        }

        // Record Phase 1.5 completion
        db.prepare("UPDATE import_jobs SET phase = 'msg_extraction_done' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Phase 1.6: Extract ZIP attachments
        // Relativity flattens ZIPs — extracts all files inside as child documents.
        // Without this, PDFs/DOCX/etc inside ZIPs are invisible to search.
        // Impact: ~2,500-3,000 additional documents in typical large PSTs.
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1.6: Extracting ZIP attachments...');
        db.prepare("UPDATE import_jobs SET phase = 'zip_extraction' WHERE id = ?").run(jobId);

        {
            const zipPhaseStart = Date.now();
            let zipProcessed = 0;
            let zipFilesInserted = 0;
            let zipFilesDupes = 0;
            let zipFilesSkipped = 0;
            let zipErrors = 0;
            let zipMissing = 0;
            const zipAttsByExt = {};

            // Find all non-duplicate ZIP attachments
            const zipDocs = db.prepare(`
                SELECT id, filename, original_name, doc_identifier, parent_id, custodian,
                       content_hash, mime_type
                FROM documents
                WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
                  AND (LOWER(original_name) LIKE '%.zip' OR mime_type = 'application/zip')
                ORDER BY original_name
            `).all(investigation_id);

            // Dedup ZIPs by content_hash — process each unique ZIP only once
            const processedZipHashes = new Set();
            const uniqueZips = [];
            for (const zip of zipDocs) {
                if (zip.content_hash && processedZipHashes.has(zip.content_hash)) continue;
                if (zip.content_hash) processedZipHashes.add(zip.content_hash);
                uniqueZips.push(zip);
            }

            console.log(`✦ Phase 1.6: found ${zipDocs.length} ZIP attachments (${uniqueZips.length} unique by hash)`);

            // Prepared statement for ZIP children (same schema as Phase 1.5 insertMsgChild)
            const insertZipChild = db.prepare(`
                INSERT INTO documents (
                    id, filename, original_name, mime_type, size_bytes, text_content, status,
                    doc_type, parent_id, thread_id,
                    doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
                    content_hash, is_duplicate, investigation_id, custodian, doc_identifier
                ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?)
            `);

            const zipBatchBuffer = [];
            const flushZipBatch = db.transaction((ops) => {
                for (const op of ops) op();
            });

            for (let zi = 0; zi < uniqueZips.length; zi++) {
                const zip = uniqueZips[zi];
                const zipPath = path.join(UPLOADS_DIR, zip.filename);

                if (!fs.existsSync(zipPath)) {
                    zipMissing++;
                    if (zipMissing <= 5) console.log(`  ✦ Phase 1.6: ZIP file missing on disk: ${zip.original_name} (${zip.filename})`);
                    continue;
                }

                try {
                    const entries = await listZipContents(zipPath);

                    if (entries.length === 0) {
                        zipProcessed++;
                        continue;
                    }

                    // Verbose logging for first 5 ZIPs
                    if (zipProcessed < 5) {
                        console.log(`  ✦ Phase 1.6 [${zipProcessed + 1}]: "${zip.original_name}" — ${entries.length} files inside`);
                        const sampleNames = entries.slice(0, 5).map(e => path.basename(e.path));
                        console.log(`    Sample files: ${sampleNames.join(', ')}${entries.length > 5 ? ` ... and ${entries.length - 5} more` : ''}`);
                    }

                    // Get thread_id from the ZIP's parent chain
                    const parentThread = db.prepare(
                        "SELECT thread_id FROM documents WHERE id = ?"
                    ).get(zip.parent_id);
                    const threadId = parentThread?.thread_id || null;

                    let childIdx = 0;

                    for (const entry of entries) {
                        const ext = path.extname(entry.path).toLowerCase();
                        const originalName = path.basename(entry.path);

                        // Skip images/media/executables
                        if (CONTAINER_SKIP_EXTS.has(ext)) {
                            zipFilesSkipped++;
                            continue;
                        }

                        try {
                            const fileBuffer = await extractFileFromZip(zipPath, entry.path);
                            const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');

                            // Dedup against all known hashes
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

                            const fileId = uuidv4();
                            const fileExt = ext || '.bin';
                            let diskFilename;

                            if (!isDuplicate) {
                                diskFilename = `${investigation_id}/${fileId}${fileExt}`;
                                seenHashes.set(contentHash, diskFilename);
                                await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), fileBuffer);
                            } else {
                                diskFilename = seenHashes.get(contentHash);
                                zipFilesDupes++;
                            }

                            // Track by extension for summary
                            const extKey = ext || '.unknown';
                            zipAttsByExt[extKey] = (zipAttsByExt[extKey] || 0) + 1;

                            childIdx++;
                            const docIdentifier = zip.doc_identifier
                                ? `${zip.doc_identifier}_${String(childIdx).padStart(3, '0')}`
                                : null;

                            const mime = containerMimeFromExt(ext);

                            zipBatchBuffer.push(() => {
                                insertZipChild.run(
                                    fileId, diskFilename, originalName,
                                    mime, fileBuffer.length,
                                    zip.id, threadId,
                                    null, null, null, null, null, null,
                                    contentHash, isDuplicate, investigation_id,
                                    zip.custodian || custodian || null,
                                    docIdentifier
                                );
                            });

                            zipFilesInserted++;
                            totalAttachments++;
                        } catch (err) {
                            zipErrors++;
                            if (zipErrors <= 20) {
                                errorLog.push({ phase: 'zip_extraction', zip: zip.original_name, file: entry.path, error: err.message });
                            }
                        }
                    }

                    zipProcessed++;
                } catch (err) {
                    zipErrors++;
                    if (zipErrors <= 20) {
                        console.warn(`  ✦ Phase 1.6 error: ${zip.original_name} — ${err.message}`);
                        errorLog.push({ phase: 'zip_extraction', docId: zip.id, filename: zip.original_name, error: err.message });
                    }
                }

                // Flush in batches
                if (zipBatchBuffer.length >= DB_BATCH_SIZE) {
                    try {
                        flushZipBatch(zipBatchBuffer);
                        zipBatchBuffer.length = 0;
                    } catch (err) {
                        console.error(`✦ Phase 1.6 FLUSH ERROR: ${err.message}`);
                        zipBatchBuffer.length = 0;
                    }
                }

                // Progress logging
                if ((zi + 1) % 100 === 0 || zi === uniqueZips.length - 1) {
                    updateProgress.run(totalEmails, totalAttachments, 'zip_extraction', jobId);
                    console.log(`✦ Phase 1.6: ${zi + 1}/${uniqueZips.length} ZIPs — ${zipFilesInserted} files extracted (${zipFilesDupes} dupes, ${zipFilesSkipped} skipped, ${zipErrors} errors)`);
                }
            }

            // Final flush
            if (zipBatchBuffer.length > 0) {
                try {
                    flushZipBatch(zipBatchBuffer);
                    zipBatchBuffer.length = 0;
                } catch (err) {
                    console.error(`✦ Phase 1.6 final FLUSH ERROR: ${err.message}`);
                }
            }

            const zipElapsed = ((Date.now() - zipPhaseStart) / 1000).toFixed(1);
            console.log(`✦ Phase 1.6 complete: ${zipProcessed} ZIPs processed, ${zipFilesInserted} files extracted (${zipFilesDupes} dupes, ${zipFilesSkipped} skipped, ${zipMissing} missing, ${zipErrors} errors) in ${zipElapsed}s`);

            // Log per-extension breakdown
            if (Object.keys(zipAttsByExt).length > 0) {
                const sorted = Object.entries(zipAttsByExt).sort((a, b) => b[1] - a[1]);
                console.log(`✦ Phase 1.6 extracted file types:`);
                for (const [ext, count] of sorted.slice(0, 20)) {
                    console.log(`    ${ext}: ${count}`);
                }
            }
        }

        db.prepare("UPDATE import_jobs SET phase = 'zip_extraction_done' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Phase 1.7: Extract PDF portfolio attachments
        // Some PDFs contain embedded file attachments (PDF portfolios / PDF packages).
        // Relativity extracts these as separate documents. We use pdfdetach (poppler-utils)
        // to detect and extract embedded files. Impact: ~2,500 additional documents.
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1.7: Extracting PDF portfolio attachments...');
        db.prepare("UPDATE import_jobs SET phase = 'pdf_portfolio_extraction' WHERE id = ?").run(jobId);

        {
            const pdfPhaseStart = Date.now();
            let pdfsScanned = 0;
            let portfoliosFound = 0;
            let pdfFilesInserted = 0;
            let pdfFilesDupes = 0;
            let pdfFilesSkipped = 0;
            let pdfErrors = 0;
            const pdfAttsByExt = {};

            // Find all non-duplicate PDF attachments
            const pdfDocs = db.prepare(`
                SELECT id, filename, original_name, doc_identifier, parent_id, custodian,
                       content_hash
                FROM documents
                WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
                  AND (LOWER(original_name) LIKE '%.pdf' OR mime_type = 'application/pdf')
                ORDER BY original_name
            `).all(investigation_id);

            // Dedup PDFs by content_hash
            const processedPdfHashes = new Set();
            const uniquePdfs = [];
            for (const pdf of pdfDocs) {
                if (pdf.content_hash && processedPdfHashes.has(pdf.content_hash)) continue;
                if (pdf.content_hash) processedPdfHashes.add(pdf.content_hash);
                uniquePdfs.push(pdf);
            }

            console.log(`✦ Phase 1.7: scanning ${uniquePdfs.length} unique PDFs for embedded files (pdfdetach -list)...`);

            // Prepared statement (same schema as ZIP children)
            const insertPdfChild = db.prepare(`
                INSERT INTO documents (
                    id, filename, original_name, mime_type, size_bytes, text_content, status,
                    doc_type, parent_id, thread_id,
                    doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
                    content_hash, is_duplicate, investigation_id, custodian, doc_identifier
                ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?)
            `);

            const pdfBatchBuffer = [];
            const flushPdfBatch = db.transaction((ops) => {
                for (const op of ops) op();
            });

            // Process PDFs in batches — pdfdetach -list is fast but we don't want to
            // spam thousands of subprocess calls without flushing DB writes
            for (let pi = 0; pi < uniquePdfs.length; pi++) {
                const pdf = uniquePdfs[pi];
                const pdfPath = path.join(UPLOADS_DIR, pdf.filename);

                if (!fs.existsSync(pdfPath)) continue;

                try {
                    // Step 1: Detect — fast catalog read, returns [] for normal PDFs
                    const embeddedNames = await detectPdfEmbeddedFiles(pdfPath);
                    pdfsScanned++;

                    if (embeddedNames.length === 0) continue;

                    portfoliosFound++;

                    // Verbose logging for first 5 portfolios
                    if (portfoliosFound <= 5) {
                        console.log(`  ✦ Phase 1.7 portfolio [${portfoliosFound}]: "${pdf.original_name}" — ${embeddedNames.length} embedded files`);
                        console.log(`    Files: ${embeddedNames.slice(0, 5).join(', ')}${embeddedNames.length > 5 ? ` ... and ${embeddedNames.length - 5} more` : ''}`);
                    }

                    // Step 2: Extract all embedded files to temp dir
                    const { tmpDir, files } = await extractPdfEmbeddedFiles(pdfPath);

                    // Get thread_id from parent chain
                    const parentThread = db.prepare(
                        "SELECT thread_id FROM documents WHERE id = ?"
                    ).get(pdf.parent_id);
                    const threadId = parentThread?.thread_id || null;

                    let childIdx = 0;

                    for (const file of files) {
                        const ext = path.extname(file.name).toLowerCase();

                        // Skip images/media/executables
                        if (CONTAINER_SKIP_EXTS.has(ext)) {
                            pdfFilesSkipped++;
                            continue;
                        }

                        try {
                            const fileBuffer = await fsp.readFile(file.path);
                            const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

                            const fileId = uuidv4();
                            const fileExt = ext || '.bin';
                            let diskFilename;

                            if (!isDuplicate) {
                                diskFilename = `${investigation_id}/${fileId}${fileExt}`;
                                seenHashes.set(contentHash, diskFilename);
                                await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), fileBuffer);
                            } else {
                                diskFilename = seenHashes.get(contentHash);
                                pdfFilesDupes++;
                            }

                            // Track by extension
                            const extKey = ext || '.unknown';
                            pdfAttsByExt[extKey] = (pdfAttsByExt[extKey] || 0) + 1;

                            childIdx++;
                            const docIdentifier = pdf.doc_identifier
                                ? `${pdf.doc_identifier}_${String(childIdx).padStart(3, '0')}`
                                : null;

                            const mime = containerMimeFromExt(ext);

                            pdfBatchBuffer.push(() => {
                                insertPdfChild.run(
                                    fileId, diskFilename, file.name,
                                    mime, fileBuffer.length,
                                    pdf.id, threadId,
                                    null, null, null, null, null, null,
                                    contentHash, isDuplicate, investigation_id,
                                    pdf.custodian || custodian || null,
                                    docIdentifier
                                );
                            });

                            pdfFilesInserted++;
                            totalAttachments++;
                        } catch (err) {
                            pdfErrors++;
                            if (pdfErrors <= 20) {
                                errorLog.push({ phase: 'pdf_portfolio_extraction', pdf: pdf.original_name, file: file.name, error: err.message });
                            }
                        }
                    }

                    // Clean up temp dir
                    await cleanupTmpDir(tmpDir);
                } catch (err) {
                    pdfErrors++;
                    if (pdfErrors <= 20) {
                        console.warn(`  ✦ Phase 1.7 error: ${pdf.original_name} — ${err.message}`);
                        errorLog.push({ phase: 'pdf_portfolio_extraction', docId: pdf.id, filename: pdf.original_name, error: err.message });
                    }
                }

                // Flush in batches
                if (pdfBatchBuffer.length >= DB_BATCH_SIZE) {
                    try {
                        flushPdfBatch(pdfBatchBuffer);
                        pdfBatchBuffer.length = 0;
                    } catch (err) {
                        console.error(`✦ Phase 1.7 FLUSH ERROR: ${err.message}`);
                        pdfBatchBuffer.length = 0;
                    }
                }

                // Progress logging every 1000 PDFs scanned (since most won't be portfolios)
                if ((pi + 1) % 1000 === 0 || pi === uniquePdfs.length - 1) {
                    updateProgress.run(totalEmails, totalAttachments, 'pdf_portfolio_extraction', jobId);
                    console.log(`✦ Phase 1.7: scanned ${pdfsScanned}/${uniquePdfs.length} PDFs — ${portfoliosFound} portfolios found, ${pdfFilesInserted} files extracted (${pdfFilesDupes} dupes, ${pdfErrors} errors)`);
                }
            }

            // Final flush
            if (pdfBatchBuffer.length > 0) {
                try {
                    flushPdfBatch(pdfBatchBuffer);
                    pdfBatchBuffer.length = 0;
                } catch (err) {
                    console.error(`✦ Phase 1.7 final FLUSH ERROR: ${err.message}`);
                }
            }

            const pdfElapsed = ((Date.now() - pdfPhaseStart) / 1000).toFixed(1);
            console.log(`✦ Phase 1.7 complete: ${pdfsScanned} PDFs scanned, ${portfoliosFound} portfolios → ${pdfFilesInserted} files extracted (${pdfFilesDupes} dupes, ${pdfFilesSkipped} skipped, ${pdfErrors} errors) in ${pdfElapsed}s`);

            // Log per-extension breakdown
            if (Object.keys(pdfAttsByExt).length > 0) {
                const sorted = Object.entries(pdfAttsByExt).sort((a, b) => b[1] - a[1]);
                console.log(`✦ Phase 1.7 extracted file types:`);
                for (const [ext, count] of sorted.slice(0, 20)) {
                    console.log(`    ${ext}: ${count}`);
                }
            }
        }

        db.prepare("UPDATE import_jobs SET phase = 'pdf_portfolio_extraction_done' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Phase 1.8: Extract TNEF (winmail.dat) attachments
        // Outlook's Transport Neutral Encapsulation Format wraps attachments
        // in a binary blob. Small impact (~5 docs) but easy to handle.
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1.8: Extracting TNEF/winmail.dat attachments...');
        db.prepare("UPDATE import_jobs SET phase = 'tnef_extraction' WHERE id = ?").run(jobId);

        {
            const tnefPhaseStart = Date.now();
            let tnefProcessed = 0;
            let tnefFilesInserted = 0;
            let tnefFilesDupes = 0;
            let tnefErrors = 0;
            const tnefAttsByExt = {};

            // Find TNEF/winmail.dat attachments
            const tnefDocs = db.prepare(`
                SELECT id, filename, original_name, doc_identifier, parent_id, custodian, content_hash
                FROM documents
                WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
                  AND (LOWER(original_name) LIKE '%winmail%'
                       OR LOWER(original_name) = 'noname.dat'
                       OR mime_type = 'application/ms-tnef'
                       OR mime_type = 'application/vnd.ms-tnef')
                ORDER BY original_name
            `).all(investigation_id);

            console.log(`✦ Phase 1.8: found ${tnefDocs.length} TNEF attachments`);

            const insertTnefChild = db.prepare(`
                INSERT INTO documents (
                    id, filename, original_name, mime_type, size_bytes, text_content, status,
                    doc_type, parent_id, thread_id,
                    doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
                    content_hash, is_duplicate, investigation_id, custodian, doc_identifier
                ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?)
            `);

            const tnefBatchBuffer = [];
            const flushTnefBatch = db.transaction((ops) => {
                for (const op of ops) op();
            });

            for (const tnefDoc of tnefDocs) {
                const tnefPath = path.join(UPLOADS_DIR, tnefDoc.filename);

                if (!fs.existsSync(tnefPath)) {
                    if (tnefProcessed < 5) console.log(`  ✦ Phase 1.8: TNEF file missing: ${tnefDoc.original_name}`);
                    continue;
                }

                try {
                    const { tmpDir, files } = await extractTnefContents(tnefPath);

                    if (files.length > 0 && tnefProcessed < 5) {
                        console.log(`  ✦ Phase 1.8 [${tnefProcessed + 1}]: "${tnefDoc.original_name}" — ${files.length} files inside [${files.map(f => f.name).join(', ')}]`);
                    }

                    // Get thread_id from parent chain
                    const parentThread = db.prepare(
                        "SELECT thread_id FROM documents WHERE id = ?"
                    ).get(tnefDoc.parent_id);
                    const threadId = parentThread?.thread_id || null;

                    let childIdx = 0;

                    for (const file of files) {
                        const ext = path.extname(file.name).toLowerCase();
                        if (CONTAINER_SKIP_EXTS.has(ext)) continue;

                        try {
                            const fileBuffer = await fsp.readFile(file.path);
                            const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

                            const fileId = uuidv4();
                            const fileExt = ext || '.bin';
                            let diskFilename;

                            if (!isDuplicate) {
                                diskFilename = `${investigation_id}/${fileId}${fileExt}`;
                                seenHashes.set(contentHash, diskFilename);
                                await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), fileBuffer);
                            } else {
                                diskFilename = seenHashes.get(contentHash);
                                tnefFilesDupes++;
                            }

                            const extKey = ext || '.unknown';
                            tnefAttsByExt[extKey] = (tnefAttsByExt[extKey] || 0) + 1;

                            childIdx++;
                            const docIdentifier = tnefDoc.doc_identifier
                                ? `${tnefDoc.doc_identifier}_${String(childIdx).padStart(3, '0')}`
                                : null;

                            const mime = containerMimeFromExt(ext);

                            tnefBatchBuffer.push(() => {
                                insertTnefChild.run(
                                    fileId, diskFilename, file.name,
                                    mime, fileBuffer.length,
                                    tnefDoc.id, threadId,
                                    null, null, null, null, null, null,
                                    contentHash, isDuplicate, investigation_id,
                                    tnefDoc.custodian || custodian || null,
                                    docIdentifier
                                );
                            });

                            tnefFilesInserted++;
                            totalAttachments++;
                        } catch (err) {
                            tnefErrors++;
                            errorLog.push({ phase: 'tnef_extraction', tnef: tnefDoc.original_name, file: file.name, error: err.message });
                        }
                    }

                    await cleanupTmpDir(tmpDir);
                    tnefProcessed++;
                } catch (err) {
                    tnefErrors++;
                    if (tnefErrors <= 10) {
                        console.warn(`  ✦ Phase 1.8 error: ${tnefDoc.original_name} — ${err.message}`);
                        errorLog.push({ phase: 'tnef_extraction', docId: tnefDoc.id, filename: tnefDoc.original_name, error: err.message });
                    }
                }
            }

            // Final flush
            if (tnefBatchBuffer.length > 0) {
                try {
                    flushTnefBatch(tnefBatchBuffer);
                    tnefBatchBuffer.length = 0;
                } catch (err) {
                    console.error(`✦ Phase 1.8 final FLUSH ERROR: ${err.message}`);
                }
            }

            const tnefElapsed = ((Date.now() - tnefPhaseStart) / 1000).toFixed(1);
            console.log(`✦ Phase 1.8 complete: ${tnefProcessed} TNEF containers processed, ${tnefFilesInserted} files extracted (${tnefFilesDupes} dupes, ${tnefErrors} errors) in ${tnefElapsed}s`);

            if (Object.keys(tnefAttsByExt).length > 0) {
                const sorted = Object.entries(tnefAttsByExt).sort((a, b) => b[1] - a[1]);
                console.log(`✦ Phase 1.8 extracted file types:`);
                for (const [ext, count] of sorted) {
                    console.log(`    ${ext}: ${count}`);
                }
            }
        }

        db.prepare("UPDATE import_jobs SET phase = 'tnef_extraction_done' WHERE id = ?").run(jobId);

        // ═══════════════════════════════════════════
        // Phase 1.9: Recursive container pass
        // Phases 1.5-1.8 handle one level of extraction. But containers can
        // be nested: ZIP inside ZIP, PDF portfolio inside ZIP, MSG inside ZIP.
        // Relativity recurses. We loop until no new containers are found,
        // with a hard depth limit of 5 passes to prevent ZIP bombs.
        // ═══════════════════════════════════════════
        console.log('✦ PST Import Phase 1.9: Recursive container pass...');
        db.prepare("UPDATE import_jobs SET phase = 'recursive_extraction' WHERE id = ?").run(jobId);

        {
            const recurseStart = Date.now();
            const processedContainerIds = new Set();
            // Mark all containers already processed in earlier phases
            // (ZIPs from 1.6, PDFs from 1.7, TNEFs from 1.8, MSGs from 1.5)
            const alreadyProcessed = db.prepare(`
                SELECT DISTINCT parent_id FROM documents
                WHERE parent_id IS NOT NULL AND investigation_id = ?
            `).all(investigation_id);
            for (const row of alreadyProcessed) {
                processedContainerIds.add(row.parent_id);
            }

            const insertRecurseChild = db.prepare(`
                INSERT INTO documents (
                    id, filename, original_name, mime_type, size_bytes, text_content, status,
                    doc_type, parent_id, thread_id,
                    doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
                    content_hash, is_duplicate, investigation_id, custodian, doc_identifier
                ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?)
            `);

            const recurseBatchBuffer = [];
            const flushRecurseBatch = db.transaction((ops) => {
                for (const op of ops) op();
            });

            let totalRecurseInserted = 0;
            let totalRecurseDupes = 0;
            let totalRecurseErrors = 0;
            let passNumber = 0;
            const MAX_RECURSE_PASSES = 5;

            while (passNumber < MAX_RECURSE_PASSES) {
                passNumber++;

                // Find newly-inserted containers that haven't been processed yet
                const newContainers = db.prepare(`
                    SELECT id, filename, original_name, doc_identifier, parent_id, custodian,
                           content_hash, mime_type
                    FROM documents
                    WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
                      AND (LOWER(original_name) LIKE '%.zip' OR mime_type = 'application/zip'
                           OR LOWER(original_name) LIKE '%.msg' OR mime_type = 'application/vnd.ms-outlook'
                           OR LOWER(original_name) LIKE '%.eml' OR mime_type = 'message/rfc822'
                           OR LOWER(original_name) LIKE '%winmail%' OR LOWER(original_name) = 'noname.dat'
                           OR mime_type = 'application/ms-tnef' OR mime_type = 'application/vnd.ms-tnef')
                `).all(investigation_id).filter(doc => !processedContainerIds.has(doc.id));

                if (newContainers.length === 0) {
                    console.log(`✦ Phase 1.9 pass ${passNumber}: no new containers found — done`);
                    break;
                }

                console.log(`✦ Phase 1.9 pass ${passNumber}: found ${newContainers.length} new containers to process`);
                let passInserted = 0;

                for (const container of newContainers) {
                    processedContainerIds.add(container.id);
                    const containerPath = path.join(UPLOADS_DIR, container.filename);
                    if (!fs.existsSync(containerPath)) continue;

                    const on = (container.original_name || '').toLowerCase();
                    const ext = path.extname(on);

                    // Get thread_id from parent chain
                    const parentThread = db.prepare(
                        "SELECT thread_id FROM documents WHERE id = ?"
                    ).get(container.parent_id);
                    const threadId = parentThread?.thread_id || null;

                    let extractedFiles = [];
                    let tmpDir = null;

                    try {
                        if (ext === '.zip' || container.mime_type === 'application/zip') {
                            // ZIP container
                            const entries = await listZipContents(containerPath);
                            for (const entry of entries) {
                                const entryExt = path.extname(entry.path).toLowerCase();
                                if (CONTAINER_SKIP_EXTS.has(entryExt)) continue;
                                try {
                                    const buf = await extractFileFromZip(containerPath, entry.path);
                                    extractedFiles.push({ name: path.basename(entry.path), buffer: buf });
                                } catch (_) { /* skip individual file errors */ }
                            }
                        } else if (ext === '.msg' || container.mime_type === 'application/vnd.ms-outlook') {
                            // MSG container — use parseMsg
                            try {
                                const msgBuffer = fs.readFileSync(containerPath);
                                const result = parseMsg(msgBuffer);
                                for (const att of result.attachments) {
                                    extractedFiles.push({ name: att.filename, buffer: att.content });
                                }
                                // Update container text_content
                                if (result.metadata.textBody) {
                                    const bodyText = `[Embedded email] From: ${result.metadata.from || 'unknown'}\nSubject: ${result.metadata.subject || ''}\n\n${result.metadata.textBody}`;
                                    db.prepare("UPDATE documents SET text_content = ?, text_content_size = ? WHERE id = ?")
                                        .run(bodyText, bodyText.length, container.id);
                                }
                            } catch (_) { /* skip parse errors */ }
                        } else if (ext === '.eml' || container.mime_type === 'message/rfc822') {
                            // EML container
                            try {
                                const emlBuffer = fs.readFileSync(containerPath);
                                const eml = await parseEml(emlBuffer);
                                for (const att of (eml.attachments || [])) {
                                    extractedFiles.push({ name: att.filename, buffer: att.content });
                                }
                            } catch (_) { /* skip parse errors */ }
                        } else if (on.includes('winmail') || on === 'noname.dat' ||
                                   container.mime_type === 'application/ms-tnef' || container.mime_type === 'application/vnd.ms-tnef') {
                            // TNEF container
                            try {
                                const result = await extractTnefContents(containerPath);
                                tmpDir = result.tmpDir;
                                for (const file of result.files) {
                                    const buf = await fsp.readFile(file.path);
                                    extractedFiles.push({ name: file.name, buffer: buf });
                                }
                            } catch (_) { /* skip errors */ }
                        }

                        // Insert extracted files
                        let childIdx = 0;
                        for (const file of extractedFiles) {
                            const fileExt = path.extname(file.name).toLowerCase();
                            if (CONTAINER_SKIP_EXTS.has(fileExt)) continue;

                            const contentHash = crypto.createHash('md5').update(file.buffer).digest('hex');
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

                            const fileId = uuidv4();
                            let diskFilename;

                            if (!isDuplicate) {
                                diskFilename = `${investigation_id}/${fileId}${fileExt || '.bin'}`;
                                seenHashes.set(contentHash, diskFilename);
                                await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), file.buffer);
                            } else {
                                diskFilename = seenHashes.get(contentHash);
                                totalRecurseDupes++;
                            }

                            childIdx++;
                            const docIdentifier = container.doc_identifier
                                ? `${container.doc_identifier}_${String(childIdx).padStart(3, '0')}`
                                : null;

                            const mime = containerMimeFromExt(fileExt);

                            recurseBatchBuffer.push(() => {
                                insertRecurseChild.run(
                                    fileId, diskFilename, file.name,
                                    mime, file.buffer.length,
                                    container.id, threadId,
                                    null, null, null, null, null, null,
                                    contentHash, isDuplicate, investigation_id,
                                    container.custodian || custodian || null,
                                    docIdentifier
                                );
                            });

                            passInserted++;
                            totalRecurseInserted++;
                            totalAttachments++;
                        }

                        if (tmpDir) await cleanupTmpDir(tmpDir);
                    } catch (err) {
                        totalRecurseErrors++;
                        if (totalRecurseErrors <= 20) {
                            console.warn(`  ✦ Phase 1.9 error: ${container.original_name} — ${err.message}`);
                            errorLog.push({ phase: 'recursive_extraction', docId: container.id, filename: container.original_name, error: err.message });
                        }
                        if (tmpDir) await cleanupTmpDir(tmpDir);
                    }
                }

                // Flush after each pass
                if (recurseBatchBuffer.length > 0) {
                    try {
                        flushRecurseBatch(recurseBatchBuffer);
                        recurseBatchBuffer.length = 0;
                    } catch (err) {
                        console.error(`✦ Phase 1.9 FLUSH ERROR: ${err.message}`);
                        recurseBatchBuffer.length = 0;
                    }
                }

                console.log(`✦ Phase 1.9 pass ${passNumber}: inserted ${passInserted} files from ${newContainers.length} containers`);

                // Also check newly extracted PDFs for portfolios in the recursive pass
                const newPdfs = db.prepare(`
                    SELECT id, filename, original_name, doc_identifier, parent_id, custodian, content_hash
                    FROM documents
                    WHERE investigation_id = ? AND doc_type = 'attachment' AND is_duplicate = 0
                      AND (LOWER(original_name) LIKE '%.pdf' OR mime_type = 'application/pdf')
                `).all(investigation_id).filter(doc => !processedContainerIds.has(doc.id));

                let portfolioPassInserted = 0;
                for (const pdf of newPdfs) {
                    processedContainerIds.add(pdf.id);
                    const pdfPath = path.join(UPLOADS_DIR, pdf.filename);
                    if (!fs.existsSync(pdfPath)) continue;

                    try {
                        const embeddedNames = await detectPdfEmbeddedFiles(pdfPath);
                        if (embeddedNames.length === 0) continue;

                        const { tmpDir: pdfTmpDir, files } = await extractPdfEmbeddedFiles(pdfPath);
                        const parentThread = db.prepare("SELECT thread_id FROM documents WHERE id = ?").get(pdf.parent_id);
                        const pdfThreadId = parentThread?.thread_id || null;

                        let pdfChildIdx = 0;
                        for (const file of files) {
                            const fileExt = path.extname(file.name).toLowerCase();
                            if (CONTAINER_SKIP_EXTS.has(fileExt)) continue;

                            const fileBuffer = await fsp.readFile(file.path);
                            const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

                            const fileId = uuidv4();
                            let diskFilename;

                            if (!isDuplicate) {
                                diskFilename = `${investigation_id}/${fileId}${fileExt || '.bin'}`;
                                seenHashes.set(contentHash, diskFilename);
                                await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), fileBuffer);
                            } else {
                                diskFilename = seenHashes.get(contentHash);
                                totalRecurseDupes++;
                            }

                            pdfChildIdx++;
                            const docIdentifier = pdf.doc_identifier
                                ? `${pdf.doc_identifier}_${String(pdfChildIdx).padStart(3, '0')}`
                                : null;

                            const mime = containerMimeFromExt(fileExt);

                            recurseBatchBuffer.push(() => {
                                insertRecurseChild.run(
                                    fileId, diskFilename, file.name,
                                    mime, fileBuffer.length,
                                    pdf.id, pdfThreadId,
                                    null, null, null, null, null, null,
                                    contentHash, isDuplicate, investigation_id,
                                    pdf.custodian || custodian || null,
                                    docIdentifier
                                );
                            });

                            portfolioPassInserted++;
                            totalRecurseInserted++;
                            totalAttachments++;
                        }

                        await cleanupTmpDir(pdfTmpDir);
                    } catch (_) { /* skip errors */ }
                }

                if (recurseBatchBuffer.length > 0) {
                    try {
                        flushRecurseBatch(recurseBatchBuffer);
                        recurseBatchBuffer.length = 0;
                    } catch (err) {
                        console.error(`✦ Phase 1.9 PDF portfolio FLUSH ERROR: ${err.message}`);
                        recurseBatchBuffer.length = 0;
                    }
                }

                if (portfolioPassInserted > 0) {
                    console.log(`✦ Phase 1.9 pass ${passNumber}: also extracted ${portfolioPassInserted} files from nested PDF portfolios`);
                }

                if (passInserted === 0 && portfolioPassInserted === 0) {
                    console.log(`✦ Phase 1.9: no new files extracted in pass ${passNumber} — stopping`);
                    break;
                }
            }

            if (passNumber >= MAX_RECURSE_PASSES) {
                console.warn(`✦ Phase 1.9: hit max recursion depth (${MAX_RECURSE_PASSES} passes) — some nested containers may remain unprocessed`);
            }

            const recurseElapsed = ((Date.now() - recurseStart) / 1000).toFixed(1);
            console.log(`✦ Phase 1.9 complete: ${passNumber} passes, ${totalRecurseInserted} files extracted (${totalRecurseDupes} dupes, ${totalRecurseErrors} errors) in ${recurseElapsed}s`);
        }

        db.prepare("UPDATE import_jobs SET phase = 'container_extraction_done' WHERE id = ?").run(jobId);

        // WAL checkpoint after all container extraction phases
        walCheckpoint(db);

        } // end if (!extractionOnly)

        // ═══════════════════════════════════════════
        // Phase 2: Extract text from attachments (concurrent I/O, batched DB writes)
        // Text extraction (pdf-parse, mammoth) is async I/O-bound, so concurrency helps.
        // DB writes are collected and flushed in batches to avoid lock contention.
        // ═══════════════════════════════════════════
        console.log(`✦ PST Import Phase 2: Extracting text (concurrency=${PHASE2_CONCURRENCY})...`);
        console.log(`✦ DEBUG: investigation_id=${investigation_id}, jobId=${jobId}, extractionOnly=${extractionOnly}`);
        console.log(`✦ DEBUG: totalEmails=${totalEmails}, totalAttachments=${totalAttachments}`);
        updateProgress.run(totalEmails, totalAttachments, 'extracting', jobId);

        // Skip duplicates — they share the same file on disk, no need to extract twice
        const pendingDocs = db.prepare(
            "SELECT id, filename, mime_type FROM documents WHERE status = 'processing' AND doc_type = 'attachment' AND is_duplicate = 0 AND investigation_id = ?"
        ).all(investigation_id);

        // Mark duplicates as ready immediately (copy text from original later via backfill)
        const dupeCount = db.prepare(
            "UPDATE documents SET status = 'ready' WHERE status = 'processing' AND doc_type = 'attachment' AND is_duplicate = 1 AND investigation_id = ?"
        ).run(investigation_id);
        if (dupeCount.changes > 0) {
            console.log(`✦ Phase 2: skipped ${dupeCount.changes} duplicate attachments`);
        }

        const totalPending = pendingDocs.length;
        console.log(`✦ DEBUG: Found ${totalPending} pending docs to extract`);
        if (totalPending > 0) {
            console.log(`✦ DEBUG: First pending doc: ${JSON.stringify(pendingDocs[0])}`);
        }
        let extracted = 0;
        let extractionOps = [];
        const failedExtractions = []; // Track docs that failed or timed out

        // OCR tracking
        let ocrCount = 0, ocrSuccess = 0, ocrFailed = 0, ocrTotalTimeMs = 0;

        // Use subprocess for extraction — mammoth/pdf-parse are CPU-bound and block the
        // event loop, making Promise.race timeouts useless. execFile has a real OS timeout.
        const EXTRACT_WORKER = path.join(__dirname, '..', 'lib', 'extract-worker.js');
        const EXTRACT_TIMEOUT = (getSetting('extract_timeout') || 15) * 1000;
        const OCR_TIMEOUT = (getSetting('extract_ocr_timeout') || 120) * 1000;
        const NODE_BIN = process.execPath;

        // Pass extraction settings as env vars so subprocesses don't need db.js
        const extractEnv = {
            ...process.env,
            EXTRACT_OCR_ENABLED: String(getSetting('ocr_enabled') ?? true),
            EXTRACT_MAX_FILE_SIZE_MB: String(getSetting('extract_max_file_size_mb') || 50),
            EXTRACT_OCR_MIN_TEXT_LENGTH: String(getSetting('ocr_min_text_length') || 100),
            EXTRACT_OCR_DPI: String(getSetting('ocr_dpi') || 100),
            EXTRACT_OCR_PDFTOPPM_TIMEOUT: String(getSetting('ocr_pdftoppm_timeout') || 60),
            EXTRACT_OCR_TESSERACT_TIMEOUT: String(getSetting('ocr_tesseract_timeout') || 60),
        };

        function extractViaSubprocess(filePath, mimeType, mode = 'text') {
            const timeout = mode === 'textocr' ? OCR_TIMEOUT : EXTRACT_TIMEOUT;
            return new Promise((resolve, reject) => {
                const child = execFile(NODE_BIN, [EXTRACT_WORKER, filePath, mimeType, mode], {
                    timeout,
                    maxBuffer: 50 * 1024 * 1024,
                    killSignal: 'SIGKILL',
                    env: extractEnv,
                }, (err, stdout, stderr) => {
                    if (err) {
                        if (err.killed) return reject(new Error('Extraction timed out (killed)'));
                        return reject(new Error(stderr || err.message));
                    }
                    resolve(stdout);
                });
            });
        }

        console.log(`✦ DEBUG: Starting runConcurrent with ${pendingDocs.length} docs...`);
        await runConcurrent(pendingDocs, PHASE2_CONCURRENCY, async (doc) => {
            if (!doc.filename || doc.filename.startsWith('oversized/')) {
                extracted++;
                return;
            }
            const filePath = path.join(UPLOADS_DIR, doc.filename);

            const isPdf = doc.filename && path.extname(doc.filename).toLowerCase() === '.pdf';
            let text = '';
            let extractionFailed = false;
            let ocrApplied = 0;
            let docOcrTimeMs = null;
            try {
                if (isPdf) {
                    // Use textocr mode for PDFs to get OCR tracking info
                    const raw = await extractViaSubprocess(filePath, doc.mime_type, 'textocr');
                    try {
                        // Extract JSON from the end of output (skip any pdfjs warnings on stdout)
                        const jsonStart = raw.indexOf('{"text":');
                        const jsonStr = jsonStart >= 0 ? raw.substring(jsonStart) : raw;
                        const result = JSON.parse(jsonStr);
                        text = result.text || '';
                        if (result.ocr && result.ocr.attempted) {
                            ocrCount++;
                            const timeMs = result.ocr.timeMs || 0;
                            ocrTotalTimeMs += timeMs;
                            docOcrTimeMs = timeMs;
                            if (result.ocr.succeeded) {
                                ocrSuccess++;
                                ocrApplied = 1;
                            } else {
                                ocrFailed++;
                            }
                        }
                    } catch (jsonErr) {
                        // JSON parse failed (e.g. native lib wrote to stdout) — use raw as text
                        text = raw || '';
                    }
                } else {
                    text = await extractViaSubprocess(filePath, doc.mime_type, 'text');
                }
            } catch (e) {
                text = `[Could not extract text: ${e.message}]`;
                extractionFailed = true;
                failedExtractions.push({
                    id: doc.id,
                    filename: doc.filename,
                    original_name: doc.original_name,
                    mime_type: doc.mime_type,
                    error: e.message
                });
                if (failedExtractions.length <= 20) {
                    console.warn(`✦ Phase 2 FAILED: ${doc.original_name || doc.filename} — ${e.message}`);
                }
            }

            let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
            if (!extractionFailed) {
                try {
                    const metaJson = await extractViaSubprocess(filePath, doc.mime_type, 'meta');
                    if (metaJson) meta = JSON.parse(metaJson);
                } catch (_) { /* best effort */ }
            }

            const docId = doc.id;
            extractionOps.push(
                () => updateDocTextOcr.run(text, text ? text.length : 0, ocrApplied, docOcrTimeMs, docId),
                () => updateDocMeta.run(meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords, meta.lastModifiedBy, meta.printedAt, meta.lastAccessedAt, docId)
            );
            extracted++;

            // Flush DB writes in batches
            if (extractionOps.length >= DB_BATCH_SIZE) {
                const ops = extractionOps;
                extractionOps = [];
                try {
                    flushBatch(ops);
                } catch (flushErr) {
                    console.error(`✦ Phase 2 FLUSH ERROR: ${flushErr.message}`);
                    // FTS corruption is recoverable — skip the batch and continue
                    if (flushErr.code === 'SQLITE_CORRUPT_VTAB') {
                        console.warn('✦ FTS corruption detected — will rebuild at end of Phase 2');
                    } else {
                        throw flushErr;
                    }
                }
            }

            if (extracted % 50 === 0 || extracted === totalPending) {
                const pct = Math.round((extracted / totalPending) * 100);
                updateExtractionProgress.run(pct, jobId);
                console.log(`✦ PST Import Phase 2: ${extracted}/${totalPending} (${pct}%)`);
            }
        });

        if (extractionOps.length > 0) {
            try {
                flushBatch(extractionOps);
            } catch (flushErr) {
                console.error(`✦ Phase 2 final FLUSH ERROR: ${flushErr.message}`);
            }
        }

        // Mark extraction done ASAP — frontend uses this to detect stuck jobs.
        // Must be set before any heavy operations (backfill, FTS) that could OOM.
        db.prepare("UPDATE import_jobs SET extraction_done_at = datetime('now') WHERE id = ?").run(jobId);
        console.log('✦ Extraction complete — extraction_done_at set');

        // Backfill text from originals into duplicates (they share content_hash).
        // Backfill text from originals into duplicates (shared helper, hash-map lookup)
        if (dupeCount.changes > 0) {
            console.log(`✦ Backfilling text for ${dupeCount.changes} duplicates...`);
            backfillDuplicateText(db, investigation_id, { includeOcr: true });
        }

        console.log(`✦ PST Import Phase 2 complete: extracted text from ${extracted} attachments`);
        if (ocrCount > 0) {
            console.log(`✦ OCR Summary: ${ocrCount} attempted, ${ocrSuccess} succeeded, ${ocrFailed} failed, ${(ocrTotalTimeMs / 1000).toFixed(1)}s total OCR time`);
        }

        // ── Extraction failure summary ──
        if (failedExtractions.length > 0) {
            console.log(`\n✦ ═══ EXTRACTION FAILURE SUMMARY ═══`);
            console.log(`✦ ${failedExtractions.length} document(s) failed text extraction:\n`);

            // Group by error type
            const byError = {};
            for (const f of failedExtractions) {
                const key = f.error.includes('timed out') ? 'Timed out (>30s)' : f.error;
                if (!byError[key]) byError[key] = [];
                byError[key].push(f);
            }
            for (const [error, docs] of Object.entries(byError)) {
                console.log(`  ${error} (${docs.length} docs):`);
                for (const d of docs.slice(0, 10)) {
                    console.log(`    - ${d.id}  ${d.original_name}  (${d.mime_type})`);
                }
                if (docs.length > 10) console.log(`    ... and ${docs.length - 10} more`);
            }
            console.log(`✦ ═══════════════════════════════════\n`);

            // Add to job error log
            for (const f of failedExtractions) {
                errorLog.push({ phase: 'extraction', docId: f.id, filename: f.original_name, error: f.error });
            }
        } else {
            console.log(`✦ All ${extracted} documents extracted successfully — no failures.`);
        }

        // ═══════════════════════════════════════════
        // Finalization — mark job completed FIRST, then FTS rebuild.
        // FTS rebuild can OOM on large imports (100K+ docs, ~1GB text).
        // If it kills the worker, the job is already done and FTS
        // recovery happens via the finalize button or next server startup.
        // ═══════════════════════════════════════════
        const memBefore = process.memoryUsage();
        console.log(`✦ Finalization: heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(memBefore.rss / 1024 / 1024).toFixed(0)}MB`);

        console.log('✦ Finalization [1/5]: marking job completed...');
        db.prepare(`
            UPDATE import_jobs
            SET status = 'completed',
                phase = 'completed',
                total_emails = ?,
                total_attachments = ?,
                progress_percent = 100,
                error_log = ?,
                ocr_count = ?,
                ocr_success = ?,
                ocr_failed = ?,
                ocr_time_ms = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(totalEmails, totalAttachments, JSON.stringify(errorLog), ocrCount, ocrSuccess, ocrFailed, ocrTotalTimeMs, jobId);
        console.log('✦ Finalization [1/5]: done — job marked as completed');

        console.log('✦ Finalization [2/5]: refreshing investigation counts...');
        refreshInvestigationCounts(mainDb, db, investigation_id);
        console.log('✦ Finalization [2/5]: done');

        console.log('✦ Finalization [3/5]: re-enabling FTS triggers...');
        enableFtsTriggers(db);
        console.log('✦ Finalization [3/5]: done');

        console.log('✦ Finalization [4/5]: rebuilding FTS index...');
        const ftsStart = Date.now();
        rebuildFtsIndex(db);
        const memAfter = process.memoryUsage();
        console.log(`✦ Finalization [4/5]: done in ${((Date.now() - ftsStart) / 1000).toFixed(1)}s — heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(memAfter.rss / 1024 / 1024).toFixed(0)}MB`);

        console.log('✦ Finalization [5/5]: WAL checkpoint...');
        walCheckpoint(db);
        console.log('✦ Finalization [5/5]: done — all finalization complete');

        // Auto-cleanup: delete source PST/OST file after successful import (skip for local path imports)
        if (preserveSource) {
            console.log('✦ PST Import: preserving source file (local path import)');
        } else {
            try {
                fs.unlinkSync(filepath);
                console.log('✦ PST Import: deleted source file to free disk space');
            } catch (e) {
                console.warn('✦ PST Import: could not delete source file:', e.message);
            }
        }

    } catch (err) {
        const mem = process.memoryUsage();
        console.error(`Worker fatal error (heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB):`, err);

        // Mark failed FIRST, then best-effort recovery
        db.prepare(`
            UPDATE import_jobs
            SET status = 'failed',
                error_log = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify([{ error: err.message, fatal: true }]), jobId);

        // Best-effort recovery: re-enable FTS triggers, rebuild index, recreate indexes
        enableFtsTriggers(db);
        rebuildFtsIndex(db);
        recreateBulkIndexes(db);
    } finally {
        try { db.close(); } catch (_) {}
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

    const emailDocId = nextDocIdentifier();

    // Count recipients across To, Cc, Bcc
    const countAddrs = (s) => s ? s.split(',').filter(a => a.trim()).length : 0;
    const recipientCount = countAddrs(eml.to) + countAddrs(eml.cc) + countAddrs(eml.bcc);

    batchBuffer.push(() => {
        insertEmail.run(
            emailId, emailFilename, `${originalname} — ${subject}`, 'message/rfc822', sizeBytes, textBody,
            threadId, eml.messageId, eml.inReplyTo, eml.references,
            eml.from, eml.to, eml.cc, subject, eml.date,
            eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
            eml.originatingIp || null, eml.authResults || null,
            eml.serverInfo || null, eml.deliveryDate || null,
            investigation_id, custodian || null,
            eml._folderPath || null, textBody.length || 0,
            emailDocId, recipientCount
        );
    });

    // Defer backfill to end of Phase 1 — during bulk import, backfillThread does
    // expensive UPDATE...WHERE thread_id=? scans that account for 96% of flush time.
    // Instead, just update the in-memory cache and do a single backfill pass at the end.
    updateCacheOnly(threadId, eml.messageId, eml.inReplyTo, eml.references);

    // Write attachments async, hash in-memory for dedup
    const writePromises = [];
    let attIdx = 0;

    for (const att of eml.attachments) {
        attIdx++;
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attBasename = `${attId}${attExt}`;
        const attFilename = `${investigation_id}/${attBasename}`;
        const attPath = path.join(UPLOADS_DIR, attFilename);

        // Skip writing large attachments to disk (>100MB) — record in DB with note.
        // Exception: container types (ZIP, RAR, 7z, MSG, EML, TNEF) are always written
        // because Phases 1.5-1.9 need them on disk to extract their contents.
        const CONTAINER_EXEMPT_EXTS = new Set(['.zip', '.rar', '.7z', '.msg', '.eml']);
        const attExtLower = attExt.toLowerCase();
        const isContainer = CONTAINER_EXEMPT_EXTS.has(attExtLower)
            || (att.filename || '').toLowerCase().includes('winmail')
            || att.contentType === 'application/ms-tnef';
        const isOversized = !isContainer && att.size > MAX_ATTACHMENT_SIZE;

        // Hash in memory — check in-memory map instead of DB query per attachment
        const tHash = Date.now();
        const attHash = isOversized ? null : crypto.createHash('md5').update(att.content).digest('hex');
        perfStats.hashTime += Date.now() - tHash;
        const isDuplicate = attHash && seenHashes.has(attHash) ? 1 : 0;

        // Skip file write for duplicates or oversized — reuse existing file or skip entirely
        let finalFilename = attFilename;
        if (isOversized) {
            finalFilename = `oversized/${attId}${attExt}`; // no file on disk, but DB needs non-null filename
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
        const attDocIdentifier = attIdentifier(emailDocId, attIdx);
        batchBuffer.push(() => {
            insertAttachment.run(
                attId, dbFilename, att.filename,
                att.contentType, att.size,
                emailId, threadId,
                oversizeNote, null, null, null, null, null,
                attHash, isDuplicate, investigation_id, custodian || null,
                attDocIdentifier
            );
        });

        totalAttachments++;
    }

    // Wait for all file writes to finish before moving to next email
    if (writePromises.length > 0) await Promise.all(writePromises);

    return { emailId };
}

// Start worker
console.log('✦ DEBUG: calling main()...');
main().then(() => console.log('✦ DEBUG: main() resolved')).catch(e => console.error('✦ DEBUG: main() rejected:', e));
