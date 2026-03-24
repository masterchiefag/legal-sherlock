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
            score_min,
            score_max,
            hide_duplicates,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Parse FTS5 query: support "exact phrase", OR, and -exclude
        const parseQuery = (raw) => {
            const tokens = raw.match(/("[^"]+"|-[^\s]+|\bOR\b|[^\s]+)/g) || [];
            const processed = [];
            for (const token of tokens) {
                if (token.toUpperCase() === 'OR') {
                    processed.push('OR');
                } else if (token.startsWith('"') && token.endsWith('"') && token.length > 2) {
                    processed.push(token);
                } else if (token.startsWith('-')) {
                    const val = token.substring(1).replace(/['"]/g, '');
                    if (val) processed.push(`NOT "${val}"*`);
                } else {
                    const val = token.replace(/['"]/g, '');
                    if (val) processed.push(`"${val}"*`);
                }
            }
            return processed.join(' ');
        };

        const hasQuery = q.trim().length > 0;
        const ftsQuery = hasQuery ? parseQuery(q) : '';
        const useFts = hasQuery && ftsQuery.trim() && ftsQuery.trim() !== 'OR';

        // Build shared filter clauses
        let filterWhere = '';
        const filterParams = [];

        // Hide attachments from top-level results unless explicitly filtering for them
        if (doc_type !== 'attachment') {
            filterWhere += " AND (d.doc_type != 'attachment' OR d.doc_type IS NULL)";
        }

        // Deduplication filter
        if (hide_duplicates === '1') {
            filterWhere += ' AND (d.is_duplicate = 0 OR d.is_duplicate IS NULL)';
        }

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
            filterWhere += ' AND COALESCE(d.email_date, d.uploaded_at) >= ?';
            filterParams.push(date_from);
        }

        if (date_to) {
            filterWhere += ' AND COALESCE(d.email_date, d.uploaded_at) <= ?';
            filterParams.push(date_to + 'T23:59:59');
        }

        if (score_min) {
            if (score_min === 'unscored') {
                filterWhere += ' AND d.id NOT IN (SELECT document_id FROM classifications)';
            } else {
                filterWhere += ' AND d.id IN (SELECT c2.document_id FROM classifications c2 WHERE c2.id IN (SELECT MAX(id) FROM classifications GROUP BY document_id) AND c2.score >= ?)';
                filterParams.push(parseInt(score_min));
            }
        }

        if (score_max) {
            filterWhere += ' AND d.id IN (SELECT c2.document_id FROM classifications c2 WHERE c2.id IN (SELECT MAX(id) FROM classifications GROUP BY document_id) AND c2.score <= ?)';
            filterParams.push(parseInt(score_max));
        }

        let countRow, results;

        if (useFts) {
            // FTS search with filters
            countRow = db.prepare(`
          SELECT COUNT(*) as total
          FROM documents_fts fts
          JOIN documents d ON d.rowid = fts.rowid
          WHERE documents_fts MATCH ?
          ${filterWhere}
        `).get(ftsQuery, ...filterParams);

            results = db.prepare(`
          SELECT
            d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
            d.doc_type, d.thread_id, d.parent_id,
            d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
            snippet(documents_fts, 1, '<mark>', '</mark>', '…', 40) as snippet,
            rank,
            (SELECT COUNT(*) FROM documents c WHERE c.parent_id = d.id) as attachment_count,
            (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type = 'email') as thread_count,
            (SELECT cl.score FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_score,
            (SELECT cl.reasoning FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_reasoning,
            (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
             FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
             WHERE dt.document_id = d.id) as tags_json,
            (SELECT dr.status FROM document_reviews dr
             WHERE dr.document_id = d.id
             ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status
          FROM documents_fts fts
          JOIN documents d ON d.rowid = fts.rowid
          WHERE documents_fts MATCH ?
          ${filterWhere}
          ORDER BY rank
          LIMIT ? OFFSET ?
        `).all(ftsQuery, ...filterParams, parseInt(limit), offset);
        } else {
            // Filter-only (no search query)
            countRow = db.prepare(`
          SELECT COUNT(*) as total
          FROM documents d
          WHERE 1=1 ${filterWhere}
        `).get(...filterParams);

            results = db.prepare(`
          SELECT
            d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
            d.doc_type, d.thread_id, d.parent_id,
            d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
            NULL as snippet,
            (SELECT COUNT(*) FROM documents c WHERE c.parent_id = d.id) as attachment_count,
            (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type = 'email') as thread_count,
            (SELECT cl.score FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_score,
            (SELECT cl.reasoning FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_reasoning,
            (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
             FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
             WHERE dt.document_id = d.id) as tags_json,
            (SELECT dr.status FROM document_reviews dr
             WHERE dr.document_id = d.id
             ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status
          FROM documents d
          WHERE 1=1 ${filterWhere}
          ORDER BY COALESCE(d.email_date, d.uploaded_at) DESC
          LIMIT ? OFFSET ?
        `).all(...filterParams, parseInt(limit), offset);
        }

        for (const r of results) {
            r.tags = JSON.parse(r.tags_json || '[]').filter(t => t.id !== null);
            delete r.tags_json;
            r.review_status = r.review_status || 'pending';
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
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
