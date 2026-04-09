import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { getProvider, listProviders } from '../lib/llm-providers.js';
import { LLM_LIMITS } from '../lib/config.js';

const router = express.Router();

// ═══════════════════════════════════════════════════
// Build the classification prompt
// ═══════════════════════════════════════════════════
function buildSystemPrompt(investigationPrompt) {
    return `eDiscovery document reviewer. Score 1-5 for relevance to: ${investigationPrompt}

5=direct evidence, 4=strong circumstantial, 3=ambiguous mention, 2=unlikely relevant, 1=not relevant.
Respond ONLY with JSON: {"score": <1-5>, "reasoning": "<1 sentence>"}`;
}

// Target ~2500 chars of content to stay well within 4096 token context
// Limits are now managed centrally in lib/config.js

function buildDocumentContent(doc, thread, attachments) {
    let content = '';

    // Email metadata (compact)
    if (doc.doc_type === 'email') {
        content += `From: ${doc.email_from || '?'} | To: ${doc.email_to || '?'}`;
        if (doc.email_cc) content += ` | CC: ${doc.email_cc}`;
        content += `\nSubject: ${doc.email_subject || 'No subject'} | Date: ${doc.email_date || '?'}\n\n`;
    } else {
        content += `File: ${doc.original_name} (${doc.mime_type || '?'})\n\n`;
    }

    // Main body — aggressively trimmed
    const body = (doc.text_content || '').substring(0, LLM_LIMITS.MAX_BODY_CHARS);
    content += body + '\n';

    // Thread context — just subjects and senders, minimal body
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

    // Attachment content — just names and first snippet
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
// POST /api/classify/:documentId — Classify a document
// ═══════════════════════════════════════════════════
router.post('/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;
        const { investigationPrompt, model } = req.body;

        if (!investigationPrompt || investigationPrompt.trim().length < 5) {
            return res.status(400).json({ error: 'Investigation prompt must be at least 5 characters.' });
        }

        // Fetch document
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Fetch thread context
        let thread = [];
        if (doc.thread_id) {
            thread = db.prepare(
                "SELECT id, email_from, email_subject, email_date FROM documents WHERE thread_id = ? AND doc_type = 'email' AND investigation_id = ? ORDER BY email_date ASC"
            ).all(doc.thread_id, doc.investigation_id);
        }

        // Fetch attachments
        const attachments = db.prepare('SELECT id, original_name FROM documents WHERE parent_id = ?').all(documentId);

        // Build prompts
        const systemPrompt = buildSystemPrompt(investigationPrompt.trim());
        const documentContent = buildDocumentContent(doc, thread, attachments);

        // Call LLM
        const provider = getProvider();
        const activeModel = model || provider.modelName;
        console.log(`🔍 Classifying document ${documentId} with ${provider.name}/${activeModel}...`);
        console.log(`   Document Length: ${doc.text_content ? doc.text_content.length : 0} chars`);
        console.log(`   Sent Content Length: ${documentContent.length} chars (Limit: ${LLM_LIMITS.MAX_BODY_CHARS} body)`);

        const startTime = Date.now();
        const result = await provider.classify(systemPrompt, documentContent, model);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`✦ Classification complete in ${elapsed}s — Score: ${result.score}/5`);

        // Save to DB
        const classificationId = uuidv4();
        db.prepare(`
      INSERT INTO classifications (id, document_id, investigation_prompt, score, reasoning, provider, model, elapsed_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(classificationId, documentId, investigationPrompt.trim(), result.score, result.reasoning, provider.name, activeModel, parseFloat(elapsed));

        res.json({
            id: classificationId,
            document_id: documentId,
            score: result.score,
            reasoning: result.reasoning,
            provider: provider.name,
            model: activeModel,
            elapsed_seconds: parseFloat(elapsed),
            classified_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Classification error:', err.message);
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/classify/logs — Get full classification history
// ═══════════════════════════════════════════════════
router.get('/logs', (req, res) => {
    try {
        const { limit = 100, page = 1 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const logs = db.prepare(`
            SELECT 
                c.id, c.document_id, c.investigation_prompt, c.score, c.reasoning, c.model, c.classified_at, c.elapsed_seconds,
                d.original_name, d.email_subject, d.doc_type
            FROM classifications c
            JOIN documents d ON c.document_id = d.id
            ORDER BY c.classified_at DESC
            LIMIT ? OFFSET ?
        `).all(parseInt(limit), offset);

        const countRow = db.prepare('SELECT COUNT(*) as total FROM classifications').get();

        res.json({
            logs,
            pagination: {
                total: countRow.total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(countRow.total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/classify/compare/prompts — Prompts with multi-model runs
// ═══════════════════════════════════════════════════
router.get('/compare/prompts', (req, res) => {
    try {
        const prompts = db.prepare(`
            SELECT investigation_prompt, COUNT(DISTINCT model) as model_count, COUNT(*) as total_runs
            FROM classifications
            GROUP BY investigation_prompt
            HAVING COUNT(DISTINCT model) >= 2
            ORDER BY MAX(classified_at) DESC
        `).all();
        res.json({ prompts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/classify/compare — Compare models side-by-side
// ═══════════════════════════════════════════════════
router.get('/compare', (req, res) => {
    try {
        const { prompt } = req.query;
        if (!prompt) return res.status(400).json({ error: 'prompt query parameter required' });

        // Get all classifications for this prompt
        const rows = db.prepare(`
            SELECT c.document_id, c.score, c.reasoning, c.model, c.elapsed_seconds,
                   d.original_name, d.email_subject, d.doc_type
            FROM classifications c
            JOIN documents d ON c.document_id = d.id
            WHERE c.investigation_prompt = ?
            ORDER BY c.classified_at DESC
        `).all(prompt);

        // Group by document, keeping only the latest per model
        const byDoc = {};
        const modelStats = {};
        for (const row of rows) {
            if (!byDoc[row.document_id]) {
                byDoc[row.document_id] = {
                    document_id: row.document_id,
                    original_name: row.original_name,
                    email_subject: row.email_subject,
                    doc_type: row.doc_type,
                    scores: {}
                };
            }
            // Keep first (latest) per model per doc
            if (!byDoc[row.document_id].scores[row.model]) {
                byDoc[row.document_id].scores[row.model] = {
                    score: row.score,
                    reasoning: row.reasoning,
                    elapsed: row.elapsed_seconds
                };
            }
            // Accumulate model stats
            if (!modelStats[row.model]) {
                modelStats[row.model] = { count: 0, total_time: 0, total_score: 0, scores: {} };
            }
        }

        // Build comparisons: only docs classified by 2+ models
        const models = {};
        const comparisons = [];
        for (const doc of Object.values(byDoc)) {
            const docModels = Object.keys(doc.scores);
            if (docModels.length < 2) continue;

            // Check if scores agree
            const scoreValues = docModels.map(m => doc.scores[m].score);
            doc.disagree = new Set(scoreValues).size > 1;
            doc.score_diff = Math.max(...scoreValues) - Math.min(...scoreValues);
            comparisons.push(doc);

            // Accumulate per-model stats (only for compared docs)
            for (const m of docModels) {
                if (!models[m]) {
                    models[m] = { count: 0, total_time: 0, total_score: 0, score_distribution: {} };
                }
                models[m].count++;
                models[m].total_time += doc.scores[m].elapsed || 0;
                models[m].total_score += doc.scores[m].score;
                const s = String(doc.scores[m].score);
                models[m].score_distribution[s] = (models[m].score_distribution[s] || 0) + 1;
            }
        }

        // Compute averages
        for (const m of Object.keys(models)) {
            models[m].avg_time = models[m].count ? +(models[m].total_time / models[m].count).toFixed(2) : 0;
            models[m].avg_score = models[m].count ? +(models[m].total_score / models[m].count).toFixed(2) : 0;
            delete models[m].total_time;
            delete models[m].total_score;
        }

        // Sort: biggest disagreements first
        comparisons.sort((a, b) => b.score_diff - a.score_diff);

        const agree = comparisons.filter(c => !c.disagree).length;
        const agreement_rate = comparisons.length ? +(agree / comparisons.length).toFixed(3) : 0;

        res.json({ models, comparisons, agreement_rate, total: comparisons.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/classify/models — List available local models
// ═══════════════════════════════════════════════════
router.get('/models', async (req, res) => {
    try {
        const provider = getProvider();
        if (provider.name !== 'ollama') {
            return res.json({ models: [provider.modelName], active_model: provider.modelName });
        }

        const baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        const response = await fetch(`${baseUrl}/api/tags`);
        if (!response.ok) throw new Error('Failed to fetch Ollama models');

        const data = await response.json();
        const models = data.models?.map(m => m.name) || [];
        res.json({ models, active_model: provider.modelName });
    } catch (err) {
        console.error('Failed to fetch models:', err.message);
        const isConnectionError = err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed');
        res.json({
            models: [],
            active_model: null,
            error: isConnectionError
                ? 'Ollama is not running. Start it with: ollama serve'
                : `Failed to fetch models: ${err.message}`
        });
    }
});

// ═══════════════════════════════════════════════════
// GET /api/classify/:documentId — Get classifications for a document
// ═══════════════════════════════════════════════════
router.get('/:documentId', (req, res) => {
    try {
        const classifications = db.prepare(`
      SELECT * FROM classifications WHERE document_id = ? ORDER BY classified_at DESC
    `).all(req.params.documentId);

        res.json({ classifications });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// ═══════════════════════════════════════════════════
// GET /api/classify — List available providers
// ═══════════════════════════════════════════════════
router.get('/', (req, res) => {
    try {
        const provider = getProvider();
        res.json({
            active_provider: provider.name,
            active_model: provider.modelName,
            available_providers: listProviders(),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
