import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import mainDb from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const router = express.Router();

// Set/update review for a document — reviewer+ only
router.put('/documents/:docId/review', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { status, notes } = req.body;
        if (!status) return res.status(400).json({ error: 'Review status is required' });

        const valid = ['pending', 'relevant', 'not_relevant', 'technical_issue'];
        if (!valid.includes(status)) {
            return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
        }

        // Reviewers can only review documents in a batch assigned to them
        if (req.user.role !== 'admin') {
            const assignedBatch = req.invReadDb.prepare(`
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
        req.invDb.prepare(`
      INSERT INTO document_reviews (id, document_id, status, notes, reviewer_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.docId, status, notes || null, req.user.id);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.REVIEW_UPDATE,
            resourceType: 'document',
            resourceId: req.params.docId,
            details: { status },
            ipAddress: req.ip,
        });

        const review = req.invDb.prepare('SELECT * FROM document_reviews WHERE id = ?').get(id);
        res.json(review);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get review history for a document
router.get('/documents/:docId/review', (req, res) => {
    try {
        const reviews = req.invReadDb.prepare(`
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

// In-memory cache for dashboard stats (30s TTL)
const statsCache = new Map();
const STATS_CACHE_TTL = 30_000;

// Get stats for dashboard — scoped to user's investigations
router.get('/stats', (req, res) => {
    try {
        let { investigation_id } = req.query;

        if (!req.invReadDb) {
            return res.status(400).json({ error: 'investigation_id is required' });
        }

        // Non-admin must be a member of this investigation (investigation_members is main DB)
        if (req.user.role !== 'admin') {
            const membership = mainDb.prepare(
                'SELECT 1 FROM investigation_members WHERE user_id = ? AND investigation_id = ?'
            ).get(req.user.id, investigation_id);
            if (!membership) {
                return res.status(403).json({ error: 'Not a member of this investigation' });
            }
        }

        // Check cache
        const cacheKey = investigation_id || 'all';
        const cached = statsCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < STATS_CACHE_TTL) {
            console.log(`[stats] cache hit for ${cacheKey}`);
            return res.json(cached.data);
        }

        const t0 = Date.now();
        const invReadDb = req.invReadDb;

        // All docs in the per-investigation DB belong to this investigation — no invFilter needed
        // Run all queries inside a single read transaction for consistent snapshot + reduced lock overhead
        const computeStats = invReadDb.transaction(() => {
            // Single consolidated counts query (replaces 8 separate queries)
            const counts = invReadDb.prepare(`
                SELECT COUNT(*) as total_docs,
                    COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) as ready_docs,
                    COALESCE(SUM(CASE WHEN is_duplicate = 0 THEN 1 ELSE 0 END), 0) as unique_doc_count,
                    COALESCE(SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END), 0) as total_attachment_count,
                    COALESCE(SUM(CASE WHEN doc_type = 'attachment' AND is_duplicate = 0 THEN 1 ELSE 0 END), 0) as unique_attachment_count,
                    COALESCE(SUM(size_bytes), 0) as total_size,
                    COALESCE(SUM(CASE WHEN is_duplicate = 1 THEN 1 ELSE 0 END), 0) as dupe_count,
                    COALESCE(SUM(CASE WHEN ocr_applied = 1 THEN 1 ELSE 0 END), 0) as ocr_doc_count
                FROM documents
            `).get();
            const tCounts = Date.now();

            const reviewedDocs = invReadDb.prepare(`
                SELECT COUNT(DISTINCT dr.document_id) as count
                FROM document_reviews dr
                WHERE dr.status != 'pending'
            `).get().count;

            const statusCounts = invReadDb.prepare(`
                SELECT dr.status, COUNT(DISTINCT dr.document_id) as count
                FROM document_reviews dr
                WHERE dr.id IN (SELECT MAX(id) FROM document_reviews GROUP BY document_id)
                GROUP BY dr.status
            `).all();

            // Tags: document_tags is in investigation DB with denormalized tag_name/tag_color
            const tagCounts = invReadDb.prepare(`
                SELECT dt.tag_name as name, dt.tag_color as color, COUNT(dt.document_id) as count
                FROM document_tags dt
                GROUP BY dt.tag_name, dt.tag_color
                ORDER BY count DESC
            `).all();

            // Merged type breakdown + size by doc type (single query)
            const typeAndSize = invReadDb.prepare(`
                SELECT doc_type, COUNT(*) as count,
                    COALESCE(SUM(size_bytes), 0) as total_size,
                    COALESCE(AVG(size_bytes), 0) as avg_size,
                    COALESCE(MAX(size_bytes), 0) as max_size
                FROM documents
                GROUP BY doc_type
            `).all();
            const typeCounts = typeAndSize.map(r => ({ doc_type: r.doc_type, count: r.count }));
            const sizeByDocType = typeAndSize;

            // AI classification coverage
            const classifiedCount = invReadDb.prepare(`
                SELECT COUNT(DISTINCT c.document_id) as count
                FROM classifications c
            `).get().count;
            const tReviews = Date.now();

            // Top senders (top 10) — split comma-separated email_from for chats
            const rawSenders = invReadDb.prepare(`
                SELECT email_from, COUNT(*) as count
                FROM documents WHERE doc_type IN ('email', 'chat') AND email_from IS NOT NULL
                GROUP BY email_from
                ORDER BY count DESC LIMIT 100
            `).all();
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
            const importJobs = invReadDb.prepare(`
                SELECT filename as original_name, status, total_emails, total_attachments, custodian, started_at, completed_at,
                       ocr_count, ocr_success, ocr_failed, ocr_time_ms
                FROM import_jobs
                ORDER BY rowid DESC
            `).all();

            // File extension breakdown via SQL (replaces 100K+ row fetch into JS)
            const attachmentTypes = invReadDb.prepare(`
                SELECT file_ext(original_name) as ext, COUNT(*) as count,
                    SUM(CASE WHEN is_duplicate = 0 THEN 1 ELSE 0 END) as unique_count
                FROM documents WHERE doc_type IN ('attachment', 'file')
                GROUP BY ext ORDER BY count DESC LIMIT 20
            `).all();
            const tExtensions = Date.now();

            // Custodian breakdown
            const custodians = invReadDb.prepare(`
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
                FROM documents WHERE custodian IS NOT NULL
                GROUP BY custodian ORDER BY document_count DESC
            `).all();

            // Batch custodian review/classify counts (replaces N+1 loop)
            if (custodians.length > 0) {
                const reviewedByCustodian = invReadDb.prepare(`
                    SELECT d.custodian, COUNT(DISTINCT dr.document_id) as count
                    FROM document_reviews dr JOIN documents d ON d.id = dr.document_id
                    WHERE dr.status != 'pending'
                    GROUP BY d.custodian
                `).all();
                const classifiedByCustodian = invReadDb.prepare(`
                    SELECT d.custodian, COUNT(DISTINCT c.document_id) as count
                    FROM classifications c JOIN documents d ON d.id = c.document_id
                    GROUP BY d.custodian
                `).all();
                const reviewMap = new Map(reviewedByCustodian.map(r => [r.custodian, r.count]));
                const classifyMap = new Map(classifiedByCustodian.map(r => [r.custodian, r.count]));
                for (const c of custodians) {
                    c.reviewed_count = reviewMap.get(c.name) || 0;
                    c.classified_count = classifyMap.get(c.name) || 0;
                }
            }
            const tCustodians = Date.now();

            // Communication pairs with LIMIT (reduces JS processing from thousands to 200 rows)
            const rawPairs = invReadDb.prepare(`
                SELECT email_from, email_to, COUNT(*) as count
                FROM documents WHERE doc_type IN ('email', 'chat')
                    AND email_from IS NOT NULL AND email_to IS NOT NULL
                GROUP BY email_from, email_to
                HAVING COUNT(*) >= 2
                ORDER BY count DESC LIMIT 200
            `).all();
            const pairMap = new Map();
            for (const row of rawPairs) {
                const senders = (row.email_from || '').split(/,(?=\s)/).map(s => s.trim()).filter(Boolean);
                const recipients = (row.email_to || '').split(/,(?=\s)/).map(r => r.trim()).filter(Boolean);
                for (const sender of senders) {
                    for (const receiver of recipients) {
                        if (sender === receiver) continue;
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

            // Date range
            const dateRangeRow = invReadDb.prepare(`
                SELECT MIN(email_date) as earliest, MAX(email_date) as latest
                FROM documents WHERE email_date IS NOT NULL
            `).get();
            let dateRange = null;
            if (dateRangeRow && dateRangeRow.earliest && dateRangeRow.latest) {
                const earliest = new Date(dateRangeRow.earliest);
                const latest = new Date(dateRangeRow.latest);
                const rangeDays = Math.round((latest - earliest) / 86400000);
                dateRange = { earliest: dateRangeRow.earliest, latest: dateRangeRow.latest, range_days: rangeDays };
            }

            // Volume by month
            const volumeByMonth = invReadDb.prepare(`
                SELECT STRFTIME('%Y-%m', email_date) as month, COUNT(*) as count
                FROM documents WHERE email_date IS NOT NULL
                GROUP BY month ORDER BY month
            `).all();

            // AI score distribution
            const scoreDistribution = invReadDb.prepare(`
                SELECT c.score, COUNT(*) as count FROM classifications c
                WHERE c.id IN (SELECT MAX(id) FROM classifications GROUP BY document_id)
                GROUP BY c.score ORDER BY c.score
            `).all();

            // Activity heatmap (day-of-week x hour)
            const activityHeatmap = invReadDb.prepare(`
                SELECT CAST(STRFTIME('%w', email_date) AS INTEGER) as day_of_week,
                       CAST(STRFTIME('%H', email_date) AS INTEGER) as hour,
                       COUNT(*) as count
                FROM documents WHERE email_date IS NOT NULL AND doc_type IN ('email', 'chat')
                GROUP BY day_of_week, hour
            `).all();

            // Thread depth distribution
            const threadDepth = invReadDb.prepare(`
                SELECT thread_size as depth, COUNT(*) as count FROM (
                    SELECT thread_id, COUNT(*) as thread_size FROM documents
                    WHERE thread_id IS NOT NULL AND doc_type = 'email'
                    GROUP BY thread_id
                ) GROUP BY thread_size ORDER BY thread_size
            `).all();

            console.log(`[stats] counts: ${tCounts - t0}ms, reviews: ${tReviews - tCounts}ms, extensions: ${tExtensions - tReviews}ms, custodians: ${tCustodians - tExtensions}ms, total: ${Date.now() - t0}ms`);

            return {
                total_documents: counts.total_docs,
                ready_documents: counts.ready_docs,
                reviewed_documents: reviewedDocs,
                unique_document_count: counts.unique_doc_count,
                total_attachment_count: counts.total_attachment_count,
                unique_attachment_count: counts.unique_attachment_count,
                review_percentage: counts.total_docs > 0 ? Math.round((reviewedDocs / counts.total_docs) * 100) : 0,
                status_breakdown: statusCounts,
                tag_breakdown: tagCounts,
                type_breakdown: typeCounts,
                total_size: counts.total_size,
                duplicate_count: counts.dupe_count,
                classified_count: classifiedCount,
                top_senders: topSenders,
                top_communication_pairs: topCommunicationPairs,
                import_jobs: importJobs,
                custodians: custodians,
                attachment_types: attachmentTypes,
                ocr_doc_count: counts.ocr_doc_count || 0,
                date_range: dateRange,
                volume_by_month: volumeByMonth,
                score_distribution: scoreDistribution,
                activity_heatmap: activityHeatmap,
                thread_depth: threadDepth,
                size_by_doc_type: sizeByDocType,
            };
        });

        const data = computeStats();

        // Cache the result
        statsCache.set(cacheKey, { data, ts: Date.now() });
        if (statsCache.size > 50) {
            const oldest = [...statsCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
            statsCache.delete(oldest[0]);
        }

        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
