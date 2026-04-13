/**
 * Image Ingest Worker
 *
 * Extracts files from an E01 forensic disk image (or ZIP/UFDR archive)
 * and ingests them into an investigation as searchable documents.
 *
 * Phases: extracting (0–40%) → ingesting (40–100%) → done
 */
import { workerData } from 'worker_threads';
import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ediscovery.db');
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// Worker DB connection (don't set WAL — already set by main process)
const db = new Database(DB_PATH, { timeout: 15000 });
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

const { jobId, imagePath, selectedFiles, investigationId, custodian } = workerData;

// Ensure investigation uploads dir exists
const INV_UPLOADS_DIR = path.join(UPLOADS_DIR, investigationId);
fs.mkdirSync(INV_UPLOADS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════
// Job update
// ═══════════════════════════════════════════════════
const updateJob = db.prepare(
    `UPDATE image_jobs SET status = ?, phase = ?, progress_percent = ?, result_data = ?, error_log = ?,
     completed_at = CASE WHEN ? IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END
     WHERE id = ?`
);

function update(status, phase, pct, resultData, errorLog) {
    updateJob.run(status, phase, pct, resultData, errorLog, status, jobId);
}

// ═══════════════════════════════════════════════════
// Doc identifier generation: CASE_CUST_00001
// ═══════════════════════════════════════════════════
function getCustodianInitials(name) {
    if (!name) return 'XXX';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0].substring(0, 2) + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 3).toUpperCase();
}

const investigation = db.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigationId);
const caseCode = investigation?.short_code || 'CASE';
const custCode = getCustodianInitials(custodian);
const docIdPrefix = `${caseCode}_${custCode}`;

const maxExisting = db.prepare(
    "SELECT MAX(CAST(SUBSTR(doc_identifier, ?, 5) AS INTEGER)) as max_seq FROM documents WHERE doc_identifier LIKE ? AND doc_type IN ('email', 'file')"
).get(docIdPrefix.length + 2, `${docIdPrefix}_%`);
let docSeq = (maxExisting?.max_seq || 0);

function nextDocIdentifier() {
    docSeq++;
    return `${docIdPrefix}_${String(docSeq).padStart(5, '0')}`;
}

function attIdentifier(parentIdentifier, attIndex) {
    return `${parentIdentifier}_${String(attIndex).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════
// Thread resolution (lightweight — uses worker's own DB)
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
            "SELECT thread_id FROM documents WHERE in_reply_to = ? OR email_references = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ? LIMIT 1"
        ).get(messageId, messageId, `${messageId} %`, `% ${messageId}`, `% ${messageId} %`);
        if (child?.thread_id) return child.thread_id;
    }
    return uuidv4();
}

function backfillThread(messageId, threadId) {
    if (!messageId) return;
    db.prepare(
        "UPDATE documents SET thread_id = ? WHERE (in_reply_to = ? OR email_references LIKE ? OR email_references LIKE ? OR email_references LIKE ?) AND thread_id != ?"
    ).run(threadId, messageId, `${messageId} %`, `% ${messageId}`, `% ${messageId} %`, threadId);
}

// ═══════════════════════════════════════════════════
// istat timestamp normalization
// ═══════════════════════════════════════════════════
function normalizeTimestamp(raw) {
    if (!raw) return null;
    try {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch (_) {
        return null;
    }
}

// ═══════════════════════════════════════════════════
// File extraction helpers (from image-extract-worker.js)
// ═══════════════════════════════════════════════════
function extractFileFromImage(imgPath, offset, inode, outPath) {
    return new Promise((resolve, reject) => {
        const args = ['-o', String(offset), imgPath, inode];
        const child = spawn('icat', args);
        const ws = fs.createWriteStream(outPath);
        child.stdout.pipe(ws);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        ws.on('finish', () => {
            if (child.exitCode !== null && child.exitCode !== 0) {
                reject(new Error(`icat exited with code ${child.exitCode}: ${stderr}`));
            } else {
                resolve();
            }
        });
        child.on('error', (err) => { ws.destroy(); reject(err); });
        child.on('close', (code) => {
            if (code !== 0 && !ws.destroyed) {
                ws.destroy();
                reject(new Error(`icat exited with code ${code}: ${stderr}`));
            }
        });
    });
}

function extractZipFile(zipPath, internalPath, outPath) {
    return new Promise((resolve, reject) => {
        const args = ['-p', zipPath, internalPath];
        const child = spawn('unzip', args);
        const ws = fs.createWriteStream(outPath);
        child.stdout.pipe(ws);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        ws.on('finish', () => {
            if (child.exitCode !== null && child.exitCode !== 0) {
                if (child.exitCode === 1) resolve();
                else reject(new Error(`unzip exited with code ${child.exitCode}: ${stderr}`));
            } else {
                resolve();
            }
        });
        child.on('error', (err) => { ws.destroy(); reject(err); });
        child.on('close', (code) => {
            if (code !== 0 && !ws.destroyed) {
                if (code === 1) { ws.destroy(); resolve(); }
                else { ws.destroy(); reject(new Error(`unzip exited with code ${code}: ${stderr}`)); }
            }
        });
    });
}

// ═══════════════════════════════════════════════════
// Prepared statements for document insertion
// ═══════════════════════════════════════════════════
const insertFile = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, text_content_size, status,
        doc_type, content_hash, is_duplicate, investigation_id, custodian, doc_identifier,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        source_path, source_created_at, source_modified_at, source_accessed_at, source_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'file', ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?)
`);

const insertEmail = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, text_content_size, status,
        doc_type, thread_id, message_id, in_reply_to, email_references,
        email_from, email_to, email_cc, email_bcc, email_subject, email_date,
        email_headers_raw, email_received_chain,
        email_originating_ip, email_auth_results, email_server_info, email_delivery_date,
        investigation_id, custodian, doc_identifier, recipient_count,
        source_path, source_created_at, source_modified_at, source_accessed_at, source_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'email', ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?)
`);

const insertAttachment = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, text_content_size, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate, investigation_id, custodian, doc_identifier,
        source_path, source_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'attachment', ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?)
`);

const checkDuplicate = db.prepare(
    'SELECT id, filename FROM documents WHERE content_hash = ? AND investigation_id = ? LIMIT 1'
);

// ═══════════════════════════════════════════════════
// MIME type lookup
// ═══════════════════════════════════════════════════
const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.eml': 'message/rfc822',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.rtf': 'application/rtf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.msg': 'application/vnd.ms-outlook',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.heic': 'image/heic',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
};

function getMime(filename) {
    const ext = path.extname(filename).toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════════════
// MD5 hash
// ═══════════════════════════════════════════════════
function md5File(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
    const tmpDir = path.join(os.tmpdir(), `sherlock-ingest-${jobId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const results = [];
    let ingested = 0;
    let failed = 0;
    let duplicates = 0;
    const errorLog = [];

    try {
        const t0 = Date.now();
        console.log(`✦ Image Ingest: starting — ${selectedFiles.length} files for investigation ${investigationId}`);
        update('processing', 'extracting', 0, JSON.stringify({
            phase_detail: 'extracting', processed: 0, total: selectedFiles.length,
        }), null);

        // ═══════════════════════════════════════════════════
        // Phase 1: Extract files from image to temp dir (0–40%)
        // ═══════════════════════════════════════════════════
        const extractedFiles = [];
        const extractStart = Date.now();

        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const basename = path.basename(file.path);
            const tmpPath = path.join(tmpDir, `${i}_${basename}`);

            try {
                if (file.is_zip) {
                    await extractZipFile(imagePath, file.path, tmpPath);
                } else {
                    await extractFileFromImage(imagePath, file.partition_offset, file.inode, tmpPath);
                }

                const stat = fs.statSync(tmpPath);
                extractedFiles.push({
                    tmpPath,
                    originalPath: file.path,
                    size: stat.size,
                    created: file.created,
                    modified: file.modified,
                    accessed: file.accessed,
                });
                console.log(`✦ Image Ingest: extracted ${basename} (${stat.size} bytes)`);
            } catch (err) {
                console.error(`✦ Image Ingest: extraction failed for ${basename}: ${err.message}`);
                errorLog.push({ path: file.path, phase: 'extract', error: err.message });
                results.push({ path: file.path, status: 'error', error: `Extraction failed: ${err.message}` });
                failed++;
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            }

            const pct = Math.round(((i + 1) / selectedFiles.length) * 40);
            const elapsed = (Date.now() - extractStart) / 1000;
            const rate = (i + 1) / elapsed;
            const remaining = selectedFiles.length - (i + 1);
            const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

            update('processing', 'extracting', pct, JSON.stringify({
                phase_detail: 'extracting', processed: i + 1, total: selectedFiles.length,
                rate: Math.round(rate * 10) / 10, eta_seconds: etaSeconds, failed,
            }), null);
        }

        const extractTime = ((Date.now() - extractStart) / 1000).toFixed(1);
        console.log(`✦ Image Ingest: extraction complete — ${extractedFiles.length} files in ${extractTime}s (${failed} failed)`);

        // ═══════════════════════════════════════════════════
        // Phase 2: Ingest extracted files (40–100%)
        // ═══════════════════════════════════════════════════
        const ingestStart = Date.now();
        update('processing', 'ingesting', 40, JSON.stringify({
            phase_detail: 'ingesting', processed: 0, total: extractedFiles.length,
        }), null);

        for (let i = 0; i < extractedFiles.length; i++) {
            const file = extractedFiles[i];
            const basename = path.basename(file.originalPath);
            const ext = path.extname(basename).toLowerCase();

            try {
                if (ext === '.eml') {
                    await ingestEml(file, results);
                    ingested++;
                } else {
                    const isDup = await ingestFile(file, results);
                    if (isDup) duplicates++;
                    ingested++;
                }
            } catch (err) {
                console.error(`✦ Image Ingest: ingestion failed for ${basename}: ${err.message}`);
                errorLog.push({ path: file.originalPath, phase: 'ingest', error: err.message });
                results.push({ path: file.originalPath, status: 'error', error: `Ingestion failed: ${err.message}` });
                failed++;
            }

            const pct = 40 + Math.round(((i + 1) / extractedFiles.length) * 60);
            const elapsed = (Date.now() - ingestStart) / 1000;
            const rate = (i + 1) / elapsed;
            const remaining = extractedFiles.length - (i + 1);
            const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

            update('processing', 'ingesting', pct, JSON.stringify({
                phase_detail: 'ingesting', processed: i + 1, total: extractedFiles.length,
                rate: Math.round(rate * 10) / 10, eta_seconds: etaSeconds,
                ingested, failed, duplicates,
            }), null);
        }

        const ingestTime = ((Date.now() - ingestStart) / 1000).toFixed(1);
        console.log(`✦ Image Ingest: ingestion phase complete in ${ingestTime}s`);

        // ═══════════════════════════════════════════════════
        // Refresh precomputed investigation counts
        // ═══════════════════════════════════════════════════
        db.prepare(`
            UPDATE investigations SET
                document_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = ?1),
                email_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = ?1 AND doc_type = 'email'),
                attachment_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = ?1 AND doc_type = 'attachment'),
                chat_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = ?1 AND doc_type = 'chat'),
                file_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = ?1 AND doc_type = 'file')
            WHERE id = ?1
        `).run(investigationId);
        console.log('✦ Image Ingest: investigation counts refreshed');

        // ═══════════════════════════════════════════════════
        // Done
        // ═══════════════════════════════════════════════════
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        const resultData = JSON.stringify({ totalFiles: selectedFiles.length, ingested, failed, duplicates, elapsed_seconds: parseFloat(totalTime), files: results });
        const errorJson = errorLog.length > 0 ? JSON.stringify(errorLog) : null;

        if (ingested === 0 && failed > 0) {
            update('failed', 'error', 100, resultData, errorJson);
            console.log(`✦ Image Ingest: all files failed (${totalTime}s)`);
        } else {
            update('completed', 'done', 100, resultData, errorJson);
            console.log(`✦ Image Ingest: complete in ${totalTime}s — ${ingested} ingested, ${failed} failed, ${duplicates} duplicates`);
        }

    } catch (err) {
        console.error('✦ Image Ingest: fatal error:', err);
        update('failed', 'error', 0, null, JSON.stringify([{ error: err.message, fatal: true }]));
    } finally {
        // Cleanup temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        db.close();
    }
}

// ═══════════════════════════════════════════════════
// Ingest a regular file (PDF, DOCX, TXT, etc.)
// ═══════════════════════════════════════════════════
async function ingestFile(file, results) {
    const basename = path.basename(file.originalPath);
    const ext = path.extname(basename).toLowerCase();
    const mime = getMime(basename);
    const docId = uuidv4();
    const bareFilename = `${docId}${ext}`;
    const storedName = `${investigationId}/${bareFilename}`;
    const destPath = path.join(INV_UPLOADS_DIR, bareFilename);

    // Copy to uploads dir
    fs.copyFileSync(file.tmpPath, destPath);

    // Content hash + dedup check
    const hash = md5File(destPath);
    const existing = checkDuplicate.get(hash, investigationId);
    const isDuplicate = !!existing;

    // Text extraction
    let textContent = '';
    let textSize = 0;
    try {
        textContent = await extractText(destPath, mime) || '';
        textSize = Buffer.byteLength(textContent, 'utf-8');
    } catch (err) {
        console.warn(`✦ Image Ingest: text extraction failed for ${basename}: ${err.message}`);
    }

    // Metadata extraction
    let meta = {};
    try {
        meta = await extractMetadata(destPath, mime) || {};
    } catch (err) {
        console.warn(`✦ Image Ingest: metadata extraction failed for ${basename}: ${err.message}`);
    }

    const docIdentifier = nextDocIdentifier();

    insertFile.run(
        docId, storedName, basename, mime, file.size, textContent, textSize,
        hash, isDuplicate ? 1 : 0, investigationId, custodian, docIdentifier,
        meta.author || null, meta.title || null, meta.createdAt || null,
        meta.modifiedAt || null, meta.creatorTool || null, meta.keywords || null,
        file.originalPath,
        normalizeTimestamp(file.created),
        normalizeTimestamp(file.modified),
        normalizeTimestamp(file.accessed),
        jobId
    );

    results.push({
        path: file.originalPath,
        doc_identifier: docIdentifier,
        status: isDuplicate ? 'duplicate' : 'ok',
        doc_type: 'file',
    });

    console.log(`✦ Image Ingest: ingested ${basename} → ${docIdentifier}${isDuplicate ? ' (duplicate)' : ''}`);
    return isDuplicate;
}

// ═══════════════════════════════════════════════════
// Ingest an EML file (email + attachments)
// ═══════════════════════════════════════════════════
async function ingestEml(file, results) {
    const basename = path.basename(file.originalPath);
    const parsed = await parseEml(file.tmpPath);

    const docId = uuidv4();
    const bareFilename = `${docId}.eml`;
    const storedName = `${investigationId}/${bareFilename}`;
    const destPath = path.join(INV_UPLOADS_DIR, bareFilename);
    fs.copyFileSync(file.tmpPath, destPath);

    const textContent = parsed.textBody || '';
    const textSize = Buffer.byteLength(textContent, 'utf-8');

    const threadId = resolveThreadId(parsed.messageId, parsed.inReplyTo, parsed.references);
    const docIdentifier = nextDocIdentifier();

    // Count recipients
    const recipientCount = [parsed.to, parsed.cc, parsed.bcc]
        .filter(Boolean)
        .join(', ')
        .split(',')
        .filter(s => s.trim()).length;

    insertEmail.run(
        docId, storedName, basename, 'message/rfc822', file.size, textContent, textSize,
        threadId, parsed.messageId, parsed.inReplyTo, parsed.references,
        parsed.from, parsed.to, parsed.cc, parsed.bcc, parsed.subject, parsed.date,
        parsed.headersRaw, parsed.receivedChain,
        parsed.originatingIp, parsed.authResults, parsed.serverInfo, parsed.deliveryDate,
        investigationId, custodian, docIdentifier, recipientCount,
        file.originalPath,
        normalizeTimestamp(file.created),
        normalizeTimestamp(file.modified),
        normalizeTimestamp(file.accessed),
        jobId
    );

    // Backfill thread for late-arriving emails
    backfillThread(parsed.messageId, threadId);

    // Process attachments
    for (let i = 0; i < parsed.attachments.length; i++) {
        const att = parsed.attachments[i];
        try {
            const attId = uuidv4();
            const attExt = path.extname(att.filename).toLowerCase() || '.bin';
            const attBareFilename = `${attId}${attExt}`;
            const attStored = `${investigationId}/${attBareFilename}`;
            const attPath = path.join(INV_UPLOADS_DIR, attBareFilename);

            fs.writeFileSync(attPath, att.content);

            const attHash = crypto.createHash('md5').update(att.content).digest('hex');
            const attDup = checkDuplicate.get(attHash, investigationId);

            let attText = '';
            let attTextSize = 0;
            try {
                attText = await extractText(attPath, att.contentType) || '';
                attTextSize = Buffer.byteLength(attText, 'utf-8');
            } catch (_) {}

            let attMeta = {};
            try {
                attMeta = await extractMetadata(attPath, att.contentType) || {};
            } catch (_) {}

            const attDocId = attIdentifier(docIdentifier, i + 1);

            insertAttachment.run(
                attId, attStored, att.filename, att.contentType, att.size, attText, attTextSize,
                docId, threadId,
                attMeta.author || null, attMeta.title || null, attMeta.createdAt || null,
                attMeta.modifiedAt || null, attMeta.creatorTool || null, attMeta.keywords || null,
                attHash, attDup ? 1 : 0, investigationId, custodian, attDocId,
                file.originalPath, jobId
            );
        } catch (err) {
            console.warn(`✦ Image Ingest: attachment ${att.filename} failed: ${err.message}`);
        }
    }

    results.push({
        path: file.originalPath,
        doc_identifier: docIdentifier,
        status: 'ok',
        doc_type: 'email',
        attachments: parsed.attachments.length,
    });

    console.log(`✦ Image Ingest: ingested email ${basename} → ${docIdentifier} (${parsed.attachments.length} attachments)`);
}

main();
