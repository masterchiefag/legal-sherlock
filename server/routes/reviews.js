import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db, { readDb } from '../db.js';
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

        // Reviewers can only review documents in a batch assigned to them
        if (req.user.role !== 'admin') {
            const assignedBatch = readDb.prepare(`
                SELECT rb.id FROM review_batch_documents rbd
                JOIN review_batches rb ON rbd.batch_id = rb.id
                WHERE rbd.document_id = ? AND rb.assignee_id = ?
                LIMIT 1
            `).get(req.params.docId, req.user.id);
            if (!assignedBatch) {
                return res.status(403).json({ error: 'You can only review documents in batches assigned to you' });
            }
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

        // Unique (non-duplicate) document count
        const uniqueDocCount = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE is_duplicate = 0${invFilter}`).get(...invParams).count;

        // Total attachments & unique attachments
        const totalAttachmentCount = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'attachment'${invFilter}`).get(...invParams).count;
        const uniqueAttachmentCount = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'attachment' AND is_duplicate = 0${invFilter}`).get(...invParams).count;

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

        // Top senders (top 10) — includes emails and chats
        // Split comma-separated email_from (chats have multiple senders per day)
        const rawSenders = db.prepare(`
      SELECT email_from, COUNT(*) as count
      FROM documents WHERE doc_type IN ('email', 'chat') AND email_from IS NOT NULL${invFilter}
      GROUP BY email_from
    `).all(...invParams);
        const senderMap = new Map();
        for (const row of rawSenders) {
            const senders = (row.email_from || '').split(/,(?=\s)/).map(s => s.trim()).filter(Boolean);
            for (const sender of senders) {
                senderMap.set(sender, (senderMap.get(sender) || 0) + row.count);
            }
        }
        const topSenders = [...senderMap.entries()]
            .map(([email_from, count]) => ({ email_from, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        // Import jobs for this investigation
        const importJobs = investigation_id ? db.prepare(`
      SELECT filename as original_name, status, total_emails, total_attachments, custodian, started_at, completed_at,
             ocr_count, ocr_success, ocr_failed, ocr_time_ms
      FROM import_jobs WHERE investigation_id = ?
      ORDER BY rowid DESC
    `).all(investigation_id) : [];

        // Attachment file extension breakdown (with unique counts)
        const rawAttachments = db.prepare(`
      SELECT original_name, is_duplicate FROM documents WHERE doc_type = 'attachment'${invFilter}
    `).all(...invParams);
        const extCountsTotal = {};
        const extCountsUnique = {};
        for (const row of rawAttachments) {
            const name = row.original_name || '';
            const lastDot = name.lastIndexOf('.');
            const ext = lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
            extCountsTotal[ext] = (extCountsTotal[ext] || 0) + 1;
            if (!row.is_duplicate) {
                extCountsUnique[ext] = (extCountsUnique[ext] || 0) + 1;
            }
        }
        const attachmentTypesCorrected = Object.entries(extCountsTotal)
            .map(([ext, count]) => ({ ext, count, unique_count: extCountsUnique[ext] || 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);

        // OCR stats for this investigation
        const ocrStats = db.prepare(`
      SELECT COUNT(*) as ocr_doc_count
      FROM documents WHERE ocr_applied = 1${invFilter}
    `).get(...invParams);

        // Custodian breakdown (comprehensive)
        const custodians = investigation_id ? db.prepare(`
      SELECT custodian as name,
        COUNT(*) as document_count,
        SUM(CASE WHEN is_duplicate = 0 THEN 1 ELSE 0 END) as unique_count,
        SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as email_count,
        SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachment_count,
        SUM(CASE WHEN doc_type = 'attachment' AND is_duplicate = 0 THEN 1 ELSE 0 END) as unique_attachment_count,
        SUM(CASE WHEN doc_type = 'chat' THEN 1 ELSE 0 END) as chat_count,
        SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as file_count,
        SUM(CASE WHEN is_duplicate = 1 THEN 1 ELSE 0 END) as duplicate_count,
        COALESCE(SUM(size_bytes), 0) as total_size
      FROM documents WHERE investigation_id = ? AND custodian IS NOT NULL
      GROUP BY custodian ORDER BY document_count DESC
    `).all(investigation_id) : [];

        // Per-custodian review and classification counts
        if (investigation_id && custodians.length > 0) {
            const reviewStmt = db.prepare(`
          SELECT COUNT(DISTINCT dr.document_id) as count
          FROM document_reviews dr JOIN documents d ON d.id = dr.document_id
          WHERE dr.status != 'pending' AND d.investigation_id = ? AND d.custodian = ?
        `);
            const classifyStmt = db.prepare(`
          SELECT COUNT(DISTINCT c.document_id) as count
          FROM classifications c JOIN documents d ON d.id = c.document_id
          WHERE d.investigation_id = ? AND d.custodian = ?
        `);
            for (const c of custodians) {
                c.reviewed_count = reviewStmt.get(investigation_id, c.name).count;
                c.classified_count = classifyStmt.get(investigation_id, c.name).count;
            }
        }

        // Top communication pairs (email + chat)
        const rawPairs = db.prepare(`
      SELECT email_from, email_to, COUNT(*) as count
      FROM documents WHERE doc_type IN ('email', 'chat')
        AND email_from IS NOT NULL AND email_to IS NOT NULL${invFilter}
      GROUP BY email_from, email_to
    `).all(...invParams);
        const pairMap = new Map();
        for (const row of rawPairs) {
            const senders = (row.email_from || '').split(/,(?=\s)/).map(s => s.trim()).filter(Boolean);
            const recipients = (row.email_to || '').split(/,(?=\s)/).map(r => r.trim()).filter(Boolean);
            for (const sender of senders) {
                for (const receiver of recipients) {
                    if (sender === receiver) continue; // skip self-pairs
                    // Normalize pair direction so A→B and B→A merge
                    const pair = [sender, receiver].sort();
                    const key = `${pair[0]}|||${pair[1]}`;
                    pairMap.set(key, (pairMap.get(key) || 0) + row.count);
                }
            }
        }
        const topCommunicationPairs = [...pairMap.entries()]
            .map(([key, count]) => {
                const [sender, receiver] = key.split('|||');
                return { sender, receiver, count };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);

        // Data time range
        const dateRangeRow = db.prepare(`
      SELECT MIN(email_date) as earliest, MAX(email_date) as latest
      FROM documents WHERE email_date IS NOT NULL${invFilter}
    `).get(...invParams);
        let dateRange = null;
        if (dateRangeRow && dateRangeRow.earliest && dateRangeRow.latest) {
            const earliest = new Date(dateRangeRow.earliest);
            const latest = new Date(dateRangeRow.latest);
            const rangeDays = Math.round((latest - earliest) / 86400000);
            dateRange = { earliest: dateRangeRow.earliest, latest: dateRangeRow.latest, range_days: rangeDays };
        }

        // Volume by month
        const volumeByMonth = db.prepare(`
      SELECT STRFTIME('%Y-%m', email_date) as month, COUNT(*) as count
      FROM documents WHERE email_date IS NOT NULL${invFilter}
      GROUP BY month ORDER BY month
    `).all(...invParams);

        // AI score distribution (latest classification per doc)
        const scoreDistribution = db.prepare(`
      SELECT c.score, COUNT(*) as count FROM classifications c
      JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (SELECT MAX(id) FROM classifications GROUP BY document_id)
      ${investigation_id ? 'AND d.investigation_id = ?' : ''}
      GROUP BY c.score ORDER BY c.score
    `).all(...invParams);

        // Activity heatmap (day-of-week × hour)
        const activityHeatmap = db.prepare(`
      SELECT CAST(STRFTIME('%w', email_date) AS INTEGER) as day_of_week,
             CAST(STRFTIME('%H', email_date) AS INTEGER) as hour,
             COUNT(*) as count
      FROM documents WHERE email_date IS NOT NULL AND doc_type IN ('email', 'chat')${invFilter}
      GROUP BY day_of_week, hour
    `).all(...invParams);

        // Thread depth distribution
        const threadDepth = db.prepare(`
      SELECT thread_size as depth, COUNT(*) as count FROM (
        SELECT thread_id, COUNT(*) as thread_size FROM documents
        WHERE thread_id IS NOT NULL AND doc_type = 'email'${invFilter}
        GROUP BY thread_id
      ) GROUP BY thread_size ORDER BY thread_size
    `).all(...invParams);

        // Size distribution by doc type
        const sizeByDocType = db.prepare(`
      SELECT doc_type, COUNT(*) as count,
        COALESCE(SUM(size_bytes), 0) as total_size,
        COALESCE(AVG(size_bytes), 0) as avg_size,
        COALESCE(MAX(size_bytes), 0) as max_size
      FROM documents WHERE 1=1${invFilter}
      GROUP BY doc_type
    `).all(...invParams);

        res.json({
            total_documents: totalDocs,
            ready_documents: readyDocs,
            reviewed_documents: reviewedDocs,
            unique_document_count: uniqueDocCount,
            total_attachment_count: totalAttachmentCount,
            unique_attachment_count: uniqueAttachmentCount,
            review_percentage: totalDocs > 0 ? Math.round((reviewedDocs / totalDocs) * 100) : 0,
            status_breakdown: statusCounts,
            tag_breakdown: tagCounts,
            type_breakdown: typeCounts,
            total_size: totalSize,
            duplicate_count: dupeCount,
            classified_count: classifiedCount,
            top_senders: topSenders,
            top_communication_pairs: topCommunicationPairs,
            import_jobs: importJobs,
            custodians: custodians,
            attachment_types: attachmentTypesCorrected,
            ocr_doc_count: ocrStats?.ocr_doc_count || 0,
            date_range: dateRange,
            volume_by_month: volumeByMonth,
            score_distribution: scoreDistribution,
            activity_heatmap: activityHeatmap,
            thread_depth: threadDepth,
            size_by_doc_type: sizeByDocType,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
