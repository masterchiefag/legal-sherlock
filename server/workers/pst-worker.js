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
import { disableFtsTriggers, enableFtsTriggers, rebuildFtsIndex, dropBulkIndexes, recreateBulkIndexes, refreshInvestigationCounts, walCheckpoint } from '../lib/worker-helpers.js';
import { resolveThreadId, backfillThread, updateCacheOnly, resolveThreadIdFromCache, initCache } from '../lib/threading-cached.js';
import { getSetting } from '../lib/settings.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const EML_PARSE_WORKER = path.join(__dirname, 'eml-parse-worker.js');

console.log('✦ DEBUG: workerData destructured');
const { jobId, filename, filepath, originalname, investigation_id, custodian, resume, extractionOnly } = workerData;
console.log('✦ DEBUG: constants initializing');

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

const investigation = db.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigation_id);
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

                // Derive folder path from PST directory structure
                const relPath = path.relative(tmpDir, emlPath);
                const folderPath = path.dirname(relPath).replace(/\\/g, '/');
                eml._folderPath = folderPath === '.' ? '/' : '/' + folderPath;

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

        function extractViaSubprocess(filePath, mimeType, mode = 'text') {
            const timeout = mode === 'textocr' ? OCR_TIMEOUT : EXTRACT_TIMEOUT;
            return new Promise((resolve, reject) => {
                const child = execFile(NODE_BIN, [EXTRACT_WORKER, filePath, mimeType, mode], {
                    timeout,
                    maxBuffer: 50 * 1024 * 1024,
                    killSignal: 'SIGKILL',
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
            if (!doc.filename) {
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
                flushBatch(ops);
            }

            if (extracted % 50 === 0 || extracted === totalPending) {
                const pct = Math.round((extracted / totalPending) * 100);
                updateExtractionProgress.run(pct, jobId);
                console.log(`✦ PST Import Phase 2: ${extracted}/${totalPending} (${pct}%)`);
            }
        });

        if (extractionOps.length > 0) flushBatch(extractionOps);

        // Mark extraction done ASAP — frontend uses this to detect stuck jobs.
        // Must be set before any heavy operations (backfill, FTS) that could OOM.
        db.prepare("UPDATE import_jobs SET extraction_done_at = datetime('now') WHERE id = ?").run(jobId);

        // Backfill text from originals into duplicates (they share content_hash)
        if (dupeCount.changes > 0) {
            const backfilled = db.prepare(`
                UPDATE documents SET
                    text_content = (SELECT d2.text_content FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 AND d2.text_content IS NOT NULL LIMIT 1),
                    text_content_size = (SELECT d2.text_content_size FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 AND d2.text_content IS NOT NULL LIMIT 1),
                    ocr_applied = (SELECT d2.ocr_applied FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 LIMIT 1),
                    ocr_time_ms = (SELECT d2.ocr_time_ms FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 LIMIT 1)
                WHERE is_duplicate = 1 AND doc_type = 'attachment' AND investigation_id = ? AND text_content IS NULL
            `).run(investigation_id);
            console.log(`✦ Phase 2: backfilled text for ${backfilled.changes} duplicates`);
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
        refreshInvestigationCounts(db, investigation_id);
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

        // Auto-cleanup: delete source PST/OST file after successful import
        try {
            fs.unlinkSync(filepath);
            console.log('✦ PST Import: deleted source file to free disk space');
        } catch (e) {
            console.warn('✦ PST Import: could not delete source file:', e.message);
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
}

// Start worker
console.log('✦ DEBUG: calling main()...');
main().then(() => console.log('✦ DEBUG: main() resolved')).catch(e => console.error('✦ DEBUG: main() rejected:', e));
