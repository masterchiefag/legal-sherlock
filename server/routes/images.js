import express from 'express';
import { Worker } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { requireRole } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const router = express.Router();

// All image extraction routes require admin
router.use(requireRole('admin'));

const VALID_EXTENSIONS = ['.e01', '.e01x', '.ex01', '.zip', '.ufdr'];

// ═══════════════════════════════════════════════════
// POST /api/images/scan — Scan E01 image for PST/OST files
// ═══════════════════════════════════════════════════
router.post('/scan', async (req, res) => {
    try {
        const { imagePath, searchPattern } = req.body;

        if (!imagePath) {
            return res.status(400).json({ error: 'imagePath is required' });
        }

        // Validate path is absolute
        if (!path.isAbsolute(imagePath)) {
            return res.status(400).json({ error: 'imagePath must be an absolute path' });
        }

        // Validate extension
        const ext = path.extname(imagePath).toLowerCase();
        if (!VALID_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ error: `Invalid file type. Supported: ${VALID_EXTENSIONS.join(', ')}` });
        }

        // Validate file exists
        if (!fs.existsSync(imagePath)) {
            return res.status(400).json({ error: 'File not found at the specified path' });
        }

        // Check sleuthkit is installed
        try {
            await execFileAsync('which', ['mmls']);
        } catch (_) {
            return res.status(400).json({ error: 'sleuthkit is not installed. Run: brew install sleuthkit' });
        }

        // Create job
        const jobId = uuidv4();
        db.prepare(
            "INSERT INTO image_jobs (id, type, status, image_path, phase) VALUES (?, 'scan', 'pending', ?, 'queued')"
        ).run(jobId, imagePath);

        // Spawn worker
        const workerPath = path.join(__dirname, '..', 'workers', 'image-scan-worker.js');
        const worker = new Worker(workerPath, {
            workerData: { jobId, imagePath, searchPattern: searchPattern || '.*\\.(pst|ost)$' },
        });

        worker.on('error', (err) => {
            console.error(`\u26a0 Image Scan Worker error for job ${jobId}:`, err);
            db.prepare(
                "UPDATE image_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`\u26a0 Image Scan Worker exited with code ${code} for job ${jobId}`);
            }
        });

        res.status(202).json({ jobId, message: 'Scan started' });

    } catch (err) {
        console.error('Image scan error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// POST /api/images/extract — Extract selected files from E01 image
// ═══════════════════════════════════════════════════
router.post('/extract', (req, res) => {
    try {
        const { scanJobId, selectedFiles, outputDir } = req.body;

        if (!scanJobId || !selectedFiles || !outputDir) {
            return res.status(400).json({ error: 'scanJobId, selectedFiles, and outputDir are required' });
        }

        if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
            return res.status(400).json({ error: 'selectedFiles must be a non-empty array' });
        }

        // Validate output directory
        if (!path.isAbsolute(outputDir)) {
            return res.status(400).json({ error: 'outputDir must be an absolute path' });
        }

        if (!fs.existsSync(outputDir)) {
            return res.status(400).json({ error: 'Output directory does not exist' });
        }

        try {
            fs.accessSync(outputDir, fs.constants.W_OK);
        } catch (_) {
            return res.status(400).json({ error: 'Output directory is not writable' });
        }

        // Validate scan job
        const scanJob = db.prepare("SELECT * FROM image_jobs WHERE id = ? AND type = 'scan'").get(scanJobId);
        if (!scanJob) {
            return res.status(404).json({ error: 'Scan job not found' });
        }
        if (scanJob.status !== 'completed') {
            return res.status(400).json({ error: 'Scan job has not completed yet' });
        }

        // Create extraction job
        const jobId = uuidv4();
        db.prepare(
            "INSERT INTO image_jobs (id, type, status, image_path, output_dir, phase) VALUES (?, 'extract', 'pending', ?, ?, 'queued')"
        ).run(jobId, scanJob.image_path, outputDir);

        // Spawn worker
        const workerPath = path.join(__dirname, '..', 'workers', 'image-extract-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                jobId,
                imagePath: scanJob.image_path,
                selectedFiles,
                outputDir,
            },
        });

        worker.on('error', (err) => {
            console.error(`\u26a0 Image Extract Worker error for job ${jobId}:`, err);
            db.prepare(
                "UPDATE image_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`\u26a0 Image Extract Worker exited with code ${code} for job ${jobId}`);
            }
        });

        res.status(202).json({ jobId, message: 'Extraction started' });

    } catch (err) {
        console.error('Image extract error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// POST /api/images/ingest — Extract & ingest files from E01 into an investigation
// ═══════════════════════════════════════════════════
router.post('/ingest', (req, res) => {
    try {
        const { scanJobId, selectedFiles, investigationId, custodian } = req.body;

        if (!scanJobId || !selectedFiles || !investigationId || !custodian) {
            return res.status(400).json({ error: 'scanJobId, selectedFiles, investigationId, and custodian are required' });
        }

        if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
            return res.status(400).json({ error: 'selectedFiles must be a non-empty array' });
        }

        // Validate scan job
        const scanJob = db.prepare("SELECT * FROM image_jobs WHERE id = ? AND type = 'scan'").get(scanJobId);
        if (!scanJob) {
            return res.status(404).json({ error: 'Scan job not found' });
        }
        if (scanJob.status !== 'completed') {
            return res.status(400).json({ error: 'Scan job has not completed yet' });
        }

        // Validate investigation exists
        const inv = db.prepare('SELECT id FROM investigations WHERE id = ?').get(investigationId);
        if (!inv) {
            return res.status(404).json({ error: 'Investigation not found' });
        }

        // Create ingest job
        const jobId = uuidv4();
        db.prepare(
            "INSERT INTO image_jobs (id, type, status, image_path, phase, investigation_id, custodian) VALUES (?, 'ingest', 'pending', ?, 'queued', ?, ?)"
        ).run(jobId, scanJob.image_path, investigationId, custodian);

        // Spawn worker
        const workerPath = path.join(__dirname, '..', 'workers', 'image-ingest-worker.js');
        const worker = new Worker(workerPath, {
            workerData: {
                jobId,
                imagePath: scanJob.image_path,
                selectedFiles,
                investigationId,
                custodian,
            },
        });

        worker.on('error', (err) => {
            console.error(`⚠ Image Ingest Worker error for job ${jobId}:`, err);
            db.prepare(
                "UPDATE image_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`⚠ Image Ingest Worker exited with code ${code} for job ${jobId}`);
            }
        });

        res.status(202).json({ jobId, message: 'Ingestion started' });

    } catch (err) {
        console.error('Image ingest error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// POST /api/images/extract-whatsapp — Extract WhatsApp data from UFDR into ZIP
// ═══════════════════════════════════════════════════
router.post('/extract-whatsapp', async (req, res) => {
    try {
        const { imagePath, outputPath } = req.body;

        if (!imagePath || !outputPath) {
            return res.status(400).json({ error: 'imagePath and outputPath are required' });
        }

        if (!path.isAbsolute(imagePath) || !path.isAbsolute(outputPath)) {
            return res.status(400).json({ error: 'Paths must be absolute' });
        }

        const ext = path.extname(imagePath).toLowerCase();
        if (!VALID_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ error: `Invalid file type. Supported: ${VALID_EXTENSIONS.join(', ')}` });
        }

        if (!fs.existsSync(imagePath)) {
            return res.status(400).json({ error: 'Archive file not found at the specified path' });
        }

        // Validate output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            return res.status(400).json({ error: 'Output directory does not exist' });
        }

        if (!outputPath.toLowerCase().endsWith('.zip')) {
            return res.status(400).json({ error: 'Output path must end with .zip' });
        }

        // Scan archive for ChatStorage.sqlite
        let chatStoragePath = null;
        try {
            const { stdout } = await execFileAsync('unzip', ['-l', imagePath], {
                timeout: 120000,
                maxBuffer: 100 * 1024 * 1024,
            });
            const lines = stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/\s(\S*ChatStorage\.sqlite)\s*$/i);
                if (match) {
                    chatStoragePath = match[1];
                    break;
                }
            }
        } catch (e) {
            return res.status(400).json({ error: `Could not read archive: ${e.message}` });
        }

        if (!chatStoragePath) {
            return res.status(400).json({ error: 'No ChatStorage.sqlite found in this archive. This may not be a WhatsApp extraction.' });
        }

        // Create job
        const jobId = uuidv4();
        db.prepare(
            "INSERT INTO image_jobs (id, type, status, image_path, output_dir, phase) VALUES (?, 'whatsapp_zip', 'pending', ?, ?, 'queued')"
        ).run(jobId, imagePath, outputDir);

        // Spawn worker
        const workerPath = path.join(__dirname, '..', 'workers', 'whatsapp-zip-worker.js');
        const worker = new Worker(workerPath, {
            workerData: { jobId, imagePath, chatStoragePath, outputPath },
        });

        worker.on('error', (err) => {
            console.error(`\u26a0 WhatsApp ZIP Worker error for job ${jobId}:`, err);
            db.prepare(
                "UPDATE image_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(JSON.stringify([{ error: `Worker crashed: ${err.message}` }]), jobId);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`\u26a0 WhatsApp ZIP Worker exited with code ${code} for job ${jobId}`);
            }
        });

        res.status(202).json({ jobId, chatStoragePath, message: 'WhatsApp extraction started' });

    } catch (err) {
        console.error('WhatsApp extract error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/images/jobs/:id — Poll job status
// ═══════════════════════════════════════════════════
router.get('/jobs/:id', (req, res) => {
    try {
        const job = db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        // Parse JSON fields for client
        if (job.result_data) {
            try { job.result_data = JSON.parse(job.result_data); } catch (_) {}
        }
        if (job.error_log) {
            try { job.error_log = JSON.parse(job.error_log); } catch (_) {}
        }

        res.json(job);
    } catch (err) {
        console.error('Image job status error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
