/**
 * Build URL search params representing the current search context.
 * Used when navigating from search results to a document page,
 * so the document page can reconstruct the search for prev/next navigation.
 */
export function buildSearchContextParams({
    query, reviewStatus, docType, scoreFilter, dateFrom, dateTo,
    hideDuplicates, latestThreadOnly, custodianFilter, ocrAppliedFilter,
    batchIdFilter, batchNumLabel, page, pageSize, investigationId,
}) {
    const params = new URLSearchParams();
    if (query?.trim()) params.set('q', query.trim());
    if (reviewStatus) params.set('status', reviewStatus);
    if (docType) params.set('type', docType);
    if (scoreFilter) params.set('score', scoreFilter);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (hideDuplicates === false) params.set('dedup', '0');
    if (latestThreadOnly) params.set('latest_thread', '1');
    if (custodianFilter) params.set('custodian', custodianFilter);
    if (ocrAppliedFilter) params.set('ocr_applied', ocrAppliedFilter);
    if (batchIdFilter) { params.set('batch_id', batchIdFilter); if (batchNumLabel) params.set('batch_num', batchNumLabel); }
    if (page && page > 1) params.set('page', String(page));
    if (pageSize && pageSize !== 25) params.set('per_page', String(pageSize));
    if (investigationId) params.set('inv', investigationId);
    return params;
}

/**
 * Convert URL search params (from document page URL) into API query params
 * for the /api/documents/:id/neighbors endpoint.
 * Maps frontend URL param names to backend API param names.
 */
export function searchContextToApiParams(urlParams) {
    const api = new URLSearchParams();
    const q = urlParams.get('q');
    if (q) api.set('q', q);
    const status = urlParams.get('status');
    if (status) api.set('review_status', status);
    const type = urlParams.get('type');
    if (type) api.set('doc_type', type);
    const score = urlParams.get('score');
    if (score) {
        if (score === 'unscored') {
            api.set('score_min', 'unscored');
        } else if (score === 'scored') {
            api.set('score_min', '1');
        } else if (score.endsWith('+')) {
            api.set('score_min', score.replace('+', ''));
        } else {
            api.set('score_min', score);
            api.set('score_max', score);
        }
    }
    const from = urlParams.get('from');
    if (from) api.set('date_from', from);
    const to = urlParams.get('to');
    if (to) api.set('date_to', to);
    const dedup = urlParams.get('dedup');
    if (dedup !== '0') api.set('hide_duplicates', '1');
    const latestThread = urlParams.get('latest_thread');
    if (latestThread === '1') api.set('latest_thread_only', '1');
    const custodian = urlParams.get('custodian');
    if (custodian) api.set('custodian', custodian);
    const ocrApplied = urlParams.get('ocr_applied');
    if (ocrApplied) api.set('ocr_applied', ocrApplied);
    const batchId = urlParams.get('batch_id');
    if (batchId) api.set('batch_id', batchId);
    const inv = urlParams.get('inv');
    if (inv) api.set('investigation_id', inv);
    const page = urlParams.get('page');
    if (page) api.set('page', page);
    const perPage = urlParams.get('per_page');
    if (perPage) api.set('limit', perPage);
    return api;
}

/**
 * Check if URL has search context params (i.e. user came from search).
 */
export function hasSearchContext(urlParams) {
    return urlParams.has('q') || urlParams.has('status') || urlParams.has('type') ||
        urlParams.has('score') || urlParams.has('from') || urlParams.has('to') ||
        urlParams.has('batch_id') || urlParams.has('custodian') || urlParams.has('inv');
}
