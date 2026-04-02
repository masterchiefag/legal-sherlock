import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatSize, getScoreColor } from '../utils/format';

function Search({ activeInvestigationId, addToast }) {
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
    const [latestThreadOnly, setLatestThreadOnly] = useState(searchParams.get('latest_thread') === '1');
    const [custodianFilter, setCustodianFilter] = useState(searchParams.get('custodian') || '');
    const [custodianList, setCustodianList] = useState([]);

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

    // Saved searches (bookmarks)
    const [savedSearches, setSavedSearches] = useState(() => {
        try { return JSON.parse(localStorage.getItem('sherlock_saved_searches') || '[]'); } catch { return []; }
    });

    const saveCurrentSearch = () => {
        if (!query.trim() && !hasActiveFilters) return;
        const bookmark = {
            id: Date.now(),
            label: query.trim() || [reviewStatus, docType, scoreFilter].filter(Boolean).join(', '),
            q: query.trim(),
            status: reviewStatus, type: docType, score: scoreFilter,
            from: dateFrom, to: dateTo, dedup: hideDuplicates ? '1' : '0'
        };
        const updated = [bookmark, ...savedSearches.filter(s => s.label !== bookmark.label)].slice(0, 20);
        setSavedSearches(updated);
        localStorage.setItem('sherlock_saved_searches', JSON.stringify(updated));
        addToast('Search bookmarked', 'success');
    };

    const loadSavedSearch = (s) => {
        setQuery(s.q || '');
        setReviewStatus(s.status || '');
        setDocType(s.type || '');
        setScoreFilter(s.score || '');
        setDateFrom(s.from || '');
        setDateTo(s.to || '');
        setHideDuplicates(s.dedup !== '0');
        setTimeout(() => doSearch(), 0);
    };

    const removeSavedSearch = (id) => {
        const updated = savedSearches.filter(s => s.id !== id);
        setSavedSearches(updated);
        localStorage.setItem('sherlock_saved_searches', JSON.stringify(updated));
    };

    const navigate = useNavigate();

    // Load documents on mount — restore page from URL if present
    useEffect(() => {
        const initialPage = parseInt(searchParams.get('page')) || 1;
        doSearch(initialPage);
    }, []);

    // Fetch custodian list for filter dropdown
    useEffect(() => {
        if (!activeInvestigationId) return;
        fetch(`/api/investigations/${activeInvestigationId}/custodians`)
            .then(r => r.json())
            .then(data => setCustodianList(Array.isArray(data) ? data : []))
            .catch(() => {});
    }, [activeInvestigationId]);

    const hasActiveFilters = reviewStatus || docType || scoreFilter || dateFrom || dateTo || custodianFilter;

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
        if (latestThreadOnly) apiParams.set('latest_thread_only', '1');
        if (custodianFilter) apiParams.set('custodian', custodianFilter);
        if (activeInvestigationId) apiParams.set('investigation_id', activeInvestigationId);

        if (scoreFilter) {
            if (scoreFilter === 'unscored') {
                apiParams.set('score_min', 'unscored');
            } else if (scoreFilter === 'scored') {
                apiParams.set('score_min', '1');
            } else if (scoreFilter.endsWith('+')) {
                apiParams.set('score_min', scoreFilter.replace('+', ''));
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
        if (latestThreadOnly) urlParams.latest_thread = '1';
        if (custodianFilter) urlParams.custodian = custodianFilter;
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
    }, [query, reviewStatus, docType, scoreFilter, dateFrom, dateTo, hideDuplicates, latestThreadOnly, custodianFilter, hasActiveFilters, setSearchParams]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') doSearch();
    };

    const [shouldRefresh, setShouldRefresh] = useState(0);
    const [lastNlQuery, setLastNlQuery] = useState('');

    const executeNlSearch = async () => {
        if (!query.trim()) return;
        const currentNlQuery = query.trim();
        setLoading(true);
        try {
            const res = await fetch('/api/search/nl-to-sql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            if (!res.ok) throw new Error("NLP translation failed");
            const parsed = await res.json();
            
            // Set the translated FTS parameters into the UI state
            setQuery(parsed.q || '');
            setDocType(parsed.docType || '');
            setDateFrom(parsed.dateFrom || '');
            setDateTo(parsed.dateTo || '');

            // Store what they asked for in case they want to revert
            setLastNlQuery(currentNlQuery);

            // Force a search refresh with the new parameters
            setShouldRefresh(n => n + 1);
        } catch (err) {
            console.error(err);
            addToast('Failed to translate natural language search', 'error');
            setLoading(false);
        }
    };

    const clearSearch = () => {
        setQuery('');
        setReviewStatus('');
        setDocType('');
        setScoreFilter('');
        setDateFrom('');
        setDateTo('');
        setLastNlQuery('');
        setCustodianFilter('');
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
            } else if (scoreFilter === 'scored') {
                params.set('score_min', '1');
            } else if (scoreFilter.endsWith('+')) {
                params.set('score_min', scoreFilter.replace('+', ''));
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
        if (doc.doc_type === 'chat') return '💬';
        const ext = doc.original_name?.split('.').pop().toLowerCase();
        if (ext === 'pdf') return '📄';
        if (ext === 'docx') return '📝';
        return '📋';
    };

    const getDisplayName = (doc) => {
        if ((doc.doc_type === 'email' || doc.doc_type === 'chat') && doc.email_subject) {
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
        if (doc.doc_type === 'chat') {
            const parts = [];
            if (doc.email_from) parts.push(`Participants: ${doc.email_from}`);
            if (doc.email_date) parts.push(new Date(doc.email_date).toLocaleDateString());
            return parts.join(' • ');
        }
        return null;
    };

    return (
        <div className="fade-in">
            {/* Search Bar */}
            <div className="input-group mb-24" style={{ position: 'relative' }}>
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
                    style={{ fontSize: '16px', padding: '14px 100px 14px 44px' }}
                />
                <button
                    onClick={executeNlSearch}
                    disabled={loading || !query.trim()}
                    style={{
                        position: 'absolute', right: '8px', top: '8px',
                        background: 'var(--primary)', color: '#fff',
                        border: 'none', borderRadius: '4px',
                        padding: '6px 12px', fontSize: '13px',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                        opacity: (loading || !query.trim()) ? 0.6 : 1
                    }}
                    title="Translate natural language to search filters"
                >
                    {loading ? '✨ Thinking...' : '✨ Ask AI'}
                </button>
            </div>

            {lastNlQuery && (
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '-16px', marginBottom: '24px', display: 'flex', alignItems: 'center' }}>
                    ✨ Generated from:&nbsp;<i>"{lastNlQuery}"</i>
                    <button 
                        type="button" 
                        className="btn btn-sm" 
                        style={{ background: 'transparent', border: 'none', color: 'var(--primary)', padding: '0 8px', marginLeft: '4px', cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() => {
                            setQuery(lastNlQuery);
                            setLastNlQuery('');
                        }}
                    >
                        Edit prompt
                    </button>
                </div>
            )}

            {/* Filters */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px' }}>
                {/* Row 1: Dropdowns + dates + search */}
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <select className="filter-select" value={reviewStatus} onChange={e => setReviewStatus(e.target.value)}>
                        <option value="">All Statuses</option>
                        <option value="pending">Pending</option>
                        <option value="relevant">Relevant</option>
                        <option value="not_relevant">Not Relevant</option>
                        <option value="privileged">Privileged</option>
                    </select>
                    <select className="filter-select" value={docType} onChange={e => setDocType(e.target.value)}>
                        <option value="">All Types</option>
                        <option value="email">Emails</option>
                        <option value="chat">Chats / WhatsApp</option>
                        <option value="file">Files</option>
                        <option value="attachment">Attachments</option>
                    </select>
                    <select className="filter-select" value={scoreFilter} onChange={e => setScoreFilter(e.target.value)}>
                        <option value="">All Scores</option>
                        <option value="scored">Scored</option>
                        <option value="unscored">Unscored</option>
                        <option disabled>──────────</option>
                        <option value="3+">3+ Relevant</option>
                        <option value="4+">4+ Highly Relevant</option>
                        <option value="5">5 — Smoking Gun</option>
                    </select>
                    {custodianList.length > 0 && (
                        <select className="filter-select" value={custodianFilter} onChange={e => setCustodianFilter(e.target.value)}>
                            <option value="">All Custodians</option>
                            {custodianList.map(c => (
                                <option key={c.name} value={c.name}>{c.name} ({c.document_count})</option>
                            ))}
                        </select>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input type="date" className="input" style={{ width: 'auto', padding: '8px 12px', fontSize: '13px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>–</span>
                        <input type="date" className="input" style={{ width: 'auto', padding: '8px 12px', fontSize: '13px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
                    </div>
                    <button className="btn btn-primary" onClick={() => doSearch()}>Search</button>
                </div>

                {/* Row 2: Toggles + actions */}
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', userSelect: 'none', whiteSpace: 'nowrap' }}>
                        <input
                            type="checkbox"
                            checked={hideDuplicates}
                            onChange={(e) => { setHideDuplicates(e.target.checked); setTimeout(() => doSearch(), 0); }}
                            style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                        />
                        Hide Duplicates
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', userSelect: 'none', whiteSpace: 'nowrap' }}>
                        <input
                            type="checkbox"
                            checked={latestThreadOnly}
                            onChange={(e) => { setLatestThreadOnly(e.target.checked); setTimeout(() => doSearch(), 0); }}
                            style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                        />
                        Latest in Thread
                    </label>
                    {(query.trim() || hasActiveFilters) && (
                        <>
                            <button className="btn btn-ghost btn-sm" onClick={clearSearch}>Clear</button>
                            <button className="btn btn-ghost btn-sm" onClick={saveCurrentSearch} title="Bookmark this search" style={{ padding: '4px 8px', fontSize: '15px' }}>
                                &#9733;
                            </button>
                        </>
                    )}
                    {results.length > 0 && (
                        <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={toggleBatchPanel}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px', marginRight: '5px' }}>
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                            </svg>
                            Batch AI Classify
                        </button>
                    )}
                </div>
            </div>

            {/* Saved Searches */}
            {savedSearches.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px', alignItems: 'center' }}>
                    <span className="text-xs text-muted" style={{ marginRight: '4px' }}>Saved:</span>
                    {savedSearches.map(s => (
                        <span key={s.id} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                            background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                            borderRadius: '16px', padding: '3px 10px', fontSize: '12px', color: 'var(--text-secondary)',
                            cursor: 'pointer'
                        }}>
                            <span onClick={() => loadSavedSearch(s)} style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.label}
                            </span>
                            <span onClick={(e) => { e.stopPropagation(); removeSavedSearch(s.id); }}
                                style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1, marginLeft: '2px' }}
                                title="Remove bookmark"
                            >&times;</span>
                        </span>
                    ))}
                </div>
            )}

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
                    <div className="text-xs text-muted" style={{ marginTop: '10px', fontStyle: 'italic' }}>
                        Tip: Re-run with a different model and the same prompt to compare results in AI Logs → Model Comparison
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
                                        onClick={() => navigate(`/documents/${r.id}${query ? `?q=${encodeURIComponent(query)}` : ''}`)}
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
                                            <span>{r.email_date ? new Date(r.email_date).toLocaleDateString() : 'No date'}</span>
                                            {r.doc_type === 'email' && r.attachment_count > 0 && (
                                                <>
                                                    <span>•</span>
                                                    <span>📎 {r.attachment_count} attachment{r.attachment_count > 1 ? 's' : ''}</span>
                                                </>
                                            )}
                                            {(r.doc_type === 'email' || r.doc_type === 'chat') && r.thread_count > 1 && (
                                                <>
                                                    <span>•</span>
                                                    <span>🔗 #{r.thread_position} of {r.thread_count}</span>
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
                                            {r.custodian && (
                                                <>
                                                    <span>•</span>
                                                    <span style={{ fontSize: '11px', color: 'var(--text-accent)' }}>👤 {r.custodian}</span>
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
