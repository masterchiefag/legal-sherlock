import express from 'express';
import { Worker } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const router = express.Router();

const VALID_EXTENSIONS = ['.e01', '.e01x', '.ex01'];

// ═══════════════════════════════════════════════════
// POST /api/images/scan — Scan E01 image for PST/OST files
// ═══════════════════════════════════════════════════
router.post('/scan', async (req, res) => {
    try {
        const { imagePath } = req.body;

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
            workerData: { jobId, imagePath },
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
