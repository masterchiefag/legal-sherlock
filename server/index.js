import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import db from './db.js';
import { authenticate, requireAuth } from './middleware/auth.js';
import { withInvestigationDb } from './middleware/investigation-db.js';
import { closeAll as closeAllInvestigationDbs, checkpointAll as checkpointAllInvestigationDbs, listInvestigationDbs, getInvestigationDb } from './lib/investigation-db.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import documentsRouter from './routes/documents.js';
import searchRouter from './routes/search.js';
import tagsRouter from './routes/tags.js';
import reviewsRouter from './routes/reviews.js';
import classifyRouter from './routes/classify.js';
import investigationsRouter from './routes/investigations.js';
import playgroundRouter from './routes/playground.js';
import imagesRouter from './routes/images.js';
import summarizeRouter from './routes/summarize.js';
import auditLogsRouter from './routes/audit-logs.js';
import batchesRouter from './routes/batches.js';
import settingsRouter from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════
// Startup cleanup: remove stale temp directories left by killed workers
// ═══════════════════════════════════════════════════
// When workers get SIGKILL'd (e.g. extract-worker timeout), their finally blocks
// never run, leaving behind large temp dirs. Safe to clean on startup since
// stuck jobs are marked as failed and no workers should be running yet.
const STALE_TEMP_PREFIXES = ['sherlock-ocr-', 'pst-import-', 'whatsapp-zip-', 'chat-import-'];
try {
    const tmpEntries = fs.readdirSync(os.tmpdir());
    let cleaned = 0;
    for (const entry of tmpEntries) {
        if (STALE_TEMP_PREFIXES.some(prefix => entry.startsWith(prefix))) {
            const fullPath = path.join(os.tmpdir(), entry);
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`✦ Startup cleanup: removed stale temp ${entry}`);
                cleaned++;
            } catch (err) {
                console.warn(`✦ Startup cleanup: failed to remove ${entry}:`, err.message);
            }
        }
    }
    if (cleaned > 0) {
        console.log(`✦ Startup cleanup: removed ${cleaned} stale temp directories`);
    }
} catch (err) {
    console.warn('✦ Startup cleanup: could not scan tmpdir:', err.message);
}

// ═══════════════════════════════════════════════════
// Startup cleanup: mark stuck import jobs as failed across all investigation DBs
// ═══════════════════════════════════════════════════
try {
    const invIds = listInvestigationDbs();
    let totalStuck = 0;
    for (const invId of invIds) {
        try {
            const { db: invDb } = getInvestigationDb(invId);
            const stuckJobs = invDb.prepare(
                "SELECT id, filename, total_emails, total_attachments FROM import_jobs WHERE status IN ('processing', 'pending')"
            ).all();
            if (stuckJobs.length > 0) {
                const markFailed = invDb.prepare(
                    "UPDATE import_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?"
                );
                for (const job of stuckJobs) {
                    markFailed.run(job.id);
                    console.log(`✦ Startup: marked stuck job ${job.filename} (${job.id}) as failed in investigation ${invId}`);
                }
                totalStuck += stuckJobs.length;
            }
        } catch (err) {
            console.warn(`✦ Startup: failed to check stuck jobs for investigation ${invId}:`, err.message);
        }
    }
    if (totalStuck > 0) {
        console.log(`✦ Startup: marked ${totalStuck} stuck import job(s) as failed`);
    }
} catch (err) {
    console.warn('✦ Startup: could not scan for stuck jobs:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || true, // restrict in production via CORS_ORIGIN env var
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Basic security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Allow framing for /uploads/* (PDF iframe viewer), deny elsewhere
    if (!req.path.startsWith('/uploads/')) {
        res.setHeader('X-Frame-Options', 'DENY');
    }
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// Populate req.user from JWT on all requests (permissive — does not block)
app.use(authenticate);

// Global auth enforcement — public paths bypass, everything else requires auth
app.use('/api', (req, res, next) => {
    const publicPaths = ['/auth/login', '/auth/register', '/auth/setup-status', '/health'];
    if (publicPaths.some(p => req.path === p)) return next();
    return requireAuth(req, res, next);
});

// API Routes — global tables only (no investigation DB needed)
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/audit-logs', auditLogsRouter);
app.use('/api/playground', playgroundRouter);
app.use('/api/images', imagesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/investigations', investigationsRouter);

// API Routes — per-investigation DB (middleware resolves investigation_id → opens DB)
app.use('/api/documents', withInvestigationDb, documentsRouter);
app.use('/api/search', withInvestigationDb, searchRouter);
app.use('/api/tags', withInvestigationDb, tagsRouter);
app.use('/api/reviews', withInvestigationDb, reviewsRouter);
app.use('/api/classify', withInvestigationDb, classifyRouter);
app.use('/api/summarize', withInvestigationDb, summarizeRouter);
app.use('/api/batches', withInvestigationDb, batchesRouter);

// Health check
app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
    } catch (err) {
        res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
    }
});

const server = app.listen(PORT, () => {
    console.log(`✦ eDiscovery API running on http://localhost:${PORT}`);
});

// Periodic WAL checkpoint every 5 minutes (PASSIVE never blocks)
const walCheckpointInterval = setInterval(() => {
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
    checkpointAllInvestigationDbs();
}, 5 * 60 * 1000);

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n✦ Received ${signal}, shutting down gracefully...`);
    clearInterval(walCheckpointInterval);
    server.close(() => {
        try { db.close(); } catch (_) {}
        closeAllInvestigationDbs();
        console.log('✦ Server closed.');
        process.exit(0);
    });
    // Force exit after 10s if connections don't close
    setTimeout(() => {
        console.error('✦ Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
