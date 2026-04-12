/**
 * Shared search filter builder — used by both search and batch routes.
 */

// Parse FTS5 query: support "exact phrase", OR, AND, NOT, -exclude, column filters
export function parseQuery(raw) {
    const tokens = raw.match(/([a-z_]+:"[^"]+"|\("[^"]+"\)|"[^"]+"|-[^\s]+|\bOR\b|[^\s]+)/gi) || [];
    const processed = [];
    for (const token of tokens) {
        if (token.toUpperCase() === 'OR') {
            processed.push('OR');
        } else if (token.toUpperCase() === 'AND') {
            processed.push('AND');
        } else if (token.toUpperCase() === 'NOT') {
            processed.push('NOT');
        } else if (token.match(/^[a-z_]+:/i)) {
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
}

/**
 * Build WHERE clause fragments and params from search filter parameters.
 * @param {Object} params - Search parameters (q, doc_type, hide_duplicates, etc.)
 * @param {Object} user - Authenticated user (for investigation scoping)
 * @returns {{ filterWhere: string, filterParams: Array }}
 */
export function buildSearchFilter(params, user) {
    const {
        q = '',
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
        ocr_applied,
        batch_id,
    } = params;

    const hasQuery = q.trim().length > 0;
    const isDocIdQuery = hasQuery && /^[A-Z0-9]{2,}_[A-Z0-9]{2,}(_|$)/i.test(q.trim());

    let filterWhere = '';
    const filterParams = [];

    if (isDocIdQuery) {
        filterWhere += ' AND d.doc_identifier LIKE ?';
        filterParams.push(`%${q.trim()}%`);
    }

    if (doc_type !== 'attachment') {
        filterWhere += " AND (d.doc_type != 'attachment' OR d.doc_type IS NULL)";
    }

    if (hide_duplicates === '1') {
        filterWhere += ' AND d.is_duplicate = 0';
    }

    if (latest_thread_only === '1') {
        filterWhere += ` AND (d.doc_type NOT IN ('email', 'chat') OR d.thread_id IS NULL OR d.email_date = (
            SELECT MAX(t2.email_date) FROM documents t2
            WHERE t2.thread_id = d.thread_id AND t2.doc_type IN ('email', 'chat')
            AND t2.investigation_id = d.investigation_id
        ))`;
    }

    if (investigation_id) {
        filterWhere += ' AND d.investigation_id = ?';
        filterParams.push(investigation_id);
    } else if (user && user.role !== 'admin') {
        filterWhere += ' AND d.investigation_id IN (SELECT investigation_id FROM investigation_members WHERE user_id = ?)';
        filterParams.push(user.id);
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
        const tagList = typeof tags === 'string' ? tags.split(',') : tags;
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

    if (ocr_applied === '1') {
        filterWhere += ' AND d.ocr_applied = 1';
    }

    if (batch_id) {
        filterWhere += ' AND d.id IN (SELECT document_id FROM review_batch_documents WHERE batch_id = ?)';
        filterParams.push(batch_id);
    }

    return { filterWhere, filterParams };
}
