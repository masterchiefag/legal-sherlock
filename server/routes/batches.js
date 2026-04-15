import express from 'express';
import crypto from 'crypto';
import mainDb, { readDb as mainReadDb } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';
import { parseQuery, buildSearchFilter } from '../lib/search-filter.js';

const router = express.Router();

// POST /api/batches — Create batches from search results
router.post('/', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { investigation_id, batch_size, search_criteria } = req.body;

        if (!investigation_id) return res.status(400).json({ error: 'investigation_id required' });
        if (!batch_size || batch_size < 1) return res.status(400).json({ error: 'batch_size must be >= 1' });
        if (!search_criteria) return res.status(400).json({ error: 'search_criteria required' });

        // Re-execute search server-side to get all matching doc IDs
        const params = { ...search_criteria, investigation_id };
        const { filterWhere, filterParams } = buildSearchFilter(params, req.user);

        const q = (search_criteria.q || '').trim();
        const hasQuery = q.length > 0;
        const ftsQuery = hasQuery ? parseQuery(q) : '';
        const isDocIdQuery = hasQuery && /^[A-Z0-9]{2,}_[A-Z0-9]{2,}(_|$)/i.test(q);
        const useFts = hasQuery && ftsQuery.trim() && ftsQuery.trim() !== 'OR' && !isDocIdQuery;

        let docIds;
        if (useFts) {
            docIds = req.invReadDb.prepare(`
                SELECT d.id FROM documents_fts fts
                CROSS JOIN documents d ON d.rowid = fts.rowid
                WHERE documents_fts MATCH ?
                ${filterWhere}
                ORDER BY d.doc_identifier ASC, d.uploaded_at ASC
            `).all(ftsQuery, ...filterParams).map(r => r.id);
        } else {
            docIds = req.invReadDb.prepare(`
                SELECT d.id FROM documents d
                WHERE 1=1 ${filterWhere}
                ORDER BY d.doc_identifier ASC, d.uploaded_at ASC
            `).all(...filterParams).map(r => r.id);
        }

        if (docIds.length === 0) {
            return res.status(400).json({ error: 'No documents match the search criteria' });
        }

        // Split into chunks
        const size = parseInt(batch_size);
        const chunks = [];
        for (let i = 0; i < docIds.length; i += size) {
            chunks.push(docIds.slice(i, i + size));
        }

        // Get next batch_number for this investigation
        const maxRow = req.invReadDb.prepare(
            'SELECT MAX(batch_number) as max_num FROM review_batches WHERE investigation_id = ?'
        ).get(investigation_id);
        let nextNum = (maxRow?.max_num || 0) + 1;

        const batchIds = [];
        const searchCriteriaJson = JSON.stringify(search_criteria);

        const insertBatch = req.invDb.prepare(`
            INSERT INTO review_batches (id, investigation_id, batch_number, batch_size, total_docs, search_criteria, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertDoc = req.invDb.prepare(`
            INSERT INTO review_batch_documents (batch_id, document_id, position)
            VALUES (?, ?, ?)
        `);

        const createAll = req.invDb.transaction(() => {
            for (const chunk of chunks) {
                const batchId = crypto.randomUUID();
                batchIds.push(batchId);
                insertBatch.run(batchId, investigation_id, nextNum, size, chunk.length, searchCriteriaJson, req.user.id);
                for (let j = 0; j < chunk.length; j++) {
                    insertDoc.run(batchId, chunk[j], j + 1);
                }
                nextNum++;
            }
        });
        createAll();

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.BATCH_CREATE,
            resourceType: 'batch',
            resourceId: batchIds[0],
            details: { batches_created: chunks.length, total_documents: docIds.length, batch_size: size },
            ipAddress: req.ip,
        });

        res.json({
            batches_created: chunks.length,
            total_documents: docIds.length,
            batch_size: size,
            batch_ids: batchIds,
        });
    } catch (err) {
        console.error('Batch create error:', err);
        res.status(500).json({ error: 'Failed to create batches' });
    }
});

// GET /api/batches — List batches for an investigation
router.get('/', (req, res) => {
    try {
        const { investigation_id, assignee_id, status } = req.query;
        if (!investigation_id) return res.status(400).json({ error: 'investigation_id required' });

        // Non-admin: check investigation access
        if (req.user.role !== 'admin') {
            const member = mainReadDb.prepare(
                'SELECT 1 FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
            ).get(investigation_id, req.user.id);
            if (!member) return res.status(403).json({ error: 'No access to this investigation' });
        }

        let where = 'WHERE rb.investigation_id = ?';
        const params = [investigation_id];

        if (assignee_id) {
            where += ' AND rb.assignee_id = ?';
            params.push(assignee_id);
        }
        if (status) {
            where += ' AND rb.status = ?';
            params.push(status);
        }

        const batches = req.invReadDb.prepare(`
            SELECT rb.*,
                (SELECT COUNT(*) FROM review_batch_documents rbd
                 JOIN document_reviews dr ON dr.document_id = rbd.document_id
                 WHERE rbd.batch_id = rb.id
                 AND dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
                 AND dr.status != 'pending'
                ) as reviewed_count
            FROM review_batches rb
            ${where}
            ORDER BY rb.batch_number ASC
        `).all(...params);

        // Resolve user names from main DB
        const userIds = [...new Set(batches.flatMap(b => [b.assignee_id, b.created_by].filter(Boolean)))];
        const userMap = {};
        if (userIds.length > 0) {
            const placeholders = userIds.map(() => '?').join(',');
            const users = mainReadDb.prepare(
                `SELECT id, name FROM users WHERE id IN (${placeholders})`
            ).all(...userIds);
            for (const u of users) userMap[u.id] = u.name;
        }

        // Parse search_criteria JSON and attach user names
        for (const b of batches) {
            b.assignee_name = userMap[b.assignee_id] || null;
            b.created_by_name = userMap[b.created_by] || null;
            try { b.search_criteria = JSON.parse(b.search_criteria); } catch { /* keep as string */ }
        }

        res.json({ batches });
    } catch (err) {
        console.error('Batch list error:', err);
        res.status(500).json({ error: 'Failed to list batches' });
    }
});

// GET /api/batches/:id — Batch detail with paginated documents
router.get('/:id', (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const batch = req.invReadDb.prepare(`
            SELECT rb.*,
                (SELECT COUNT(*) FROM review_batch_documents rbd
                 JOIN document_reviews dr ON dr.document_id = rbd.document_id
                 WHERE rbd.batch_id = rb.id
                 AND dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
                 AND dr.status != 'pending'
                ) as reviewed_count
            FROM review_batches rb
            WHERE rb.id = ?
        `).get(req.params.id);

        if (!batch) return res.status(404).json({ error: 'Batch not found' });

        // Resolve user names from main DB
        const userIds = [batch.assignee_id, batch.created_by].filter(Boolean);
        if (userIds.length > 0) {
            const placeholders = userIds.map(() => '?').join(',');
            const users = mainReadDb.prepare(
                `SELECT id, name FROM users WHERE id IN (${placeholders})`
            ).all(...userIds);
            const userMap = {};
            for (const u of users) userMap[u.id] = u.name;
            batch.assignee_name = userMap[batch.assignee_id] || null;
            batch.created_by_name = userMap[batch.created_by] || null;
        } else {
            batch.assignee_name = null;
            batch.created_by_name = null;
        }

        // Check investigation access for non-admins
        if (req.user.role !== 'admin') {
            const member = mainReadDb.prepare(
                'SELECT 1 FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
            ).get(batch.investigation_id, req.user.id);
            if (!member) return res.status(403).json({ error: 'No access' });
        }

        try { batch.search_criteria = JSON.parse(batch.search_criteria); } catch { /* keep as string */ }

        const total = req.invReadDb.prepare(
            'SELECT COUNT(*) as cnt FROM review_batch_documents WHERE batch_id = ?'
        ).get(req.params.id).cnt;

        const documents = req.invReadDb.prepare(`
            SELECT rbd.position, d.id, d.doc_identifier, d.original_name, d.doc_type,
                d.email_subject, d.email_from, d.email_date, d.custodian, d.size_bytes,
                (SELECT dr.status FROM document_reviews dr WHERE dr.document_id = d.id
                 ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status
            FROM review_batch_documents rbd
            JOIN documents d ON rbd.document_id = d.id
            WHERE rbd.batch_id = ?
            ORDER BY rbd.position ASC
            LIMIT ? OFFSET ?
        `).all(req.params.id, parseInt(limit), offset);

        for (const doc of documents) {
            doc.review_status = doc.review_status || 'pending';
        }

        res.json({
            batch,
            documents,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        console.error('Batch detail error:', err);
        res.status(500).json({ error: 'Failed to get batch detail' });
    }
});

// PATCH /api/batches/:id/assign — Assign/reassign a user to a batch
router.patch('/:id/assign', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { assignee_id } = req.body;
        const batch = req.invReadDb.prepare('SELECT * FROM review_batches WHERE id = ?').get(req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });

        // Reviewers can only self-assign
        if (req.user.role !== 'admin' && assignee_id !== req.user.id) {
            return res.status(403).json({ error: 'Reviewers can only assign batches to themselves' });
        }

        const newStatus = assignee_id ? 'in_progress' : 'pending';
        req.invDb.prepare(`
            UPDATE review_batches SET assignee_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?
        `).run(assignee_id || null, newStatus, req.params.id);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.BATCH_ASSIGN,
            resourceType: 'batch',
            resourceId: req.params.id,
            details: { assignee_id, previous_assignee: batch.assignee_id },
            ipAddress: req.ip,
        });

        const updated = req.invReadDb.prepare(`
            SELECT rb.*
            FROM review_batches rb
            WHERE rb.id = ?
        `).get(req.params.id);
        // Resolve assignee name from main DB
        if (updated.assignee_id) {
            const assigneeUser = mainReadDb.prepare('SELECT name FROM users WHERE id = ?').get(updated.assignee_id);
            updated.assignee_name = assigneeUser?.name || null;
        } else {
            updated.assignee_name = null;
        }
        try { updated.search_criteria = JSON.parse(updated.search_criteria); } catch { /* */ }

        res.json({ batch: updated });
    } catch (err) {
        console.error('Batch assign error:', err);
        res.status(500).json({ error: 'Failed to assign batch' });
    }
});

// PATCH /api/batches/:id/status — Update batch status
router.patch('/:id/status', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { status } = req.body;
        if (!['pending', 'in_progress', 'completed'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const batch = req.invReadDb.prepare('SELECT * FROM review_batches WHERE id = ?').get(req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });

        // Only assignee or admin can change status
        if (req.user.role !== 'admin' && batch.assignee_id !== req.user.id) {
            return res.status(403).json({ error: 'Only the assignee or admin can change batch status' });
        }

        req.invDb.prepare(`
            UPDATE review_batches SET status = ?, updated_at = datetime('now') WHERE id = ?
        `).run(status, req.params.id);

        res.json({ message: 'Status updated', status });
    } catch (err) {
        console.error('Batch status error:', err);
        res.status(500).json({ error: 'Failed to update batch status' });
    }
});

// GET /api/batches/check-access/:documentId — Check if current user can edit a document
router.get('/check-access/:documentId', (req, res) => {
    try {
        if (req.user.role === 'admin') {
            return res.json({ can_edit: true });
        }
        const assignedBatch = req.invReadDb.prepare(`
            SELECT rb.id FROM review_batch_documents rbd
            JOIN review_batches rb ON rbd.batch_id = rb.id
            WHERE rbd.document_id = ? AND rb.assignee_id = ?
            LIMIT 1
        `).get(req.params.documentId, req.user.id);
        res.json({ can_edit: !!assignedBatch });
    } catch (err) {
        console.error('Batch access check error:', err);
        res.status(500).json({ error: 'Failed to check access' });
    }
});

// DELETE /api/batches/:id — Delete a batch (admin only)
router.delete('/:id', requireRole('admin'), (req, res) => {
    try {
        const batch = req.invReadDb.prepare('SELECT * FROM review_batches WHERE id = ?').get(req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });

        req.invDb.prepare('DELETE FROM review_batches WHERE id = ?').run(req.params.id);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.BATCH_DELETE,
            resourceType: 'batch',
            resourceId: req.params.id,
            details: { batch_number: batch.batch_number, investigation_id: batch.investigation_id },
            ipAddress: req.ip,
        });

        res.json({ message: 'Batch deleted' });
    } catch (err) {
        console.error('Batch delete error:', err);
        res.status(500).json({ error: 'Failed to delete batch' });
    }
});

export default router;
