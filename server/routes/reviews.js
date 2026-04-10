import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const router = express.Router();

// Set/update review for a document — reviewer+ only
router.put('/documents/:docId/review', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { status, notes } = req.body;
        if (!status) return res.status(400).json({ error: 'Review status is required' });

        const valid = ['pending', 'relevant', 'not_relevant', 'privileged'];
        if (!valid.includes(status)) {
            return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
        }

        const id = uuidv4();
        db.prepare(`
      INSERT INTO document_reviews (id, document_id, status, notes, reviewer_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.docId, status, notes || null, req.user.id);

        logAudit(db, {
            userId: req.user.id,
            action: ACTIONS.REVIEW_UPDATE,
            resourceType: 'document',
            resourceId: req.params.docId,
            details: { status },
            ipAddress: req.ip,
        });

        const review = db.prepare('SELECT * FROM document_reviews WHERE id = ?').get(id);
        res.json(review);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get review history for a document
router.get('/documents/:docId/review', (req, res) => {
    try {
        const reviews = db.prepare(`
      SELECT * FROM document_reviews
      WHERE document_id = ?
      ORDER BY reviewed_at DESC
    `).all(req.params.docId);
        res.json(reviews);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get stats for dashboard — scoped to user's investigations
router.get('/stats', (req, res) => {
    try {
        let { investigation_id } = req.query;

        // For non-admin without specific investigation, scope to accessible investigations
        let invFilter, invParams;
        if (investigation_id) {
            invFilter = ' AND investigation_id = ?';
            invParams = [investigation_id];
        } else if (req.user.role !== 'admin') {
            invFilter = ' AND investigation_id IN (SELECT investigation_id FROM investigation_members WHERE user_id = ?)';
            invParams = [req.user.id];
        } else {
            invFilter = '';
            invParams = [];
        }
        const invFilterWhere = investigation_id ? ' WHERE investigation_id = ?' : '';

        const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE 1=1${invFilter}`).get(...invParams).count;
        const readyDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE status = 'ready'${invFilter}`).get(...invParams).count;

        const reviewedDocs = db.prepare(`
      SELECT COUNT(DISTINCT dr.document_id) as count
      FROM document_reviews dr
      JOIN documents d ON d.id = dr.document_id
      WHERE dr.status != 'pending'${investigation_id ? ' AND d.investigation_id = ?' : ''}
    `).get(...invParams).count;

        const statusCounts = db.prepare(`
      SELECT dr.status, COUNT(DISTINCT dr.document_id) as count
      FROM document_reviews dr
      JOIN documents d ON d.id = dr.document_id
      WHERE dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
      ${investigation_id ? 'AND d.investigation_id = ?' : ''}
      GROUP BY dr.status
    `).all(...invParams);

        const tagCounts = db.prepare(`
      SELECT t.name, t.color, COUNT(dt.document_id) as count
      FROM tags t
      LEFT JOIN document_tags dt ON dt.tag_id = t.id
      ${investigation_id ? 'LEFT JOIN documents d ON d.id = dt.document_id' : ''}
      ${investigation_id ? 'WHERE (d.investigation_id = ? OR dt.document_id IS NULL)' : ''}
      GROUP BY t.id
      ORDER BY count DESC
    `).all(...invParams);

        // Document type breakdown
        const typeCounts = db.prepare(`
      SELECT doc_type, COUNT(*) as count
      FROM documents WHERE 1=1${invFilter}
      GROUP BY doc_type
    `).all(...invParams);

        // Total size
        const totalSize = db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) as total_size FROM documents WHERE 1=1${invFilter}
    `).get(...invParams).total_size;

        // Duplicates count
        const dupeCount = db.prepare(`
      SELECT COUNT(*) as count FROM documents WHERE is_duplicate = 1${invFilter}
    `).get(...invParams).count;

        // AI classification coverage
        const classifiedCount = db.prepare(`
      SELECT COUNT(DISTINCT c.document_id) as count
      FROM classifications c JOIN documents d ON d.id = c.document_id
      WHERE 1=1${investigation_id ? ' AND d.investigation_id = ?' : ''}
    `).get(...invParams).count;

        // Top senders (top 10)
        const topSenders = db.prepare(`
      SELECT email_from, COUNT(*) as count
      FROM documents WHERE doc_type = 'email' AND email_from IS NOT NULL${invFilter}
      GROUP BY email_from ORDER BY count DESC LIMIT 10
    `).all(...invParams);

        // Import jobs for this investigation
        const importJobs = investigation_id ? db.prepare(`
      SELECT filename as original_name, status, total_emails, total_attachments, custodian, started_at, completed_at
      FROM import_jobs WHERE investigation_id = ?
      ORDER BY rowid DESC
    `).all(investigation_id) : [];

        // Custodian breakdown
        const custodians = investigation_id ? db.prepare(`
      SELECT custodian as name,
        COUNT(*) as document_count,
        SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as email_count,
        SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachment_count,
        SUM(CASE WHEN doc_type = 'chat' THEN 1 ELSE 0 END) as chat_count,
        SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as file_count
      FROM documents WHERE investigation_id = ? AND custodian IS NOT NULL
      GROUP BY custodian ORDER BY document_count DESC
    `).all(investigation_id) : [];

        res.json({
            total_documents: totalDocs,
            ready_documents: readyDocs,
            reviewed_documents: reviewedDocs,
            review_percentage: totalDocs > 0 ? Math.round((reviewedDocs / totalDocs) * 100) : 0,
            status_breakdown: statusCounts,
            tag_breakdown: tagCounts,
            type_breakdown: typeCounts,
            total_size: totalSize,
            duplicate_count: dupeCount,
            classified_count: classifiedCount,
            top_senders: topSenders,
            import_jobs: importJobs,
            custodians: custodians,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
