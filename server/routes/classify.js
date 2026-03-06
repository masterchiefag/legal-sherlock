import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { getProvider, listProviders } from '../lib/llm-providers.js';

const router = express.Router();

// ═══════════════════════════════════════════════════
// Build the classification prompt
// ═══════════════════════════════════════════════════
function buildSystemPrompt(investigationPrompt) {
    return `You are an expert eDiscovery attorney reviewing documents for responsiveness to a specific investigation.

INVESTIGATION FOCUS:
${investigationPrompt}

SCORING RUBRIC (1-5):
5 = SMOKING GUN — Explicitly discusses the core investigation topic. Direct evidence.
4 = HIGHLY RELEVANT — Strong circumstantial evidence, direct references, or evasive/suspicious language.
3 = POTENTIALLY RELEVANT — Mentions key people, places, or topics but context is ambiguous.
2 = UNLIKELY RELEVANT — Generic business content, unrelated work, company newsletters.
1 = NOT RELEVANT — Spam, lunch orders, completely unrelated personal chatter, system notifications.

RULES:
- Score based ONLY on relevance to the investigation focus above.
- Consider the full context: sender, recipients, subject, body text, and any attachment content.
- If the document discusses concealment, destruction of evidence, or coded language, score higher.
- Respond ONLY with valid JSON. No other text.`;
}

function buildDocumentContent(doc, thread, attachments) {
    let content = '';

    // Email metadata
    if (doc.doc_type === 'email') {
        content += `FROM: ${doc.email_from || 'Unknown'}\n`;
        content += `TO: ${doc.email_to || 'Unknown'}\n`;
        if (doc.email_cc) content += `CC: ${doc.email_cc}\n`;
        content += `DATE: ${doc.email_date || 'Unknown'}\n`;
        content += `SUBJECT: ${doc.email_subject || 'No subject'}\n\n`;
    } else {
        content += `FILENAME: ${doc.original_name}\n`;
        content += `TYPE: ${doc.mime_type || 'Unknown'}\n\n`;
    }

    // Main body (truncate to avoid exceeding context window)
    const body = (doc.text_content || '').substring(0, 3000);
    content += `BODY:\n${body}\n`;

    // Thread context (previous emails in the conversation)
    if (thread && thread.length > 1) {
        content += '\n--- THREAD CONTEXT (other emails in this conversation) ---\n';
        for (const msg of thread) {
            if (msg.id === doc.id) continue; // skip self
            const msgDoc = db.prepare('SELECT text_content, email_from, email_subject, email_date FROM documents WHERE id = ?').get(msg.id);
            if (msgDoc) {
                content += `\n[${msgDoc.email_date || 'Unknown date'}] ${msgDoc.email_from || 'Unknown'}: ${msgDoc.email_subject || 'No subject'}\n`;
                content += (msgDoc.text_content || '').substring(0, 1000) + '\n';
            }
        }
    }

    // Attachment content
    if (attachments && attachments.length > 0) {
        content += '\n--- ATTACHMENTS ---\n';
        for (const att of attachments) {
            const attDoc = db.prepare('SELECT text_content, original_name FROM documents WHERE id = ?').get(att.id);
            if (attDoc) {
                content += `\n[Attachment: ${attDoc.original_name}]\n`;
                content += (attDoc.text_content || '').substring(0, 1500) + '\n';
            }
        }
    }

    return content;
}

// ═══════════════════════════════════════════════════
// POST /api/classify/:documentId — Classify a document
// ═══════════════════════════════════════════════════
router.post('/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;
        const { investigationPrompt } = req.body;

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
                "SELECT id, email_from, email_subject, email_date FROM documents WHERE thread_id = ? AND doc_type = 'email' ORDER BY email_date ASC"
            ).all(doc.thread_id);
        }

        // Fetch attachments
        const attachments = db.prepare('SELECT id, original_name FROM documents WHERE parent_id = ?').all(documentId);

        // Build prompts
        const systemPrompt = buildSystemPrompt(investigationPrompt.trim());
        const documentContent = buildDocumentContent(doc, thread, attachments);

        // Call LLM
        const provider = getProvider();
        console.log(`🔍 Classifying document ${documentId} with ${provider.name}/${provider.modelName}...`);

        const startTime = Date.now();
        const result = await provider.classify(systemPrompt, documentContent);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`✦ Classification complete in ${elapsed}s — Score: ${result.score}/5`);

        // Save to DB
        const classificationId = uuidv4();
        db.prepare(`
      INSERT INTO classifications (id, document_id, investigation_prompt, score, reasoning, provider, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(classificationId, documentId, investigationPrompt.trim(), result.score, result.reasoning, provider.name, provider.modelName);

        res.json({
            id: classificationId,
            document_id: documentId,
            score: result.score,
            reasoning: result.reasoning,
            provider: provider.name,
            model: provider.modelName,
            elapsed_seconds: parseFloat(elapsed),
            classified_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Classification error:', err.message);
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

export default router;
