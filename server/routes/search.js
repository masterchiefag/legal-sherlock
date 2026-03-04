import express from 'express';
import db from '../db.js';

const router = express.Router();

// Full-text search with filters
router.get('/', (req, res) => {
    try {
        const {
            q = '',
            page = 1,
            limit = 20,
            status,
            review_status,
            tags,
            date_from,
            date_to,
            doc_type,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        if (!q.trim()) {
            return res.json({ results: [], query: q, pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
        }

        // Sanitize FTS query — escape special chars and add prefix matching
        const ftsQuery = q
            .replace(/['"]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .map(term => `"${term}"*`)
            .join(' ');

        let filterWhere = '';
        const filterParams = [];

        // Hide attachments from top-level results
        filterWhere += " AND (d.doc_type != 'attachment' OR d.doc_type IS NULL)";

        if (status) {
            filterWhere += ' AND d.status = ?';
            filterParams.push(status);
        }

        if (doc_type) {
            filterWhere += ' AND d.doc_type = ?';
            filterParams.push(doc_type);
        }

        if (review_status) {
            filterWhere += ` AND d.id IN (
        SELECT dr.document_id FROM document_reviews dr
        WHERE dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
        AND dr.status = ?
      )`;
            filterParams.push(review_status);
        }

        if (tags) {
            const tagList = tags.split(',');
            const placeholders = tagList.map(() => '?').join(',');
            filterWhere += ` AND d.id IN (
        SELECT dt.document_id FROM document_tags dt
        JOIN tags t ON dt.tag_id = t.id
        WHERE t.name IN (${placeholders})
      )`;
            filterParams.push(...tagList);
        }

        if (date_from) {
            filterWhere += ' AND d.uploaded_at >= ?';
            filterParams.push(date_from);
        }

        if (date_to) {
            filterWhere += ' AND d.uploaded_at <= ?';
            filterParams.push(date_to);
        }

        // Count total results
        const countRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM documents_fts fts
      JOIN documents d ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ?
      ${filterWhere}
    `).get(ftsQuery, ...filterParams);

        // Get ranked results with snippets
        const results = db.prepare(`
      SELECT
        d.*,
        snippet(documents_fts, 1, '<mark>', '</mark>', '…', 40) as snippet,
        rank,
        (SELECT COUNT(*) FROM documents c WHERE c.parent_id = d.id) as attachment_count,
        (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type = 'email') as thread_count
      FROM documents_fts fts
      JOIN documents d ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ?
      ${filterWhere}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(ftsQuery, ...filterParams, parseInt(limit), offset);

        // Attach tags to results
        const tagStmt = db.prepare(`
      SELECT t.id, t.name, t.color
      FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
      WHERE dt.document_id = ?
    `);

        const reviewStmt = db.prepare(`
      SELECT status FROM document_reviews
      WHERE document_id = ?
      ORDER BY reviewed_at DESC LIMIT 1
    `);

        for (const r of results) {
            r.tags = tagStmt.all(r.id);
            const review = reviewStmt.get(r.id);
            r.review_status = review ? review.status : 'pending';
            // Don't send full text in search results
            delete r.text_content;
        }

        res.json({
            results,
            query: q,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countRow.total,
                pages: Math.ceil(countRow.total / parseInt(limit)),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
