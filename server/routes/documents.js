import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { extractText, extractMetadata } from '../lib/extract.js';
import { parseEml } from '../lib/eml-parser.js';
import { resolveThreadId, backfillThread } from '../lib/threading.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
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
        const allowed = ['.pdf', '.docx', '.txt', '.csv', '.md', '.eml', '.pst', '.ost'];
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
// Shared: insert a parsed email + its attachments
// ═══════════════════════════════════════════════════
async function processEmailData(eml, emailId, filename, originalName, sizeBytes, investigation_id) {
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

    // Insert email document (with transport metadata)
    db.prepare(`
      INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, message_id, in_reply_to, email_references,
        email_from, email_to, email_cc, email_subject, email_date,
        email_bcc, email_headers_raw, email_received_chain,
        email_originating_ip, email_auth_results, email_server_info, email_delivery_date,
        investigation_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'ready',
        'email', ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?)
    `).run(
        emailId, filename, originalName, 'message/rfc822', sizeBytes, eml.textBody,
        threadId, eml.messageId, eml.inReplyTo, eml.references,
        eml.from, eml.to, eml.cc, eml.subject, eml.date,
        eml.bcc || null, eml.headersRaw || null, eml.receivedChain || null,
        eml.originatingIp || null, eml.authResults || null,
        eml.serverInfo || null, eml.deliveryDate || null,
        investigation_id
    );

    // Backfill thread for late arrivals
    backfillThread(threadId, eml.messageId, eml.references);

    // Process attachments
    for (const att of eml.attachments) {
        const attId = uuidv4();
        const attExt = path.extname(att.filename) || '.bin';
        const attFilename = `${attId}${attExt}`;
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

        db.prepare(`
          INSERT INTO documents (
            id, filename, original_name, mime_type, size_bytes, text_content, status,
            doc_type, parent_id, thread_id, content_hash, is_duplicate, investigation_id,
            doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords
          ) VALUES (?, ?, ?, ?, ?, ?, 'ready',
            'attachment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(attId, attFilename, att.filename, att.contentType, att.size, attText, emailId, threadId, attHash, isDuplicate, investigation_id,
               meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords);

        result.attachments.push({ id: attId, name: att.filename, size: att.size, content_type: att.contentType });
    }

    return result;
}

// ═══════════════════════════════════════════════════
// EML processing pipeline
// ═══════════════════════════════════════════════════
async function processEmlFile(file, investigation_id) {
    const emailId = path.basename(file.filename, path.extname(file.filename));
    try {
        const eml = await parseEml(file.path);
        const result = await processEmailData(eml, emailId, file.filename, file.originalname, file.size, investigation_id);
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

function spawnPstWorker(jobId, filename, filepath, originalname, investigation_id) {
    const workerPath = path.join(__dirname, '..', 'workers', 'pst-worker.js');
    const worker = new Worker(workerPath, {
        workerData: { jobId, filename, filepath, originalname, investigation_id }
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
// Regular file processing (PDF, DOCX, TXT, etc.)
// ═══════════════════════════════════════════════════
async function processRegularFile(file, investigation_id) {
    const id = path.basename(file.filename, path.extname(file.filename));

    // Compute content hash for deduplication
    const fileBuffer = fs.readFileSync(file.path);
    const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const existingWithHash = db.prepare(`SELECT id FROM documents WHERE content_hash = ? AND investigation_id = ? LIMIT 1`).get(contentHash, investigation_id);
    const isDuplicate = existingWithHash ? 1 : 0;

    db.prepare(`
    INSERT INTO documents (id, filename, original_name, mime_type, size_bytes, status, doc_type, content_hash, is_duplicate, investigation_id)
    VALUES (?, ?, ?, ?, ?, 'processing', 'file', ?, ?, ?)
  `).run(id, file.filename, file.originalname, file.mimetype, file.size, contentHash, isDuplicate, investigation_id);

    try {
        const text = await extractText(file.path, file.mimetype);

        // Extract document metadata (author, title, dates, etc.)
        let meta = { author: null, title: null, createdAt: null, modifiedAt: null, creatorTool: null, keywords: null };
        try {
            meta = await extractMetadata(file.path, file.mimetype);
        } catch (_) { /* best effort */ }

        db.prepare(`UPDATE documents SET text_content = ?, status = 'ready',
            doc_author = ?, doc_title = ?, doc_created_at = ?,
            doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ?
            WHERE id = ?`
        ).run(text, meta.author, meta.title, meta.createdAt,
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

// Upload documents (supports multiple files)
router.post('/upload', (req, res, next) => {
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

        const allResults = [];

        for (const file of req.files) {
            const ext = path.extname(file.originalname).toLowerCase();

            if (ext === '.eml') {
                const emlResults = await processEmlFile(file, investigation_id);
                allResults.push(...emlResults);
            } else if (ext === '.pst' || ext === '.ost') {
                // Background job for PST
                const jobId = uuidv4();
                
                // Initialize job in database (store filepath for resume support)
                db.prepare(`
                    INSERT INTO import_jobs (id, filename, filepath, status, investigation_id)
                    VALUES (?, ?, ?, 'pending', ?)
                `).run(jobId, file.originalname, file.path, investigation_id);

                spawnPstWorker(jobId, file.filename, file.path, file.originalname, investigation_id);
                
                // Return 202 Accepted instead of waiting for results
                return res.status(202).json({ 
                    message: "PST file uploaded. Processing in background.", 
                    jobId: jobId 
                });
            } else {
                const fileResults = await processRegularFile(file, investigation_id);
                allResults.push(...fileResults);
            }
        }

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

// Resume a failed PST import job
router.post('/jobs/:id/resume', (req, res) => {
    try {
        const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'failed') return res.status(400).json({ error: 'Only failed jobs can be resumed' });

        // Check if PST file still exists
        if (!fs.existsSync(job.filepath)) {
            return res.status(400).json({ error: 'PST file no longer exists on disk. Please re-upload.' });
        }

        // Accumulate time spent before failure, then reset started_at for this attempt
        db.prepare(`
            UPDATE import_jobs SET status = 'processing', phase = 'importing',
            error_log = NULL, completed_at = NULL,
            elapsed_seconds = COALESCE(elapsed_seconds, 0) + CAST((julianday(COALESCE(completed_at, datetime('now'))) - julianday(started_at)) * 86400 AS INTEGER),
            started_at = datetime('now')
            WHERE id = ?
        `).run(job.id);

        // Spawn worker with resume flag
        const workerPath = path.join(__dirname, '..', 'workers', 'pst-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                jobId: job.id,
                filename: job.filename,
                filepath: job.filepath,
                originalname: job.filename,
                investigation_id: job.investigation_id,
                resume: true,
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
        (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type = 'email' AND t.investigation_id = d.investigation_id) as thread_count,
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
        SELECT id, original_name, email_from, email_to, email_subject, email_date, doc_type
        FROM documents
        WHERE thread_id = ? AND doc_type = 'email' AND investigation_id = ?
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

        // If this IS an attachment, fetch parent info
        if (doc.parent_id) {
            doc.parent = db.prepare(`
        SELECT id, original_name, email_subject, email_from
        FROM documents WHERE id = ?
      `).get(doc.parent_id);
        }

        res.json(doc);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete document (and its children)
router.delete('/:id', (req, res) => {
    try {
        const doc = db.prepare('SELECT filename FROM documents WHERE id = ?').get(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

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

        res.json({ deleted: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
