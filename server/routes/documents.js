import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db, { refreshInvestigationCounts } from '../db.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { resolveThreadId, backfillThread } from '../lib/threading.js';
import { requireRole, requireInvestigationAccess } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// Helper: ensure investigation subdirectory exists and return subdir-prefixed filename
function investigationFilename(investigationId, basename) {
    const subdir = path.join(UPLOADS_DIR, investigationId);
    fs.mkdirSync(subdir, { recursive: true });
    return `${investigationId}/${basename}`;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Upload to investigation subdir if available, else root uploads/
        const invId = req.body?.investigation_id;
        if (invId) {
            const subdir = path.join(UPLOADS_DIR, invId);
            fs.mkdirSync(subdir, { recursive: true });
            cb(null, subdir);
        } else {
            cb(null, UPLOADS_DIR);
        }
    },
    filename: (req, file, cb) => {
        const id = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${id}${ext}`);
    },
});

const upload = multer({
    storage,
    // limits: { fileSize: 5000 * 1024 * 1024 }, // Removed to allow massive PST files
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.txt', '.csv', '.md', '.eml', '.pst', '.ost', '.sqlite', '.db', '.zip'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}`));
        }
    },
});

const multerUpload = upload.array('files', 50);

const router = express.Router();

// ═══════════════════════════════════════════════════
// Recover stuck import jobs from previous server crash
// ═══════════════════════════════════════════════════
const stuckJobs = db.prepare("SELECT id, filename FROM import_jobs WHERE status IN ('processing', 'pending')").all();
for (const job of stuckJobs) {
    db.prepare(`
        UPDATE import_jobs SET status = 'failed',
        error_log = ?, completed_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify([{ error: 'Server restarted during import', fatal: true }]), job.id);
    console.log(`✦ Recovered stuck import job: ${job.filename} (${job.id})`);
}

// ═══════════════════════════════════════════════════
// Doc identifier generation for direct uploads
// ═══════════════════════════════════════════════════
function getCustodianInitials(name) {
    if (!name) return 'XXX';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        // First 2 chars of first name + first char of last name
        return (parts[0].substring(0, 2) + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 3).toUpperCase();
}

function generateDocIdentifier(investigationId, custodian, docType) {
    const investigation = db.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigationId);
    const caseCode = investigation?.short_code || 'CASE';
    const custCode = getCustodianInitials(custodian);
    const prefix = `${caseCode}_${custCode}`;

    const maxExisting = db.prepare(
        "SELECT MAX(CAST(SUBSTR(doc_identifier, ?, 5) AS INTEGER)) as max_seq FROM documents WHERE doc_identifier LIKE ?"
    ).get(prefix.length + 2, `${prefix}_%`);
    const seq = (maxExisting?.max_seq || 0) + 1;
    return `${prefix}_${String(seq).padStart(5, '0')}`;
}

function generateAttIdentifier(parentIdentifier, attIndex) {
    return `${parentIdentifier}_${String(attIndex).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════
// Shared: insert a parsed email + its attachments
// ═══════════════════════════════════════════════════
async function processEmailData(eml, emailId, filename, originalName, sizeBytes, investigation_id, custodian) {
    const result = {
        id: emailId,
        name: originalName,
        status: 'ready',
        size: sizeBytes,
        doc_type: 'email',
        subject: eml.subject,
        from: eml.from,
        thread_id: null,
        attachments: [],
    };

    // Resolve thread
    const threadId = resolveThreadId(eml.messageId, eml.inReplyTo, eml.references);
    result.thread_id = threadId;

    // Generate doc identifier
    const emailDocId = generateDocIdentifier(investigation_id, custodian, 'email');

    // Insert email document (with transport metadata)
    db.prepare(`
      INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, message_id, in_reply_to, email_references,
        email_from, email_to, email_cc, email_subject, email_date,
        email_bcc, email_headers_raw, email_received_chain,
        email_originating_ip, email_auth_results, email_server_info, email_delivery_date,
        investigation_id, custodian, doc_identifier, text_content_size
      ) VALUES (?, ?, ?, ?, ?, ?, 'ready',
        'email', ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?)
    `).run(
        emailId, filename, originalName, 'message/rfc822', sizeBytes, eml.textBody,
        threadId, eml.messageId, eml.inReplyTo, eml.references,
        eml.from, eml.to, eml.cc, eml.subject, eml.date,
        eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
        eml.originatingIp || null, eml.authResults || null,
        eml.serverInfo || null, eml.deliveryDate || null,
        investigation_id, custodian || null, emailDocId, eml.textBody ? eml.textBody.length : 0
    );

    // Backfill thread for late arrivals
    backfillThread(threadId, eml.messageId, eml.references);

    // Process attachments
    for (const att of eml.attachments) {
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attBasename = `${attId}${attExt}`;
        const attFilename = investigationFilename(investigation_id, attBasename);
        const attPath = path.join(UPLOADS_DIR, attFilename);

        fs.writeFileSync(attPath, att.content);

        // Compute content hash for deduplication
        const attHash = crypto.createHash('md5').update(att.content).digest('hex');
        const existingWithHash = db.prepare(`SELECT id FROM documents WHERE content_hash = ? AND investigation_id = ? LIMIT 1`).get(attHash, investigation_id);
        const isDuplicate = existingWithHash ? 1 : 0;

        let attText = '';
        try {
            attText = await extractText(attPath, att.contentType);
        } catch (e) {
            attText = `[Could not extract text: ${e.message}]`;
        }

        let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
        try {
            meta = await extractMetadata(attPath, att.contentType);
        } catch (e) { /* best effort */ }

        const attDocId = generateAttIdentifier(emailDocId, result.attachments.length + 1);

        db.prepare(`
          INSERT INTO documents (
            id, filename, original_name, mime_type, size_bytes, text_content, status,
            doc_type, parent_id, thread_id, content_hash, is_duplicate, investigation_id, custodian,
            doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
            doc_identifier, text_content_size
          ) VALUES (?, ?, ?, ?, ?, ?, 'ready',
            'attachment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(attId, attFilename, att.filename, att.contentType, att.size, attText, emailId, threadId, attHash, isDuplicate, investigation_id, custodian || null,
            meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords,
            attDocId, attText ? attText.length : 0);

        result.attachments.push({ id: attId, name: att.filename, size: att.size, content_type: att.contentType });
    }

    return result;
}

// ═══════════════════════════════════════════════════
// EML processing pipeline
// ═══════════════════════════════════════════════════
async function processEmlFile(file, investigation_id, custodian) {
    const emailId = path.basename(file.filename, path.extname(file.filename));
    try {
        const eml = await parseEml(file.path);
        const result = await processEmailData(eml, emailId, file.filename, file.originalname, file.size, investigation_id, custodian);
        return [result];
    } catch (err) {
        try {
            db.prepare(`
              INSERT INTO documents (id, filename, original_name, mime_type, size_bytes, status, doc_type)
              VALUES (?, ?, ?, 'message/rfc822', ?, 'error', 'email')
            `).run(emailId, file.filename, file.originalname, file.size);
        } catch (_) { /* ignore */ }
        return [{ id: emailId, name: file.originalname, status: 'error', error: err.message, doc_type: 'email' }];
    }
}

// ═══════════════════════════════════════════════════
// PST processing pipeline (Now delegated to Worker)
// ═══════════════════════════════════════════════════
import { Worker } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

function spawnPstWorker(jobId, filename, filepath, originalname, investigation_id, custodian, extractionOnly = false) {
    const workerPath = path.join(__dirname, '..', 'workers', 'pst-worker.js');
    const worker = new Worker(workerPath, {
        workerData: { jobId, filename, filepath, originalname, investigation_id, custodian, resume: extractionOnly, extractionOnly }
    });

    worker.on('error', (err) => {
        console.error(`⚠ PST Worker error for job ${jobId}:`, err);
        db.prepare(`UPDATE import_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId
        );
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`⚠ PST Worker for job ${jobId} stopped with exit code ${code}`);
        }
    });

    return worker;
}

// ═══════════════════════════════════════════════════
// Chat/SQLite processing pipeline (Delegated to Worker)
// ═══════════════════════════════════════════════════
function spawnChatWorker(jobId, filename, filepath, originalname, investigation_id, custodian, zipPath = null, sqliteEntry = null) {
    const workerPath = path.join(__dirname, '..', 'workers', 'chat-worker.js');
    const worker = new Worker(workerPath, {
        workerData: { jobId, filename, filepath, originalname, investigation_id, custodian, zipPath, sqliteEntry }
    });

    worker.on('error', (err) => {
        console.error(`⚠ Chat Worker error for job ${jobId}:`, err);
        db.prepare(`UPDATE import_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId
        );
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`⚠ Chat Worker for job ${jobId} stopped with exit code ${code}`);
        }
    });

    return worker;
}

// ═══════════════════════════════════════════════════
// ZIP processing pipeline (Delegated to Worker)
// ═══════════════════════════════════════════════════
function spawnZipWorker(jobId, filename, filepath, originalname, investigation_id, custodian) {
    const workerPath = path.join(__dirname, '..', 'workers', 'zip-worker.js');
    const worker = new Worker(workerPath, {
        workerData: { jobId, filename, filepath, originalname, investigation_id, custodian }
    });

    worker.on('error', (err) => {
        console.error(`⚠ ZIP Worker error for job ${jobId}:`, err);
        db.prepare(`UPDATE import_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId
        );
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`⚠ ZIP Worker for job ${jobId} stopped with exit code ${code}`);
        }
    });

    return worker;
}

// ═══════════════════════════════════════════════════
// Regular file processing (PDF, DOCX, TXT, etc.)
// ═══════════════════════════════════════════════════
async function processRegularFile(file, investigation_id, custodian) {
    const id = path.basename(file.filename, path.extname(file.filename));

    // Compute content hash for deduplication
    const fileBuffer = fs.readFileSync(file.path);
    const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const existingWithHash = db.prepare(`SELECT id FROM documents WHERE content_hash = ? AND investigation_id = ? LIMIT 1`).get(contentHash, investigation_id);
    const isDuplicate = existingWithHash ? 1 : 0;

    const fileDocId = generateDocIdentifier(investigation_id, custodian, 'file');

    db.prepare(`
    INSERT INTO documents (id, filename, original_name, mime_type, size_bytes, status, doc_type, content_hash, is_duplicate, investigation_id, custodian, doc_identifier)
    VALUES (?, ?, ?, ?, ?, 'processing', 'file', ?, ?, ?, ?, ?)
  `).run(id, file.filename, file.originalname, file.mimetype, file.size, contentHash, isDuplicate, investigation_id, custodian || null, fileDocId);

    try {
        const text = await extractText(file.path, file.mimetype);

        // Extract document metadata (author, title, dates, etc.)
        let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
        try {
            meta = await extractMetadata(file.path, file.mimetype);
        } catch (_) { /* best effort */ }

        db.prepare(`UPDATE documents SET text_content = ?, text_content_size = ?, status = 'ready',
            doc_author = ?, doc_title = ?, doc_created_at = ?,
            doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ?
            WHERE id = ?`
        ).run(text, text ? text.length : 0, meta.author, meta.title, meta.createdAt,
            meta.modifiedAt, meta.creatorTool, meta.keywords, id);
        return [{ id, name: file.originalname, status: 'ready', size: file.size, doc_type: 'file' }];
    } catch (err) {
        db.prepare(`UPDATE documents SET status = 'error' WHERE id = ?`).run(id);
        return [{ id, name: file.originalname, status: 'error', error: err.message, doc_type: 'file' }];
    }
}

// ═══════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════

// Upload documents (supports multiple files) — reviewer+ with investigation access
router.post('/upload', requireRole('admin', 'reviewer'), (req, res, next) => {
    multerUpload(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `File upload error: ${err.message}` });
        } else if (err) {
            return res.status(500).json({ error: `Upload failed: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { investigation_id } = req.body;
        if (!investigation_id) {
            return res.status(400).json({ error: 'investigation_id is required' });
        }

        // Verify investigation access
        if (req.user.role !== 'admin') {
            const membership = db.prepare(
                'SELECT id FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
            ).get(investigation_id, req.user.id);
            if (!membership) {
                return res.status(403).json({ error: 'You do not have access to this investigation' });
            }
        }

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.DOC_UPLOAD,
            resourceType: 'investigation',
            resourceId: investigation_id,
            details: { fileCount: req.files?.length },
            ipAddress: req.ip,
        });

        // Use provided custodian, or fall back to filename (minus extension) of the first file
        let custodian = req.body.custodian;
        if (!custodian && req.files?.length > 0) {
            custodian = path.parse(req.files[0].originalname).name;
        }

        const allResults = [];

        for (const file of req.files) {
            // Prefix filename with investigation subdir for DB storage
            // Multer already wrote to uploads/{investigation_id}/, so file.path is correct
            // but file.filename is just the basename — prefix it for DB references
            file.filename = `${investigation_id}/${file.filename}`;

            const ext = path.extname(file.originalname).toLowerCase();

            if (ext === '.eml') {
                const emlResults = await processEmlFile(file, investigation_id, custodian);
                allResults.push(...emlResults);
            } else if (ext === '.pst' || ext === '.ost') {
                // Background job for PST
                const jobId = uuidv4();

                // Initialize job in database (store filepath for resume support)
                db.prepare(`
                    INSERT INTO import_jobs (id, filename, filepath, status, investigation_id, custodian)
                    VALUES (?, ?, ?, 'pending', ?, ?)
                `).run(jobId, file.originalname, file.path, investigation_id, custodian || null);

                spawnPstWorker(jobId, file.filename, file.path, file.originalname, investigation_id, custodian);

                // Return 202 Accepted instead of waiting for results
                return res.status(202).json({
                    message: "PST file uploaded. Processing in background.",
                    jobId: jobId
                });
            } else if (ext === '.sqlite' || ext === '.db') {
                // Background job for Chat DBs
                const jobId = uuidv4();

                db.prepare(`
                    INSERT INTO import_jobs (id, filename, filepath, status, investigation_id, custodian, job_type)
                    VALUES (?, ?, ?, 'pending', ?, ?, 'chat')
                `).run(jobId, file.originalname, file.path, investigation_id, custodian || null);

                spawnChatWorker(jobId, file.filename, file.path, file.originalname, investigation_id, custodian);

                return res.status(202).json({
                    message: "Chat DB uploaded. Processing in background.",
                    jobId: jobId
                });
            } else if (ext === '.zip') {
                // Check if ZIP contains a WhatsApp ChatStorage.sqlite
                let sqliteEntry = null;
                try {
                    const { stdout } = await execFileAsync('unzip', ['-l', file.path], {
                        timeout: 30000,
                        maxBuffer: 10 * 1024 * 1024,
                    });
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        const match = line.match(/\s(\S*ChatStorage\.sqlite)\s*$/i);
                        if (match) {
                            sqliteEntry = match[1];
                            break;
                        }
                    }
                } catch (e) {
                    console.log(`⚠ Could not peek inside ZIP: ${e.message}`);
                }

                const jobId = uuidv4();

                const zipJobType = sqliteEntry ? 'chat' : 'zip';
                db.prepare(`
                    INSERT INTO import_jobs (id, filename, filepath, status, investigation_id, custodian, job_type)
                    VALUES (?, ?, ?, 'pending', ?, ?, ?)
                `).run(jobId, file.originalname, file.path, investigation_id, custodian || null, zipJobType);

                if (sqliteEntry) {
                    // WhatsApp chat+media ZIP — route to chat worker
                    console.log(`✦ Detected WhatsApp ZIP: ${sqliteEntry}`);
                    spawnChatWorker(jobId, file.filename, file.path, file.originalname, investigation_id, custodian, file.path, sqliteEntry);

                    return res.status(202).json({
                        message: "WhatsApp chat+media ZIP uploaded. Processing in background.",
                        jobId: jobId,
                        filename: file.originalname
                    });
                }

                spawnZipWorker(jobId, file.filename, file.path, file.originalname, investigation_id, custodian);

                return res.status(202).json({
                    message: "ZIP archive uploaded. Processing in background.",
                    jobId: jobId,
                    filename: file.originalname
                });
            } else {
                const fileResults = await processRegularFile(file, investigation_id, custodian);
                allResults.push(...fileResults);
            }
        }

        // Refresh precomputed investigation counts
        refreshInvestigationCounts(investigation_id);

        // Only returns here for non-PST files
        res.json({ uploaded: allResults.length, documents: allResults });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get recent failed jobs for the active investigation (must be before /jobs/:id)
router.get('/jobs/failed/:investigation_id', (req, res) => {
    try {
        const jobs = db.prepare(
            "SELECT * FROM import_jobs WHERE investigation_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 5"
        ).all(req.params.investigation_id);
        res.json({ jobs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get recent import jobs for the active investigation (all statuses)
router.get('/jobs/recent/:investigation_id', (req, res) => {
    try {
        const jobs = db.prepare(
            "SELECT * FROM import_jobs WHERE investigation_id = ? ORDER BY started_at DESC LIMIT 5"
        ).all(req.params.investigation_id);
        res.json({ jobs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/documents/jobs/:id - Poll job status
router.get('/jobs/:id', (req, res) => {
    try {
        const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(req.params.id);
        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }
        res.json(job);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Resume a failed PST import job — admin or reviewer
router.post('/jobs/:id/resume', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'failed') return res.status(400).json({ error: 'Only failed jobs can be resumed' });

        // Check if PST file still exists — if not, we can still run Phase 2 (extraction only)
        const sourceFileExists = job.filepath && fs.existsSync(job.filepath);
        const extractionOnly = !sourceFileExists;
        if (extractionOnly) {
            // Verify there are actually documents to extract
            const pending = db.prepare(
                "SELECT COUNT(*) as c FROM documents WHERE status = 'processing' AND investigation_id = ?"
            ).get(job.investigation_id);
            if (!pending || pending.c === 0) {
                return res.status(400).json({ error: 'Source file deleted and no pending documents to extract. Please re-upload.' });
            }
            console.log(`✦ Resume: source file gone, running extraction-only for ${pending.c} pending documents`);
        }

        // Cleanup orphaned files in uploads/ that aren't referenced by any document or import job
        try {
            const referencedFiles = new Set();
            const docFiles = db.prepare('SELECT filename FROM documents WHERE filename IS NOT NULL').all();
            for (const r of docFiles) referencedFiles.add(r.filename);
            const jobFiles = db.prepare('SELECT filepath FROM import_jobs WHERE filepath IS NOT NULL').all();
            for (const r of jobFiles) referencedFiles.add(path.basename(r.filepath));

            const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
            let cleaned = 0;
            let freedBytes = 0;
            // Scan subdirectories (investigation folders) and root-level files
            const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Scan investigation subdirectory
                    const subdir = path.join(uploadsDir, entry.name);
                    const subFiles = fs.readdirSync(subdir);
                    for (const f of subFiles) {
                        const relPath = `${entry.name}/${f}`;
                        if (!referencedFiles.has(relPath) && !referencedFiles.has(f)) {
                            try {
                                const fp = path.join(subdir, f);
                                const stat = fs.statSync(fp);
                                freedBytes += stat.size;
                                fs.unlinkSync(fp);
                                cleaned++;
                            } catch (_) {}
                        }
                    }
                } else if (!referencedFiles.has(entry.name)) {
                    // Legacy root-level file
                    try {
                        const fp = path.join(uploadsDir, entry.name);
                        const stat = fs.statSync(fp);
                        freedBytes += stat.size;
                        fs.unlinkSync(fp);
                        cleaned++;
                    } catch (_) {}
                }
            }
            if (cleaned > 0) {
                const freedMB = (freedBytes / 1e6).toFixed(1);
                console.log(`✦ Resume cleanup: deleted ${cleaned} orphaned files (${freedMB} MB freed)`);
            }
        } catch (e) {
            console.warn('Resume cleanup failed (non-fatal):', e.message);
        }

        // Accumulate time spent before failure, then reset started_at for this attempt
        db.prepare(`
            UPDATE import_jobs SET status = 'processing', phase = ?,
            error_log = NULL, completed_at = NULL,
            elapsed_seconds = COALESCE(elapsed_seconds, 0) + CAST((julianday(COALESCE(completed_at, datetime('now'))) - julianday(started_at)) * 86400 AS INTEGER),
            started_at = datetime('now')
            WHERE id = ?
        `).run(extractionOnly ? 'extracting' : 'importing', job.id);

        // Spawn worker with resume flag
        const workerPath = path.join(__dirname, '..', 'workers', 'pst-worker.js');
        console.log(`✦ DEBUG Resume: spawning worker with extractionOnly=${extractionOnly}, investigation_id=${job.investigation_id}, filepath=${job.filepath}`);
        const worker = new Worker(workerPath, {
            workerData: {
                jobId: job.id,
                filename: job.filename,
                filepath: job.filepath,
                originalname: job.filename,
                investigation_id: job.investigation_id,
                custodian: job.custodian,
                resume: true,
                extractionOnly,
            }
        });

        worker.on('error', (err) => {
            console.error(`⚠ PST Worker resume error for job ${job.id}:`, err);
            db.prepare(`UPDATE import_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?`).run(
                JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), job.id
            );
        });

        worker.on('exit', (code) => {
            if (code !== 0) console.error(`⚠ PST Worker resume for job ${job.id} stopped with exit code ${code}`);
        });

        res.json({ message: 'Import resumed', jobId: job.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// List documents with pagination and filters
router.get('/', (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            sort = 'uploaded_at',
            order = 'desc',
            status,
            tag,
            doc_type,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const allowedSorts = ['uploaded_at', 'original_name', 'size_bytes', 'email_date'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'uploaded_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

        let where = "WHERE 1=1 AND (d.doc_type != 'attachment' OR d.doc_type IS NULL)";
        const params = [];

        if (status) {
            where += ' AND d.status = ?';
            params.push(status);
        }

        if (tag) {
            where += ' AND d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)';
            params.push(tag);
        }

        if (doc_type) {
            where += ' AND d.doc_type = ?';
            params.push(doc_type);
        }

        const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM documents d ${where}
    `).get(...params);

        const documents = db.prepare(`
      SELECT d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
        d.doc_type, d.thread_id, d.parent_id,
        d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
        (SELECT GROUP_CONCAT(t.name, ', ')
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id) as tag_names,
        (SELECT dr.status FROM document_reviews dr
         WHERE dr.document_id = d.id
         ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status,
        (SELECT COUNT(*) FROM documents c WHERE c.parent_id = d.id) as attachment_count,
        (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type IN ('email', 'chat') AND t.investigation_id = d.investigation_id) as thread_count,
        (SELECT cl.score FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_score
      FROM documents d
      ${where}
      ORDER BY d.${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

        res.json({
            documents,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countRow.total,
                pages: Math.ceil(countRow.total / parseInt(limit)),
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get single document with thread + attachments
router.get('/:id', (req, res) => {
    try {
        const doc = db.prepare(`
      SELECT d.*,
        (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id) as tags,
        (SELECT json_group_array(json_object('id', dr.id, 'status', dr.status, 'notes', dr.notes, 'reviewed_at', dr.reviewed_at))
         FROM document_reviews dr
         WHERE dr.document_id = d.id
         ORDER BY dr.reviewed_at DESC) as reviews
      FROM documents d
      WHERE d.id = ?
    `).get(req.params.id);

        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Parse JSON arrays
        doc.tags = JSON.parse(doc.tags || '[]').filter(t => t.id !== null);
        doc.reviews = JSON.parse(doc.reviews || '[]').filter(r => r.id !== null);

        // If email, fetch thread siblings
        if (doc.thread_id) {
            doc.thread = db.prepare(`
        SELECT id, original_name, email_from, email_to, email_subject, email_date, doc_type, message_id, in_reply_to
        FROM documents
        WHERE thread_id = ? AND doc_type IN ('email', 'chat') AND investigation_id = ?
        ORDER BY email_date ASC
      `).all(doc.thread_id, doc.investigation_id);
        } else {
            doc.thread = [];
        }

        // Fetch child attachments
        doc.attachments = db.prepare(`
      SELECT id, original_name, mime_type, size_bytes, filename
      FROM documents
      WHERE parent_id = ?
    `).all(req.params.id);

        // If this IS an attachment, fetch parent info + sibling attachments
        if (doc.parent_id) {
            doc.parent = db.prepare(`
        SELECT id, original_name, email_subject, email_from
        FROM documents WHERE id = ?
      `).get(doc.parent_id);

            doc.siblings = db.prepare(`
        SELECT id, original_name, mime_type, size_bytes, filename
        FROM documents
        WHERE parent_id = ? AND id != ?
      `).all(doc.parent_id, req.params.id);
        }

        res.json(doc);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete document (and its children) — admin or reviewer with investigation access
router.delete('/:id', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const doc = db.prepare('SELECT filename, investigation_id FROM documents WHERE id = ?').get(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Verify investigation access for non-admins
        if (req.user.role !== 'admin' && doc.investigation_id) {
            const membership = db.prepare(
                'SELECT id FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
            ).get(doc.investigation_id, req.user.id);
            if (!membership) {
                return res.status(403).json({ error: 'You do not have access to this investigation' });
            }
        }

        // Delete child attachment files
        const children = db.prepare('SELECT filename FROM documents WHERE parent_id = ?').all(req.params.id);
        for (const child of children) {
            const childPath = path.join(UPLOADS_DIR, child.filename);
            if (fs.existsSync(childPath)) fs.unlinkSync(childPath);
        }
        db.prepare('DELETE FROM documents WHERE parent_id = ?').run(req.params.id);

        // Delete parent file
        const filePath = path.join(UPLOADS_DIR, doc.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);

        // Refresh precomputed investigation counts
        if (doc.investigation_id) refreshInvestigationCounts(doc.investigation_id);

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.DOC_DELETE,
            resourceType: 'document',
            resourceId: req.params.id,
            ipAddress: req.ip,
        });

        res.json({ deleted: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
