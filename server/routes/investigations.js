import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { requireRole, requireInvestigationAccess } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';
import { getInvestigationDb, deleteInvestigationDb } from '../lib/investigation-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const router = express.Router();

// List investigations — filtered by membership (admins see all)
router.get('/', (req, res) => {
    try {
        const t0 = Date.now();
        const isAdmin = req.user.role === 'admin';
        const memberFilter = isAdmin ? '' : `WHERE i.id IN (SELECT investigation_id FROM investigation_members WHERE user_id = ?)`;
        const memberParams = isAdmin ? [] : [req.user.id];

        // Use precomputed counts from investigations table (document_count, email_count, etc.)
        const investigations = db.prepare(`
            SELECT i.*
            FROM investigations i
            ${memberFilter}
            ORDER BY i.created_at DESC
        `).all(...memberParams);
        const tMain = Date.now();

        // Fetch reviewed_count and import_jobs from each per-investigation DB
        const reviewedMap = new Map();
        const jobMap = new Map();
        for (const inv of investigations) {
            try {
                const { readDb: invReadDb } = getInvestigationDb(inv.id);
                const reviewed = invReadDb.prepare(`
                    SELECT COUNT(DISTINCT document_id) as reviewed_count
                    FROM document_reviews WHERE status != 'pending'
                `).get();
                reviewedMap.set(inv.id, reviewed?.reviewed_count || 0);

                const jobs = invReadDb.prepare(`
                    SELECT investigation_id, filename as original_name, status, total_emails, total_attachments, started_at, completed_at
                    FROM import_jobs ORDER BY rowid DESC
                `).all();
                if (jobs.length > 0) jobMap.set(inv.id, jobs);
            } catch (_) {
                // Investigation DB may not exist yet
            }
        }

        const invIds = investigations.map(inv => inv.id);

        // Batch fetch image ingest jobs for all investigations
        const ingestMap = new Map();
        if (invIds.length > 0) {
            const placeholders = invIds.map(() => '?').join(',');
            const allIngestJobs = db.prepare(`
                SELECT investigation_id, image_path, status, result_data, started_at, completed_at
                FROM image_jobs WHERE type = 'ingest' AND investigation_id IN (${placeholders})
                ORDER BY rowid DESC
            `).all(...invIds);
            for (const job of allIngestJobs) {
                if (!ingestMap.has(job.investigation_id)) ingestMap.set(job.investigation_id, []);
                ingestMap.get(job.investigation_id).push(job);
            }
        }

        for (const inv of investigations) {
            inv.reviewed_count = reviewedMap.get(inv.id) || 0;
            inv.import_jobs = jobMap.get(inv.id) || [];
            inv.ingest_jobs = ingestMap.get(inv.id) || [];
        }

        console.log(`[investigations] list: main=${tMain - t0}ms, total=${Date.now() - t0}ms, count=${investigations.length}`);
        res.json(investigations);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get single investigation with full stats
router.get('/:id', requireInvestigationAccess, (req, res) => {
    try {
        const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id);
        if (!inv) return res.status(404).json({ error: 'Investigation not found' });

        let stats = { total_documents: 0, emails: 0, attachments: 0, files: 0, total_size: 0 };
        try {
            const { readDb: invReadDb } = getInvestigationDb(req.params.id);
            stats = invReadDb.prepare(`
                SELECT
                    COUNT(*) as total_documents,
                    SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as emails,
                    SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachments,
                    SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as files,
                    SUM(size_bytes) as total_size
                FROM documents
            `).get();
        } catch (_) {
            // Investigation DB may not exist yet
        }

        res.json({ ...inv, stats });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// List custodians for an investigation with document counts
router.get('/:id/custodians', requireInvestigationAccess, (req, res) => {
    try {
        let custodians = [];
        try {
            const { readDb: invReadDb } = getInvestigationDb(req.params.id);
            custodians = invReadDb.prepare(`
                SELECT custodian as name,
                    COUNT(*) as document_count,
                    SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as email_count,
                    SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachment_count,
                    SUM(CASE WHEN doc_type = 'chat' THEN 1 ELSE 0 END) as chat_count,
                    SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as file_count
                FROM documents
                WHERE custodian IS NOT NULL
                GROUP BY custodian
                ORDER BY document_count DESC
            `).all();
        } catch (_) {
            // Investigation DB may not exist yet
        }
        res.json(custodians);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create new investigation — admin or reviewer
router.post('/', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { name, description, allegation, key_parties, remarks, date_range_start, date_range_end, short_code } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Investigation name is required' });

        // Auto-generate short_code from name if not provided (uppercase, first 3 chars)
        const code = (short_code?.trim() || name.trim().replace(/[^a-zA-Z0-9]/g, '').substring(0, 3)).toUpperCase();

        const id = crypto.randomUUID();
        db.prepare(`
            INSERT INTO investigations (id, name, description, allegation, key_parties, remarks, date_range_start, date_range_end, short_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, name.trim(), description || null, allegation || null, key_parties || null, remarks || null, date_range_start || null, date_range_end || null, code);

        // Create the empty per-investigation DB file
        getInvestigationDb(id);

        // Auto-add creator as member
        db.prepare(
            'INSERT INTO investigation_members (id, investigation_id, user_id, added_by) VALUES (?, ?, ?, ?)'
        ).run(crypto.randomUUID(), id, req.user.id, req.user.id);

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.INVESTIGATION_CREATE,
            resourceType: 'investigation',
            resourceId: id,
            details: { name: name.trim() },
            ipAddress: req.ip,
        });

        const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(id);
        res.status(201).json(inv);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update investigation — admin only
router.put('/:id', requireRole('admin'), requireInvestigationAccess, (req, res) => {
    try {
        const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id);
        if (!inv) return res.status(404).json({ error: 'Investigation not found' });

        const { name, description, status, allegation, key_parties, remarks, date_range_start, date_range_end, short_code } = req.body;

        db.prepare(`
            UPDATE investigations SET
                name = COALESCE(?, name),
                description = ?,
                status = COALESCE(?, status),
                allegation = ?,
                key_parties = ?,
                remarks = ?,
                date_range_start = ?,
                date_range_end = ?,
                short_code = COALESCE(?, short_code),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            name || null, description ?? inv.description,
            status || null, allegation ?? inv.allegation,
            key_parties ?? inv.key_parties, remarks ?? inv.remarks,
            date_range_start ?? inv.date_range_start, date_range_end ?? inv.date_range_end,
            short_code ? short_code.toUpperCase().trim() : null,
            req.params.id
        );

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.INVESTIGATION_UPDATE,
            resourceType: 'investigation',
            resourceId: req.params.id,
            details: { name },
            ipAddress: req.ip,
        });

        const updated = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete investigation and all associated data — admin only
router.delete('/:id', requireRole('admin'), (req, res) => {
    try {
        const invId = req.params.id;
        const inv = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(invId);
        if (!inv) return res.status(404).json({ error: 'Investigation not found' });

        // Get document count before deleting the per-investigation DB
        let deletedDocs = 0;
        try {
            const { readDb: invReadDb } = getInvestigationDb(invId);
            const countRow = invReadDb.prepare('SELECT COUNT(*) as cnt FROM documents').get();
            deletedDocs = countRow?.cnt || 0;
        } catch (_) {}

        // Delete the per-investigation DB file (documents, reviews, classifications, etc.)
        deleteInvestigationDb(invId);

        // Delete main DB records (investigation row + members)
        db.transaction(() => {
            db.prepare('DELETE FROM investigation_members WHERE investigation_id = ?').run(invId);
            db.prepare('DELETE FROM investigations WHERE id = ?').run(invId);
        })();

        // Delete investigation upload directory
        let filesDeleted = 0;
        const invSubdir = path.join(UPLOADS_DIR, invId);
        try {
            if (fs.existsSync(invSubdir)) {
                fs.rmSync(invSubdir, { recursive: true, force: true });
                console.log(`✦ Deleted investigation upload dir: ${invId}`);
                filesDeleted = deletedDocs;
            }
        } catch (_) { /* best effort */ }

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.INVESTIGATION_DELETE,
            resourceType: 'investigation',
            resourceId: invId,
            details: { name: inv.name, deletedDocs, filesDeleted },
            ipAddress: req.ip,
        });

        res.json({ message: `Deleted ${inv.name}: ${deletedDocs} documents, ${filesDeleted} files removed from disk` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// Investigation member management
// ═══════════════════════════════════════════════════

// GET /:id/members — list members
router.get('/:id/members', requireInvestigationAccess, (req, res) => {
    try {
        const members = db.prepare(`
            SELECT im.id as membership_id, im.role_override, im.added_at,
                   u.id, u.email, u.name, u.role as global_role
            FROM investigation_members im
            JOIN users u ON u.id = im.user_id
            WHERE im.investigation_id = ?
            ORDER BY im.added_at ASC
        `).all(req.params.id);
        res.json(members);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /:id/members — add a member (admin only)
router.post('/:id/members', requireRole('admin'), (req, res) => {
    try {
        const { user_id, role_override } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });

        const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(user_id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const existing = db.prepare(
            'SELECT id FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
        ).get(req.params.id, user_id);
        if (existing) return res.status(409).json({ error: 'User is already a member' });

        const id = crypto.randomUUID();
        db.prepare(
            'INSERT INTO investigation_members (id, investigation_id, user_id, role_override, added_by) VALUES (?, ?, ?, ?, ?)'
        ).run(id, req.params.id, user_id, role_override || null, req.user.id);

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.MEMBER_ADD,
            resourceType: 'investigation',
            resourceId: req.params.id,
            details: { added_user_id: user_id, added_user_name: user.name },
            ipAddress: req.ip,
        });

        res.status(201).json({ message: 'Member added', membership_id: id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /:id/members/:userId — remove a member (admin only)
router.delete('/:id/members/:userId', requireRole('admin'), (req, res) => {
    try {
        const result = db.prepare(
            'DELETE FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
        ).run(req.params.id, req.params.userId);

        if (result.changes === 0) return res.status(404).json({ error: 'Membership not found' });

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.MEMBER_REMOVE,
            resourceType: 'investigation',
            resourceId: req.params.id,
            details: { removed_user_id: req.params.userId },
            ipAddress: req.ip,
        });

        res.json({ message: 'Member removed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
