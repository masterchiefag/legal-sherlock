import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import db from './db.js';
import { authenticate, requireAuth } from './middleware/auth.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/search', searchRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/investigations', investigationsRouter);
app.use('/api/playground', playgroundRouter);
app.use('/api/images', imagesRouter);
app.use('/api/summarize', summarizeRouter);
app.use('/api/audit-logs', auditLogsRouter);

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

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n✦ Received ${signal}, shutting down gracefully...`);
    server.close(() => {
        try { db.close(); } catch (_) {}
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
