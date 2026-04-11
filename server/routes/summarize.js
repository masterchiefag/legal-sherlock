import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { getProvider } from '../lib/llm-providers.js';
import { LLM_LIMITS } from '../lib/config.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const router = express.Router();

// ═══════════════════════════════════════════════════
// Build document content for summarization (same as classify.js)
// ═══════════════════════════════════════════════════
// Limits are now managed centrally in lib/config.js

function buildDocumentContent(doc, thread, attachments) {
    let content = '';

    if (doc.doc_type === 'email' || doc.doc_type === 'chat') {
        content += `From: ${doc.email_from || '?'} | To: ${doc.email_to || '?'}`;
        if (doc.email_cc) content += ` | CC: ${doc.email_cc}`;
        content += `\nSubject: ${doc.email_subject || 'No subject'} | Date: ${doc.email_date || '?'}\n\n`;
    } else {
        content += `File: ${doc.original_name} (${doc.mime_type || '?'})\n\n`;
    }

    const body = (doc.text_content || '').substring(0, LLM_LIMITS.MAX_BODY_CHARS);
    content += body + '\n';

    if (thread && thread.length > 1) {
        let threadContent = '\nThread:\n';
        let threadLen = 0;
        for (const msg of thread) {
            if (msg.id === doc.id) continue;
            const line = `- ${msg.email_from || '?'}: ${msg.email_subject || '?'}\n`;
            if (threadLen + line.length > LLM_LIMITS.MAX_THREAD_CHARS) break;
            threadContent += line;
            threadLen += line.length;
        }
        content += threadContent;
    }

    if (attachments && attachments.length > 0) {
        let attContent = '\nAttachments:\n';
        let attLen = 0;
        for (const att of attachments) {
            const attDoc = db.prepare('SELECT text_content, original_name FROM documents WHERE id = ?').get(att.id);
            if (attDoc) {
                const line = `- ${attDoc.original_name}: ${(attDoc.text_content || '').substring(0, 200)}\n`;
                if (attLen + line.length > LLM_LIMITS.MAX_ATTACHMENT_CHARS) break;
                attContent += line;
                attLen += line.length;
            }
        }
        content += attContent;
    }

    return content;
}

// ═══════════════════════════════════════════════════
// POST /api/summarize/jobs — Create a new summarization job (reviewer+)
// ═══════════════════════════════════════════════════
router.post('/jobs', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { investigationId, prompt, model, totalDocs } = req.body;
        if (!prompt || prompt.trim().length < 3) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const provider = getProvider();
        const id = uuidv4();

        db.prepare(`
            INSERT INTO summarization_jobs (id, investigation_id, prompt, model, provider, status, total_docs)
            VALUES (?, ?, ?, ?, ?, 'running', ?)
        `).run(id, investigationId || null, prompt.trim(), model || provider.modelName, provider.name, totalDocs || 0);

        const job = db.prepare('SELECT * FROM summarization_jobs WHERE id = ?').get(id);
        res.json(job);
    } catch (err) {
        console.error('Create summarization job error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// PATCH /api/summarize/jobs/:jobId — Update job status (reviewer+)
// ═══════════════════════════════════════════════════
router.patch('/jobs/:jobId', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { status, processedDocs, elapsedSeconds } = req.body;
        const updates = [];
        const params = [];

        if (status) { updates.push('status = ?'); params.push(status); }
        if (processedDocs !== undefined) { updates.push('processed_docs = ?'); params.push(processedDocs); }
        if (elapsedSeconds !== undefined) { updates.push('elapsed_seconds = ?'); params.push(elapsedSeconds); }
        if (status === 'completed' || status === 'failed') {
            updates.push("completed_at = datetime('now')");
        }

        if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });

        params.push(req.params.jobId);
        db.prepare(`UPDATE summarization_jobs SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        const job = db.prepare('SELECT * FROM summarization_jobs WHERE id = ?').get(req.params.jobId);
        res.json(job);
    } catch (err) {
        console.error('Update summarization job error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/summarize/jobs — List jobs for an investigation
// ═══════════════════════════════════════════════════
router.get('/jobs', (req, res) => {
    try {
        const { investigation_id } = req.query;
        let jobs;
        if (investigation_id) {
            jobs = db.prepare(
                'SELECT * FROM summarization_jobs WHERE investigation_id = ? ORDER BY started_at DESC'
            ).all(investigation_id);
        } else {
            jobs = db.prepare(
                'SELECT * FROM summarization_jobs ORDER BY started_at DESC'
            ).all();
        }
        res.json({ jobs });
    } catch (err) {
        console.error('List summarization jobs error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/summarize/jobs/:jobId/results — Paginated results for a job
// ═══════════════════════════════════════════════════
router.get('/jobs/:jobId/results', (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const results = db.prepare(`
            SELECT
                s.id, s.document_id, s.summary, s.elapsed_seconds, s.created_at,
                d.doc_identifier, d.email_date, d.email_from, d.email_to,
                d.email_subject, d.original_name, d.doc_type
            FROM summaries s
            JOIN documents d ON s.document_id = d.id
            WHERE s.job_id = ?
            ORDER BY s.created_at ASC
            LIMIT ? OFFSET ?
        `).all(req.params.jobId, parseInt(limit), offset);

        const countRow = db.prepare('SELECT COUNT(*) as total FROM summaries WHERE job_id = ?').get(req.params.jobId);

        res.json({
            results,
            pagination: {
                total: countRow.total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(countRow.total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('Get summarization results error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// POST /api/summarize/:documentId — Summarize a single document (reviewer+)
// ═══════════════════════════════════════════════════
router.post('/:documentId', requireRole('admin', 'reviewer'), async (req, res) => {
    try {
        const { documentId } = req.params;
        const { prompt, model, jobId } = req.body;

        if (!prompt || prompt.trim().length < 3) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Fetch thread context
        let thread = [];
        if (doc.thread_id) {
            thread = db.prepare(
                "SELECT id, email_from, email_subject, email_date FROM documents WHERE thread_id = ? AND doc_type IN ('email', 'chat') AND investigation_id = ? ORDER BY email_date ASC"
            ).all(doc.thread_id, doc.investigation_id);
        }

        // Fetch attachments
        const attachments = db.prepare('SELECT id, original_name FROM documents WHERE parent_id = ?').all(documentId);

        const systemPrompt = prompt.trim();
        const documentContent = buildDocumentContent(doc, thread, attachments);

        const provider = getProvider();
        const activeModel = model || provider.modelName;

        console.log(`🔍 Summarizing document ${documentId} with ${provider.name}/${activeModel}...`);
        console.log(`   Document Length: ${doc.text_content ? doc.text_content.length : 0} chars`);
        console.log(`   Sent Content Length: ${documentContent.length} chars (Limit: ${LLM_LIMITS.MAX_BODY_CHARS} body)`);

        const startTime = Date.now();
        const result = await provider.summarize(systemPrompt, documentContent, model);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Save to DB
        const summaryId = uuidv4();
        db.prepare(`
            INSERT INTO summaries (id, job_id, document_id, summary, provider, model, elapsed_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(summaryId, jobId || 'standalone', documentId, result.summary, provider.name, activeModel, parseFloat(elapsed));

        // Update job progress if part of a batch
        if (jobId) {
            db.prepare(`
                UPDATE summarization_jobs SET processed_docs = processed_docs + 1 WHERE id = ?
            `).run(jobId);
        }

        res.json({
            id: summaryId,
            document_id: documentId,
            summary: result.summary,
            provider: provider.name,
            model: activeModel,
            elapsed_seconds: parseFloat(elapsed),
        });
    } catch (err) {
        console.error('Summarization error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
