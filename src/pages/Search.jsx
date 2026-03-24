import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatSize, getScoreColor } from '../utils/format';

function Search({ addToast }) {
    const [searchParams, setSearchParams] = useSearchParams();
    const [query, setQuery] = useState(searchParams.get('q') || '');
    const [results, setResults] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    // Filters
    const [reviewStatus, setReviewStatus] = useState(searchParams.get('status') || '');
    const [docType, setDocType] = useState(searchParams.get('type') || '');
    const [scoreFilter, setScoreFilter] = useState(searchParams.get('score') || '');
    const [dateFrom, setDateFrom] = useState(searchParams.get('from') || '');
    const [dateTo, setDateTo] = useState(searchParams.get('to') || '');
    const [hideDuplicates, setHideDuplicates] = useState(searchParams.get('dedup') !== '0');

    // Batch Classification
    const [showBatchPanel, setShowBatchPanel] = useState(false);
    const [models, setModels] = useState([]);
    const [selectedModel, setSelectedModel] = useState('');
    const [modelsError, setModelsError] = useState('');
    const [batchPrompt, setBatchPrompt] = useState(
        () => localStorage.getItem('sherlock_investigation_prompt') || ''
    );
    const [batchStatus, setBatchStatus] = useState('idle'); // idle, running, done
    const [batchProgress, setBatchProgress] = useState(0);
    const [batchTotal, setBatchTotal] = useState(0);
    const [batchTime, setBatchTime] = useState(0);

    // Selection for batch classification
    const [selectedIds, setSelectedIds] = useState(new Set());

    const navigate = useNavigate();

    // Load documents on mount — restore page from URL if present
    useEffect(() => {
        const initialPage = parseInt(searchParams.get('page')) || 1;
        doSearch(initialPage);
    }, []);

    const hasActiveFilters = reviewStatus || docType || scoreFilter || dateFrom || dateTo;

    const doSearch = useCallback(async (page = 1) => {
        setLoading(true);
        setSearched(true);
        setSelectedIds(new Set());

        const apiParams = new URLSearchParams({ page, limit: 15 });
        if (query.trim()) apiParams.set('q', query);
        if (reviewStatus) apiParams.set('review_status', reviewStatus);
        if (docType) apiParams.set('doc_type', docType);
        if (dateFrom) apiParams.set('date_from', dateFrom);
        if (dateTo) apiParams.set('date_to', dateTo);
        if (hideDuplicates) apiParams.set('hide_duplicates', '1');

        if (scoreFilter) {
            if (scoreFilter === 'unscored') {
                apiParams.set('score_min', 'unscored');
            } else {
                apiParams.set('score_min', scoreFilter);
                apiParams.set('score_max', scoreFilter);
            }
        }

        // Sync search state to URL for back-button support
        const urlParams = {};
        if (query.trim()) urlParams.q = query.trim();
        if (reviewStatus) urlParams.status = reviewStatus;
        if (docType) urlParams.type = docType;
        if (scoreFilter) urlParams.score = scoreFilter;
        if (dateFrom) urlParams.from = dateFrom;
        if (dateTo) urlParams.to = dateTo;
        if (!hideDuplicates) urlParams.dedup = '0';
        if (page > 1) urlParams.page = String(page);
        setSearchParams(urlParams, { replace: true });

        try {
            const res = await fetch(`/api/search?${apiParams}`);
            const data = await res.json();
            setResults(data.results);
            setPagination(data.pagination);
        } catch (err) {
            console.error('Search failed:', err);
            addToast('Search failed', 'error');
        }

        setLoading(false);
    }, [query, reviewStatus, docType, scoreFilter, dateFrom, dateTo, hideDuplicates, hasActiveFilters, setSearchParams]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') doSearch();
    };

    const [shouldRefresh, setShouldRefresh] = useState(0);

    const clearSearch = () => {
        setQuery('');
        setReviewStatus('');
        setDocType('');
        setScoreFilter('');
        setDateFrom('');
        setDateTo('');
        setHideDuplicates(true);
        setSearched(false);
        setResults([]);
        setPagination(null);
        setSelectedIds(new Set());
        setSearchParams({}, { replace: true });
        setShouldRefresh(n => n + 1);
    };

    // Re-fetch after clearing filters (state will have been reset by now)
    useEffect(() => {
        if (shouldRefresh > 0) doSearch(1);
    }, [shouldRefresh]);

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === results.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(results.map(r => r.id)));
        }
    };

    const toggleBatchPanel = async () => {
        if (!showBatchPanel && models.length === 0) {
            setModelsError('');
            try {
                const res = await fetch('/api/classify/models');
                const data = await res.json();
                setModels(data.models || []);
                if (data.error) {
                    setModelsError(data.error);
                } else if (data.models && data.models.length > 0) {
                    setSelectedModel(data.active_model || data.models[0]);
                }
            } catch (err) {
                console.error('Failed to load models:', err);
                setModelsError('Failed to connect to server');
            }
        }
        setShowBatchPanel(!showBatchPanel);
    };

    const startBatchClassify = async () => {
        if (!batchPrompt.trim() || !selectedModel || results.length === 0) return;

        localStorage.setItem('sherlock_investigation_prompt', batchPrompt);
        setBatchStatus('running');
        setBatchProgress(0);
        setBatchTime(0);

        // Fetch ALL matching IDs by re-running search without pagination
        const params = new URLSearchParams({ page: 1, limit: 10000 });
        if (query.trim()) params.set('q', query);
        if (reviewStatus) params.set('review_status', reviewStatus);
        if (docType) params.set('doc_type', docType);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);
        if (scoreFilter) {
            if (scoreFilter === 'unscored') {
                params.set('score_min', 'unscored');
            } else {
                params.set('score_min', scoreFilter);
                params.set('score_max', scoreFilter);
            }
        }

        try {
            const searchRes = await fetch(`/api/search?${params}`);
            const searchData = await searchRes.json();
            const allDocs = searchData.results || [];

            if (allDocs.length === 0) {
                setBatchStatus('done');
                return;
            }

            // If user selected specific docs, filter to only those
            const docsToClassify = selectedIds.size > 0
                ? allDocs.filter(d => selectedIds.has(d.id))
                : allDocs;

            if (docsToClassify.length === 0) {
                setBatchStatus('done');
                return;
            }

            setBatchTotal(docsToClassify.length);
            const startTime = Date.now();

            const timer = setInterval(() => {
                setBatchTime(Math.floor((Date.now() - startTime) / 1000));
            }, 1000);

            for (let i = 0; i < docsToClassify.length; i++) {
                const doc = docsToClassify[i];
                try {
                    await fetch(`/api/classify/${doc.id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            investigationPrompt: batchPrompt,
                            model: selectedModel
                        }),
                    });
                } catch (e) {
                    console.error('Failed to classify doc', doc.id, e);
                }
                setBatchProgress(i + 1);
            }

            clearInterval(timer);
            setBatchStatus('done');
            setSelectedIds(new Set());
            addToast(`Successfully classified ${docsToClassify.length} documents!`, 'success');

            // Refresh current search view
            doSearch(pagination?.page || 1);

        } catch (err) {
            console.error('Failed to run batch classify', err);
            addToast('Batch classification failed', 'error');
            setBatchStatus('idle');
        }
    };

    const getDocIcon = (doc) => {
        if (doc.doc_type === 'email') return '✉';
        const ext = doc.original_name?.split('.').pop().toLowerCase();
        if (ext === 'pdf') return '📄';
        if (ext === 'docx') return '📝';
        return '📋';
    };

    const getDisplayName = (doc) => {
        if (doc.doc_type === 'email' && doc.email_subject) {
            return doc.email_subject;
        }
        return doc.original_name;
    };

    const getSubline = (doc) => {
        if (doc.doc_type === 'email') {
            const parts = [];
            if (doc.email_from) parts.push(`From: ${doc.email_from.split('<')[0].trim()}`);
            if (doc.email_date) parts.push(new Date(doc.email_date).toLocaleDateString());
            return parts.join(' • ');
        }
        return null;
    };

    return (
        <div className="fade-in">
            {/* Search Bar */}
            <div className="input-group mb-24">
                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                    type="text"
                    className="input search-input"
                    placeholder="Search documents by content, subject, or sender…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    style={{ fontSize: '16px', padding: '14px 16px 14px 44px' }}
                />
            </div>

            {/* Filters */}
            <div className="filters-panel">
                <select className="filter-select" value={reviewStatus} onChange={e => setReviewStatus(e.target.value)}>
                    <option value="">All Review Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="relevant">Relevant</option>
                    <option value="not_relevant">Not Relevant</option>
                    <option value="privileged">Privileged</option>
                </select>
                <select className="filter-select" value={docType} onChange={e => setDocType(e.target.value)}>
                    <option value="">All Types</option>
                    <option value="email">Emails</option>
                    <option value="file">Files</option>
                    <option value="attachment">Attachments</option>
                </select>
                <select className="filter-select" value={scoreFilter} onChange={e => setScoreFilter(e.target.value)}>
                    <option value="">All Scores</option>
                    <option value="5">🔴 5 — Smoking Gun</option>
                    <option value="4">🟠 4 — Highly Relevant</option>
                    <option value="3">🟡 3 — Potentially Relevant</option>
                    <option value="2">🔵 2 — Unlikely Relevant</option>
                    <option value="1">⚪ 1 — Not Relevant</option>
                    <option value="unscored">— Unscored</option>
                </select>
                <input type="date" className="input" style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                <input type="date" className="input" style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
                <button className="btn btn-primary" onClick={() => doSearch()}>Search</button>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', userSelect: 'none', whiteSpace: 'nowrap' }}>
                    <input
                        type="checkbox"
                        checked={hideDuplicates}
                        onChange={(e) => { setHideDuplicates(e.target.checked); setTimeout(() => doSearch(), 0); }}
                        style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                    />
                    Hide Duplicates
                </label>
                {(query.trim() || reviewStatus || docType || scoreFilter || dateFrom || dateTo) && (
                    <button className="btn btn-ghost" onClick={clearSearch}>Clear</button>
                )}
                {results.length > 0 && (
                    <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={toggleBatchPanel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '16px', height: '16px', marginRight: '6px' }}>
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                        </svg>
                        Batch AI Classify
                    </button>
                )}
            </div>

            {/* Batch AI Classification Panel */}
            {showBatchPanel && (
                <div className="card fade-in" style={{ marginBottom: '24px', border: '1px solid var(--primary)', background: 'var(--bg-tertiary)' }}>
                    <h3 style={{ marginTop: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '18px', height: '18px', color: 'var(--primary)' }}>
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                        </svg>
                        Batch AI Classification
                    </h3>

                    <div className="flex gap-16" style={{ alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                            <label className="text-sm text-secondary block mb-8">Investigation Prompt</label>
                            <textarea
                                className="textarea"
                                placeholder="Describe exactly what evidence or keywords the AI should look for..."
                                value={batchPrompt}
                                onChange={(e) => setBatchPrompt(e.target.value)}
                                rows="3"
                                disabled={batchStatus === 'running'}
                            />
                        </div>
                        <div style={{ width: '250px' }}>
                            <label className="text-sm text-secondary block mb-8">AI Model</label>
                            {modelsError ? (
                                <div style={{ padding: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                                    <p style={{ color: 'var(--warning)', fontSize: '13px', margin: '0 0 8px 0' }}>⚠️ {modelsError}</p>
                                    <button className="btn btn-secondary" style={{ width: '100%', fontSize: '12px' }} onClick={() => { setModels([]); setModelsError(''); setShowBatchPanel(false); setTimeout(() => toggleBatchPanel(), 100); }}>
                                        Retry
                                    </button>
                                </div>
                            ) : (
                                <select
                                    className="select"
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                    disabled={batchStatus === 'running'}
                                    style={{ width: '100%', marginBottom: '16px' }}
                                >
                                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                            )}

                            {batchStatus === 'idle' && (
                                <button
                                    className="btn btn-primary"
                                    style={{ width: '100%' }}
                                    onClick={startBatchClassify}
                                    disabled={!batchPrompt.trim()}
                                >
                                    {selectedIds.size > 0
                                        ? `Classify ${selectedIds.size} Selected`
                                        : 'Classify All Results'}
                                </button>
                            )}

                            {(batchStatus === 'running' || batchStatus === 'done') && (
                                <div style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-secondary)' }}>
                                    <div className="flex justify-between text-sm mb-4">
                                        <span style={{ fontWeight: 600 }}>{Math.round((batchProgress / batchTotal) * 100)}%</span>
                                        <span className="text-secondary">{batchProgress} / {batchTotal} docs</span>
                                    </div>
                                    <div style={{ height: '6px', background: 'var(--border-secondary)', borderRadius: '3px', overflow: 'hidden', marginBottom: '8px' }}>
                                        <div style={{ height: '100%', background: 'var(--primary)', width: `${(batchProgress / batchTotal) * 100}%`, transition: 'width 0.3s' }}></div>
                                    </div>
                                    <div className="text-xs text-tertiary flex justify-between">
                                        <span>{batchStatus === 'running' ? 'Processing...' : 'Complete!'}</span>
                                        <span>{Math.floor(batchTime / 60)}m {batchTime % 60}s</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Search Results */}
            {searched && (
                <>
                    {loading ? (
                        <div className="loading-overlay"><div className="spinner"></div></div>
                    ) : results.length > 0 ? (
                        <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                                <div className="text-sm text-muted">
                                    {pagination.total} result(s){query.trim() ? <> for "<strong style={{ color: 'var(--text-primary)' }}>{query}</strong>"</> : ' (filtered)'}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', userSelect: 'none' }}>
                                        <input
                                            type="checkbox"
                                            checked={results.length > 0 && selectedIds.size === results.length}
                                            ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < results.length; }}
                                            onChange={toggleSelectAll}
                                            style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                                        />
                                        {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
                                    </label>
                                </div>
                            </div>
                            <div className="search-results">
                                {results.map(r => (
                                    <div
                                        key={r.id}
                                        className="search-result-card"
                                        onClick={() => navigate(`/documents/${r.id}`)}
                                        style={selectedIds.has(r.id) ? { borderColor: 'var(--primary)', background: 'var(--bg-tertiary)' } : {}}
                                    >
                                        <div className="flex items-center gap-8">
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(r.id)}
                                                onChange={() => toggleSelect(r.id)}
                                                onClick={(e) => e.stopPropagation()}
                                                style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--primary)', flexShrink: 0 }}
                                            />
                                            <span style={{ fontSize: '18px' }}>{getDocIcon(r)}</span>
                                            <div style={{ flex: 1 }}>
                                                <div className="search-result-title">{getDisplayName(r)}</div>
                                                {getSubline(r) && (
                                                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{getSubline(r)}</div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="search-result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet ? r.snippet.replace(/<(?!\/?mark\b)[^>]*>/gi, '') : 'No preview available' }} />
                                        <div className="search-result-meta">
                                            <span>{formatSize(r.size_bytes)}</span>
                                            <span>•</span>
                                            <span>{new Date(r.uploaded_at).toLocaleDateString()}</span>
                                            {r.doc_type === 'email' && r.attachment_count > 0 && (
                                                <>
                                                    <span>•</span>
                                                    <span>📎 {r.attachment_count} attachment{r.attachment_count > 1 ? 's' : ''}</span>
                                                </>
                                            )}
                                            {r.doc_type === 'email' && r.thread_count > 1 && (
                                                <>
                                                    <span>•</span>
                                                    <span>🔗 {r.thread_count} in thread</span>
                                                </>
                                            )}
                                            {r.tags?.length > 0 && (
                                                <>
                                                    <span>•</span>
                                                    {r.tags.map(t => (
                                                        <span key={t.id} className="tag-chip" style={{
                                                            background: `${t.color}20`, color: t.color, borderColor: `${t.color}40`, fontSize: '11px', padding: '2px 8px'
                                                        }}>{t.name}</span>
                                                    ))}
                                                </>
                                            )}
                                            <span>•</span>
                                            <span className={`status-badge ${r.review_status}`}>{r.review_status.replace('_', ' ')}</span>
                                            {r.ai_score && (
                                                <>
                                                    <span>•</span>
                                                    {renderScoreBadge(r.ai_score)}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {pagination.pages > 1 && (
                                <div className="pagination">
                                    <button className="pagination-btn" disabled={pagination.page <= 1} onClick={() => doSearch(pagination.page - 1)}>← Previous</button>
                                    <span className="pagination-info">Page {pagination.page} of {pagination.pages}</span>
                                    <button className="pagination-btn" disabled={pagination.page >= pagination.pages} onClick={() => doSearch(pagination.page + 1)}>Next →</button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="empty-state">
                            <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                            <h3 className="empty-state-title">No results found</h3>
                            <p className="empty-state-text">Try a different search term or adjust your filters.</p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default Search;

function renderScoreBadge(score) {
    if (!score) return <span className="text-sm text-muted">—</span>;
    const color = getScoreColor(score);
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600,
            background: `${color}18`, color: color, border: `1px solid ${color}30`,
        }}>
            {score}/5
        </span>
    );
}
