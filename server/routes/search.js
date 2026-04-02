import express from 'express';
import { readDb as db } from '../db.js';

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
            latest_thread_only,
            investigation_id,
            custodian,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Parse FTS5 query: support "exact phrase", OR, and -exclude
        const parseQuery = (raw) => {
            const tokens = raw.match(/("[^"]+"|-[^\s]+|\bOR\b|[^\s]+)/gi) || [];
            const processed = [];
            for (const token of tokens) {
                if (token.toUpperCase() === 'OR') {
                    processed.push('OR');
                } else if (token.match(/^[a-z_]+:/i)) {
                    // It's a column filter with FTS syntax (e.g. email_from:"abc")
                    processed.push(token);
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
            filterWhere += ' AND d.is_duplicate = 0';
        }

        // Latest-in-thread filter: keep only the most recent email/chat per thread
        if (latest_thread_only === '1') {
            filterWhere += ` AND (d.doc_type NOT IN ('email', 'chat') OR d.thread_id IS NULL OR d.email_date = (
                SELECT MAX(t2.email_date) FROM documents t2
                WHERE t2.thread_id = d.thread_id AND t2.doc_type IN ('email', 'chat')
                AND t2.investigation_id = d.investigation_id
            ))`;
        }

        // Investigation scope
        if (investigation_id) {
            filterWhere += ' AND d.investigation_id = ?';
            filterParams.push(investigation_id);
        }

        if (status) {
            filterWhere += ' AND d.status = ?';
            filterParams.push(status);
        }

        if (doc_type) {
            filterWhere += ' AND d.doc_type = ?';
            filterParams.push(doc_type);
        }

        if (custodian) {
            filterWhere += ' AND d.custodian = ?';
            filterParams.push(custodian);
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
            filterWhere += ' AND COALESCE(d.email_date, d.doc_created_at, d.doc_modified_at, d.uploaded_at) >= ?';
            filterParams.push(date_from);
        }

        if (date_to) {
            filterWhere += ' AND COALESCE(d.email_date, d.doc_created_at, d.doc_modified_at, d.uploaded_at) <= ?';
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

        // Enrichment subqueries — applied only to the paged result set via CTE
        const enrichSelect = `
            d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
            d.doc_type, d.thread_id, d.parent_id, d.custodian,
            d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
            d._snippet as snippet,
            d._rank as rank,
            (SELECT COUNT(*) FROM documents c WHERE c.parent_id = d.id) as attachment_count,
            (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type IN ('email', 'chat') AND t.investigation_id = d.investigation_id) as thread_count,
            (SELECT COUNT(*) FROM documents t WHERE t.thread_id = d.thread_id AND t.doc_type IN ('email', 'chat') AND t.investigation_id = d.investigation_id AND t.email_date <= d.email_date) as thread_position,
            (SELECT cl.score FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_score,
            (SELECT cl.reasoning FROM classifications cl WHERE cl.document_id = d.id ORDER BY cl.classified_at DESC LIMIT 1) as ai_reasoning,
            (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
             FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
             WHERE dt.document_id = d.id) as tags_json,
            (SELECT dr.status FROM document_reviews dr
             WHERE dr.document_id = d.id
             ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status`;

        if (useFts) {
            // FTS search with filters — CROSS JOIN forces FTS-first execution
            countRow = db.prepare(`
          SELECT COUNT(*) as total
          FROM documents_fts fts
          CROSS JOIN documents d ON d.rowid = fts.rowid
          WHERE documents_fts MATCH ?
          ${filterWhere}
        `).get(ftsQuery, ...filterParams);

            // CTE: get the page of rows first, then enrich only those rows
            results = db.prepare(`
          WITH page AS (
            SELECT
              d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
              d.doc_type, d.thread_id, d.parent_id, d.investigation_id, d.custodian,
              d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
              snippet(documents_fts, 1, '<mark>', '</mark>', '…', 40) as _snippet,
              rank as _rank
            FROM documents_fts fts
            CROSS JOIN documents d ON d.rowid = fts.rowid
            WHERE documents_fts MATCH ?
            ${filterWhere}
            ORDER BY rank
            LIMIT ? OFFSET ?
          )
          SELECT ${enrichSelect} FROM page d
          ORDER BY d._rank
        `).all(ftsQuery, ...filterParams, parseInt(limit), offset);
        } else {
            // Filter-only (no search query)
            countRow = db.prepare(`
          SELECT COUNT(*) as total
          FROM documents d
          WHERE 1=1 ${filterWhere}
        `).get(...filterParams);

            // CTE: get the page of rows first, then enrich only those rows
            results = db.prepare(`
          WITH page AS (
            SELECT
              d.id, d.filename, d.original_name, d.mime_type, d.size_bytes, d.status,
              d.doc_type, d.thread_id, d.parent_id, d.investigation_id, d.custodian,
              d.email_from, d.email_to, d.email_subject, d.email_date, d.uploaded_at,
              SUBSTR(d.text_content, 1, 200) as _snippet,
              NULL as _rank
            FROM documents d
            WHERE 1=1 ${filterWhere}
            ORDER BY COALESCE(d.email_date, d.uploaded_at) DESC
            LIMIT ? OFFSET ?
          )
          SELECT ${enrichSelect} FROM page d
          ORDER BY COALESCE(d.email_date, d.uploaded_at) DESC
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

// Local Gemma NLP Search Translation Endpoint
router.post('/nl-to-sql', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        const model = process.env.OLLAMA_MODEL || 'gemma3:4b';

        const systemPrompt = `You are a strict JSON-only API that translates natural language into search parameters for an eDiscovery tool.
Do not output markdown. Do not wrap in \`\`\`json. Just output the raw JSON object.

The parameters you can output in the JSON are:
- "q": The FTS5 string.
  - For single keyword searches, DO NOT USE any column prefix AND do not use quotes! Output raw words, e.g. "q": "cost". 
  - ONLY use exact column matches (e.g. email_from:"name" or email_to:"Jane") when specifically filtering on metadata like senders/recipients. Available columns: original_name, email_subject, email_from, email_to.
  - SQLite FTS5 uses 'NOT' instead of '!'. If the user asks for 1-to-1 emails or no one in CC, approximate this by excluding the word cc using NOT: e.g. email_from:"Sandeep" AND email_to:"Manoj" NOT "cc"
- "docType": Optional. Can be "email", "chat", "file", or "attachment".
- "dateFrom": Optional. YYYY-MM-DD format.
- "dateTo": Optional. YYYY-MM-DD format.

Example 1:
Input: Find emails from Atul to John sent in January 2022
Output: {"q":"email_from:\\"Atul\\" AND email_to:\\"John\\"","docType":"email","dateFrom":"2022-01-01","dateTo":"2022-01-31"}

Example 2:
Input: Find chats about the secret project
Output: {"q":"\\"secret project\\"","docType":"chat"}

Example 3:
Input: show emails having text cost
Output: {"q":"cost","docType":"email"}

Draft a response for the user's input.
Input: ${JSON.stringify(query)}`;

        const response = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: systemPrompt,
                stream: false,
                format: 'json'
            })
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Ollama API error' });
        }

        const data = await response.json();
        let parsed;
        try {
            parsed = JSON.parse(data.response);
        } catch (e) {
            const match = data.response.match(/\{[\s\S]*\}/);
            parsed = match ? JSON.parse(match[0]) : {};
        }

        res.json(parsed);
    } catch (err) {
        console.error("NL Search Error:", err);
        res.status(500).json({ error: 'Failed to query local LLM' });
    }
});

export default router;
