/**
 * ZIP Import Worker
 *
 * Extracts a ZIP archive and processes its contents:
 *  - .eml files → email pipeline (parse, thread, extract attachments)
 *  - .pdf/.docx/.doc/.xls/.xlsx/.txt/.csv/.md → regular file pipeline (text extraction)
 *  - Other files → stored as-is with basic metadata
 *
 * Uses the same job/progress pattern as pst-worker.js.
 */
import { workerData } from 'worker_threads';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db.js';
import {
    disableFtsTriggers, enableFtsTriggers, rebuildFtsIndex,
    refreshInvestigationCounts, walCheckpoint, backfillDuplicateText
} from '../lib/worker-helpers.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { resolveThreadId, backfillThread } from '../lib/threading.js';
import { getSetting } from '../lib/settings.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const { jobId, filename, filepath, originalname, investigation_id, custodian } = workerData;

// Set OCR-related env vars from DB settings so extractText() (called in-process) picks them up
process.env.EXTRACT_MAX_FILE_SIZE_MB = String(getSetting('extract_max_file_size_mb') || 50);
process.env.EXTRACT_OCR_MIN_TEXT_LENGTH = String(getSetting('ocr_min_text_length') || 100);
process.env.EXTRACT_OCR_DPI = String(getSetting('ocr_dpi') || 100);
process.env.EXTRACT_OCR_PDFTOPPM_TIMEOUT = String(getSetting('ocr_pdftoppm_timeout') || 60);
process.env.EXTRACT_OCR_TESSERACT_TIMEOUT = String(getSetting('ocr_tesseract_timeout') || 60);

// Ensure investigation subdirectory exists
const INV_UPLOADS_DIR = path.join(UPLOADS_DIR, investigation_id);
fs.mkdirSync(INV_UPLOADS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════
// Doc identifier generation
// ═══════════════════════════════════════════════════
function getCustodianInitials(name) {
    if (!name) return 'XX';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
}

const investigation = db.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigation_id);
const caseCode = investigation?.short_code || 'CASE';
const custCode = getCustodianInitials(custodian);
const docIdPrefix = `${caseCode}_${custCode}`;

// Get next sequence number (resume-safe)
const maxExisting = db.prepare(
    "SELECT MAX(CAST(SUBSTR(doc_identifier, ?, 5) AS INTEGER)) as max_seq FROM documents WHERE doc_identifier LIKE ?"
).get(docIdPrefix.length + 2, `${docIdPrefix}_%`);
let docSeq = (maxExisting?.max_seq || 0);

function nextDocId() {
    docSeq++;
    return `${docIdPrefix}_${String(docSeq).padStart(5, '0')}`;
}

function attIdentifier(parentIdentifier, attIndex) {
    return `${parentIdentifier}_${String(attIndex).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════
// Counters & state
// ═══════════════════════════════════════════════════
let totalEmails = 0;
let totalFiles = 0;
let totalAttachments = 0;
let errorLog = [];

// In-memory dedup
const seenHashes = new Map();

// Prepared statements
const updateProgress = db.prepare(
    "UPDATE import_jobs SET total_emails = ?, total_attachments = ?, phase = ?, progress_percent = ? WHERE id = ?"
);

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
        content_hash, is_duplicate, investigation_id, custodian, doc_identifier
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
        ?, ?, ?, ?, ?)
`);

const insertFile = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, text_content_size, status,
        doc_type, content_hash, is_duplicate, investigation_id, custodian, doc_identifier,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Batched transaction wrapper
const DB_BATCH_SIZE = getSetting('import_db_batch_size') || 500;
let batchBuffer = [];

const flushBatch = db.transaction((ops) => {
    for (const op of ops) op();
});

function flushPendingOps() {
    if (batchBuffer.length === 0) return;
    flushBatch(batchBuffer);
    batchBuffer = [];
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

// Known extensions by category
const EML_EXTS = new Set(['.eml']);
const EXTRACTABLE_EXTS = new Set(['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.txt', '.csv', '.md']);
const SKIP_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv', '.webm',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.ppt', '.pptx', '.emz', '.wmf', '.xlsb',
]);

/**
 * Extract a single file from a ZIP using `unzip -p` (pipe to stdout).
 * Returns the file content as a Buffer.
 */
function extractFileFromZip(zipPath, internalPath) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn('unzip', ['-p', zipPath, internalPath]);
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', () => {}); // ignore stderr warnings
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // code 1 = minor warnings, data is fine
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`unzip exited with code ${code} for ${internalPath}`));
            }
        });
        child.on('error', reject);
    });
}

/**
 * List all files inside a ZIP archive.
 * Returns array of { path, size }.
 * Uses `zipinfo` which is more reliable than `unzip -l` across ZIP formats.
 */
async function listZipContents(zipPath) {
    const { stdout } = await execFileAsync('zipinfo', [zipPath], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
    });

    const files = [];
    const lines = stdout.split('\n');
    // zipinfo detailed output per file looks like:
    // -rw-rw-rw-  2.0 unx  1483541 bX defN 25-Jan-08 14:54 folder/file.pdf
    // Directories end with / and start with 'd'
    for (const line of lines) {
        // Match: permissions, version, os, size, ..., filename
        // The size is the 4th field (uncompressed size)
        const match = line.match(/^[-l]\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
        if (match) {
            const size = parseInt(match[1], 10);
            const filePath = match[2].trim();
            // Skip directories (end with /) and __MACOSX junk
            if (!filePath.endsWith('/') && !filePath.startsWith('__MACOSX/') && !filePath.includes('/.')) {
                files.push({ path: filePath, size });
            }
        }
    }
    return files;
}

/**
 * Get MIME type from extension (best-effort).
 */
function mimeFromExt(ext) {
    const map = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
        '.eml': 'message/rfc822',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
    };
    return map[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════════════
// Process a single EML entry from the ZIP
// ═══════════════════════════════════════════════════
async function processEmlEntry(zipPath, entry) {
    const emailId = uuidv4();
    const emailDocId = nextDocId();

    try {
        const emlBuffer = await extractFileFromZip(zipPath, entry.path);
        const eml = await parseEml(emlBuffer);

        const textBody = eml.textBody || '';
        const subject = eml.subject || '(no subject)';

        // Count recipients across To, Cc, Bcc
        const countAddrs = (s) => s ? s.split(',').filter(a => a.trim()).length : 0;
        const recipientCount = countAddrs(eml.to) + countAddrs(eml.cc) + countAddrs(eml.bcc);

        // Threading
        const threadId = resolveThreadId(eml.messageId, eml.inReplyTo, eml.references);
        backfillThread(threadId, eml.messageId, eml.references);

        // Folder path from ZIP structure
        const folderPath = path.dirname(entry.path) === '.' ? '/' : '/' + path.dirname(entry.path);

        batchBuffer.push(() => {
            insertEmail.run(
                emailId, path.basename(entry.path), subject,
                'message/rfc822', entry.size, textBody,
                threadId, eml.messageId || null, eml.inReplyTo || null, eml.references || null,
                eml.from || null, eml.to || null, eml.cc || null, subject, eml.date || null,
                eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
                eml.originatingIp || null, eml.authResults || null,
                eml.serverInfo || null, eml.deliveryDate || null,
                investigation_id, custodian || null, folderPath, textBody.length,
                emailDocId, recipientCount
            );
        });

        totalEmails++;

        // Process email attachments
        let attIdx = 0;
        for (const att of (eml.attachments || [])) {
            attIdx++;
            const attId = uuidv4();
            const attExt = path.extname(att.filename || '.bin') || '.bin';
            const attBasename = `${attId}${attExt}`;
            const attFilename = `${investigation_id}/${attBasename}`;
            const attPath = path.join(UPLOADS_DIR, attFilename);

            // Hash for dedup
            const attHash = crypto.createHash('md5').update(att.content).digest('hex');
            const isDuplicate = seenHashes.has(attHash) ? 1 : 0;

            if (!isDuplicate) {
                seenHashes.set(attHash, attFilename);
                await fsp.writeFile(attPath, att.content);
            }

            const finalFilename = isDuplicate ? seenHashes.get(attHash) : attFilename;
            const attDocId = attIdentifier(emailDocId, attIdx);

            batchBuffer.push(() => {
                insertAttachment.run(
                    attId, finalFilename, att.filename || 'attachment',
                    att.contentType || 'application/octet-stream', att.size || att.content.length,
                    emailId, threadId,
                    attHash, isDuplicate, investigation_id, custodian || null, attDocId
                );
            });

            totalAttachments++;
        }
    } catch (err) {
        errorLog.push({ phase: 'eml-parse', file: entry.path, error: err.message });
        console.warn(`✦ ZIP Import: failed to parse EML ${entry.path}: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════
// Process a regular file entry from the ZIP
// ═══════════════════════════════════════════════════
async function processFileEntry(zipPath, entry) {
    const ext = path.extname(entry.path).toLowerCase();
    const originalName = path.basename(entry.path);
    const fileId = uuidv4();
    const fileDocId = nextDocId();

    // Skip known non-extractable binaries
    if (SKIP_EXTS.has(ext)) {
        return; // silently skip images, videos, etc.
    }

    try {
        // Extract file from ZIP to disk
        const fileBuffer = await extractFileFromZip(zipPath, entry.path);

        // Hash for dedup
        const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
        const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;

        let diskFilename;
        if (!isDuplicate) {
            seenHashes.set(contentHash, `${investigation_id}/${fileId}${ext}`);
            diskFilename = `${investigation_id}/${fileId}${ext}`;
            await fsp.writeFile(path.join(UPLOADS_DIR, diskFilename), fileBuffer);
        } else {
            diskFilename = seenHashes.get(contentHash);
        }

        // Extract text — skip for duplicates (backfilled after loop)
        const diskPath = path.join(UPLOADS_DIR, diskFilename);
        const mime = mimeFromExt(ext);
        let text = '';
        let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };

        if (!isDuplicate && EXTRACTABLE_EXTS.has(ext)) {
            try {
                text = await extractText(diskPath, mime);
            } catch (e) {
                text = `[Extraction failed: ${e.message}]`;
            }

            try {
                meta = await extractMetadata(diskPath, mime);
            } catch (_) { /* best effort */ }
        }

        batchBuffer.push(() => {
            insertFile.run(
                fileId, diskFilename, originalName,
                mime, entry.size, text || null, text ? text.length : 0,
                contentHash, isDuplicate, investigation_id, custodian || null, fileDocId,
                meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords
            );
        });

        totalFiles++;
    } catch (err) {
        errorLog.push({ phase: 'file-extract', file: entry.path, error: err.message });
        console.warn(`✦ ZIP Import: failed to process ${entry.path}: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
    console.log(`✦ ZIP Import Worker started: jobId=${jobId}, file=${originalname}`);

    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);

        // Disable FTS triggers for bulk import
        disableFtsTriggers(db);

        // List ZIP contents
        console.log(`✦ ZIP Import: listing archive contents...`);
        const entries = await listZipContents(filepath);
        console.log(`✦ ZIP Import: found ${entries.length} files in archive`);

        if (entries.length === 0) {
            throw new Error('ZIP archive is empty or could not be read');
        }

        // Categorize entries
        const emlEntries = [];
        const fileEntries = [];
        for (const entry of entries) {
            const ext = path.extname(entry.path).toLowerCase();
            if (EML_EXTS.has(ext)) {
                emlEntries.push(entry);
            } else {
                fileEntries.push(entry);
            }
        }

        console.log(`✦ ZIP Import: ${emlEntries.length} EML files, ${fileEntries.length} other files`);
        const totalEntries = entries.length;

        // Phase 1: Process EML files
        db.prepare("UPDATE import_jobs SET phase = 'importing', total_eml_files = ? WHERE id = ?").run(emlEntries.length, jobId);

        let processed = 0;
        for (const entry of emlEntries) {
            await processEmlEntry(filepath, entry);
            processed++;

            // Flush DB in batches
            if (batchBuffer.length >= DB_BATCH_SIZE) {
                flushPendingOps();
            }

            if (processed % 50 === 0 || processed === emlEntries.length) {
                const pct = Math.round((processed / totalEntries) * 100);
                updateProgress.run(totalEmails, totalAttachments, 'importing', pct, jobId);
                console.log(`✦ ZIP Import: ${processed}/${totalEntries} (${pct}%) — ${totalEmails} emails, ${totalAttachments} attachments`);
            }
        }

        // Phase 2: Process regular files
        db.prepare("UPDATE import_jobs SET phase = 'extracting' WHERE id = ?").run(jobId);

        for (const entry of fileEntries) {
            await processFileEntry(filepath, entry);
            processed++;

            if (batchBuffer.length >= DB_BATCH_SIZE) {
                flushPendingOps();
            }

            if (processed % 50 === 0 || processed === totalEntries) {
                const pct = Math.round((processed / totalEntries) * 100);
                updateProgress.run(totalEmails, totalAttachments + totalFiles, 'extracting', pct, jobId);
                console.log(`✦ ZIP Import: ${processed}/${totalEntries} (${pct}%) — ${totalFiles} files extracted`);
            }
        }

        // Final flush
        flushPendingOps();

        // Backfill text from originals into duplicates (shared helper, hash-map lookup)
        backfillDuplicateText(db, investigation_id);

        // Mark extraction_done_at — frontend uses this to detect stuck jobs
        const memBefore = process.memoryUsage();
        console.log(`✦ ZIP Finalization: heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(memBefore.rss / 1024 / 1024).toFixed(0)}MB`);
        db.prepare("UPDATE import_jobs SET extraction_done_at = datetime('now') WHERE id = ?").run(jobId);

        // Mark complete FIRST — FTS rebuild can OOM on large databases

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
        `).run(totalEmails, totalAttachments + totalFiles, JSON.stringify(errorLog), jobId);

        console.log(`✦ ZIP Import complete: ${totalEmails} emails, ${totalFiles} files, ${totalAttachments} attachments`);

        // Refresh precomputed investigation counts
        refreshInvestigationCounts(db, investigation_id);

        // Rebuild FTS (heavy — scans all docs across all investigations)
        enableFtsTriggers(db);
        rebuildFtsIndex(db);
        const memAfter = process.memoryUsage();
        console.log(`✦ ZIP FTS rebuild done — heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(memAfter.rss / 1024 / 1024).toFixed(0)}MB`);

        // Cleanup source ZIP
        try {
            fs.unlinkSync(filepath);
            console.log('✦ ZIP Import: deleted source ZIP to free disk space');
        } catch (e) {
            console.warn('✦ ZIP Import: could not delete source file:', e.message);
        }

    } catch (err) {
        const mem = process.memoryUsage();
        console.error(`ZIP Worker fatal error (heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB):`, err);

        // Mark failed FIRST, then best-effort FTS recovery
        db.prepare(`
            UPDATE import_jobs SET status = 'failed',
            error_log = ?, completed_at = datetime('now') WHERE id = ?
        `).run(JSON.stringify([...errorLog, { error: err.message, fatal: true }]), jobId);

        // Best-effort FTS recovery
        enableFtsTriggers(db);
        rebuildFtsIndex(db);
    }
}

main()
    .then(() => console.log('✦ ZIP Worker: main() resolved'))
    .catch(e => console.error('✦ ZIP Worker: main() rejected:', e));
