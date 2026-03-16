import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

const router = express.Router();

// Set/update review for a document
router.put('/documents/:docId/review', (req, res) => {
    try {
        const { status, notes } = req.body;
        if (!status) return res.status(400).json({ error: 'Review status is required' });

        const valid = ['pending', 'relevant', 'not_relevant', 'privileged'];
        if (!valid.includes(status)) {
            return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
        }

        const id = uuidv4();
        db.prepare(`
      INSERT INTO document_reviews (id, document_id, status, notes)
      VALUES (?, ?, ?, ?)
    `).run(id, req.params.docId, status, notes || null);

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

// Get stats for dashboard
router.get('/stats', (req, res) => {
    try {
        const totalDocs = db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
        const readyDocs = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status = 'ready'").get().count;

        const reviewedDocs = db.prepare(`
      SELECT COUNT(DISTINCT document_id) as count
      FROM document_reviews WHERE status != 'pending'
    `).get().count;

        const statusCounts = db.prepare(`
      SELECT dr.status, COUNT(DISTINCT dr.document_id) as count
      FROM document_reviews dr
      WHERE dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
      GROUP BY dr.status
    `).all();

        const tagCounts = db.prepare(`
      SELECT t.name, t.color, COUNT(dt.document_id) as count
      FROM tags t
      LEFT JOIN document_tags dt ON dt.tag_id = t.id
      GROUP BY t.id
      ORDER BY count DESC
    `).all();

        const recentUploads = db.prepare(`
      SELECT id, original_name, size_bytes, uploaded_at, status
      FROM documents
      ORDER BY uploaded_at DESC
      LIMIT 5
    `).all();

        res.json({
            total_documents: totalDocs,
            ready_documents: readyDocs,
            reviewed_documents: reviewedDocs,
            review_percentage: totalDocs > 0 ? Math.round((reviewedDocs / totalDocs) * 100) : 0,
            status_breakdown: statusCounts,
            tag_breakdown: tagCounts,
            recent_uploads: recentUploads,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
