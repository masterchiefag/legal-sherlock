import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatSize, getScoreColor } from '../utils/format';
import { apiFetch, apiPost } from '../utils/api';
import { buildSearchContextParams } from '../utils/searchContext';

function Search({ activeInvestigationId, activeInvestigation, addToast }) {
    const [searchParams, setSearchParams] = useSearchParams();
    const [query, setQuery] = useState(searchParams.get('q') || '');
    const [results, setResults] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [pageSize, setPageSize] = useState(() => parseInt(searchParams.get('per_page')) || 25);

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
    const [ocrAppliedFilter, setOcrAppliedFilter] = useState(searchParams.get('ocr_applied') || '');
    const [batchIdFilter, setBatchIdFilter] = useState(searchParams.get('batch_id') || '');
    const [batchNumLabel, setBatchNumLabel] = useState(searchParams.get('batch_num') || '');

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

    // Selection for batch operations
    const [selectedIds, setSelectedIds] = useState(new Set());

    // Batch Summarization
    const [showSummarizePanel, setShowSummarizePanel] = useState(false);
    const [summarizePrompt, setSummarizePrompt] = useState('Summarize in 200 chars');
    const [summarizeStatus, setSummarizeStatus] = useState('idle');
    const [summarizeProgress, setSummarizeProgress] = useState(0);
    const [summarizeTotal, setSummarizeTotal] = useState(0);
    const [summarizeTime, setSummarizeTime] = useState(0);

    // Create Batches
    const [showCreateBatchPanel, setShowCreateBatchPanel] = useState(false);
    const [batchSizeInput, setBatchSizeInput] = useState(100);
    const [creatingBatches, setCreatingBatches] = useState(false);

    // Table view
    const [viewMode, setViewMode] = useState('cards'); // 'cards' or 'table'
    const [sortField, setSortField] = useState(null);
    const [sortDir, setSortDir] = useState('asc');
    const [columnFilters, setColumnFilters] = useState({});

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
        setShouldRefresh(prev => prev + 1);
    };

    const removeSavedSearch = (id) => {
        const updated = savedSearches.filter(s => s.id !== id);
        setSavedSearches(updated);
        localStorage.setItem('sherlock_saved_searches', JSON.stringify(updated));
    };

    const navigate = useNavigate();

    const buildDocUrl = (docId) => {
        const ctx = buildSearchContextParams({
            query, reviewStatus, docType, scoreFilter, dateFrom, dateTo,
            hideDuplicates, latestThreadOnly, custodianFilter, ocrAppliedFilter,
            batchIdFilter, batchNumLabel, page: pagination?.page, pageSize,
            investigationId: activeInvestigationId,
        });
        const qs = ctx.toString();
        return `/documents/${docId}${qs ? `?${qs}` : ''}`;
    };

    // Load documents on mount — restore page from URL if present
    useEffect(() => {
        const initialPage = parseInt(searchParams.get('page')) || 1;
        doSearch(initialPage);
    }, []);

    // Fetch custodian list for filter dropdown
    useEffect(() => {
        if (!activeInvestigationId) return;
        apiFetch(`/api/investigations/${activeInvestigationId}/custodians`)
            .then(r => r.json())
            .then(data => setCustodianList(Array.isArray(data) ? data : []))
            .catch(() => {});
    }, [activeInvestigationId]);

    const hasActiveFilters = reviewStatus || docType || scoreFilter || dateFrom || dateTo || custodianFilter || ocrAppliedFilter;

    const doSearch = useCallback(async (page = 1) => {
        setLoading(true);
        setSearched(true);
        setSelectedIds(new Set());

        const apiParams = new URLSearchParams({ page, limit: pageSize });
        if (query.trim()) apiParams.set('q', query);
        if (reviewStatus) apiParams.set('review_status', reviewStatus);
        if (docType) apiParams.set('doc_type', docType);
        if (dateFrom) apiParams.set('date_from', dateFrom);
        if (dateTo) apiParams.set('date_to', dateTo);
        if (hideDuplicates) apiParams.set('hide_duplicates', '1');
        if (latestThreadOnly) apiParams.set('latest_thread_only', '1');
        if (custodianFilter) apiParams.set('custodian', custodianFilter);
        if (ocrAppliedFilter) apiParams.set('ocr_applied', ocrAppliedFilter);
        if (activeInvestigationId) apiParams.set('investigation_id', activeInvestigationId);
        if (batchIdFilter) apiParams.set('batch_id', batchIdFilter);

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
        if (ocrAppliedFilter) urlParams.ocr_applied = ocrAppliedFilter;
        if (batchIdFilter) { urlParams.batch_id = batchIdFilter; urlParams.batch_num = batchNumLabel; }
        if (page > 1) urlParams.page = String(page);
        if (pageSize !== 25) urlParams.per_page = String(pageSize);
        setSearchParams(urlParams, { replace: true });

        try {
            const res = await apiFetch(`/api/search?${apiParams}`);
            const data = await res.json();
            setResults(data.results);
            setPagination(data.pagination);
        } catch (err) {
            console.error('Search failed:', err);
            addToast('Search failed', 'error');
        }

        setLoading(false);
    }, [query, reviewStatus, docType, scoreFilter, dateFrom, dateTo, hideDuplicates, latestThreadOnly, custodianFilter, ocrAppliedFilter, batchIdFilter, hasActiveFilters, pageSize, setSearchParams]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') doSearch();
    };

    const [shouldRefresh, setShouldRefresh] = useState(0);
    const [lastNlQuery, setLastNlQuery] = useState('');
    const [showExamples, setShowExamples] = useState(false);

    const executeNlSearch = async () => {
        if (!query.trim()) return;
        const currentNlQuery = query.trim();
        setLoading(true);
        try {
            const res = await apiFetch('/api/search/nl-to-sql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            if (!res.ok) throw new Error("NLP translation failed");
            const parsed = await res.json();
            
            // Set the translated FTS parameters into the UI state, validating enum values
            const validDocTypes = ['email', 'chat', 'file', 'attachment'];
            setQuery(parsed.q || '');
            setDocType(validDocTypes.includes(parsed.docType) ? parsed.docType : '');
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
        setOcrAppliedFilter('');
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

    const ensureModelsLoaded = async () => {
        if (models.length === 0) {
            setModelsError('');
            try {
                const res = await apiFetch('/api/classify/models');
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
    };

    const toggleBatchPanel = async () => {
        if (!showBatchPanel) await ensureModelsLoaded();
        setShowBatchPanel(!showBatchPanel);
        if (!showBatchPanel) setShowSummarizePanel(false);
    };

    const toggleSummarizePanel = async () => {
        if (!showSummarizePanel) await ensureModelsLoaded();
        setShowSummarizePanel(!showSummarizePanel);
        if (!showSummarizePanel) setShowBatchPanel(false);
    };

    const startBatchClassify = async () => {
        if (!batchPrompt.trim() || !selectedModel || results.length === 0) return;

        localStorage.setItem('sherlock_investigation_prompt', batchPrompt);
        setBatchStatus('running');
        setBatchProgress(0);
        setBatchTime(0);

        try {
            const searchRes = await apiFetch(`/api/search?${buildSearchParams()}`);
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
                    await apiFetch(`/api/classify/${doc.id}`, {
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

    const buildSearchParams = () => {
        const params = new URLSearchParams({ page: 1, limit: 10000 });
        if (query.trim()) params.set('q', query);
        if (reviewStatus) params.set('review_status', reviewStatus);
        if (docType) params.set('doc_type', docType);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);
        if (hideDuplicates) params.set('hide_duplicates', '1');
        if (latestThreadOnly) params.set('latest_thread_only', '1');
        if (custodianFilter) params.set('custodian', custodianFilter);
        if (activeInvestigationId) params.set('investigation_id', activeInvestigationId);
        if (scoreFilter) {
            if (scoreFilter === 'unscored') params.set('score_min', 'unscored');
            else if (scoreFilter === 'scored') params.set('score_min', '1');
            else if (scoreFilter.endsWith('+')) params.set('score_min', scoreFilter.replace('+', ''));
            else { params.set('score_min', scoreFilter); params.set('score_max', scoreFilter); }
        }
        return params;
    };

    const startBatchSummarize = async () => {
        if (!summarizePrompt.trim() || !selectedModel || results.length === 0) return;

        setSummarizeStatus('running');
        setSummarizeProgress(0);
        setSummarizeTime(0);

        try {
            const searchRes = await apiFetch(`/api/search?${buildSearchParams()}`);
            const searchData = await searchRes.json();
            const allDocs = searchData.results || [];

            const docsToSummarize = selectedIds.size > 0
                ? allDocs.filter(d => selectedIds.has(d.id))
                : allDocs;

            if (docsToSummarize.length === 0) {
                setSummarizeStatus('done');
                return;
            }

            setSummarizeTotal(docsToSummarize.length);

            // Create job record
            const jobRes = await apiFetch('/api/summarize/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    investigationId: activeInvestigationId,
                    prompt: summarizePrompt.trim(),
                    model: selectedModel,
                    totalDocs: docsToSummarize.length,
                }),
            });
            const job = await jobRes.json();

            const startTime = Date.now();
            const timer = setInterval(() => {
                setSummarizeTime(Math.floor((Date.now() - startTime) / 1000));
            }, 1000);

            for (let i = 0; i < docsToSummarize.length; i++) {
                const doc = docsToSummarize[i];
                try {
                    await apiFetch(`/api/summarize/${doc.id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            prompt: summarizePrompt.trim(),
                            model: selectedModel,
                            jobId: job.id,
                        }),
                    });
                } catch (e) {
                    console.error('Failed to summarize doc', doc.id, e);
                }
                setSummarizeProgress(i + 1);
            }

            clearInterval(timer);
            const totalElapsed = Math.floor((Date.now() - startTime) / 1000);

            // Mark job complete
            await apiFetch(`/api/summarize/jobs/${job.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'completed',
                    processedDocs: docsToSummarize.length,
                    elapsedSeconds: totalElapsed,
                }),
            });

            setSummarizeStatus('done');
            setSelectedIds(new Set());
            addToast(`Summarized ${docsToSummarize.length} documents! View results in Summaries page.`, 'success');

        } catch (err) {
            console.error('Failed to run batch summarize', err);
            addToast('Batch summarization failed', 'error');
            setSummarizeStatus('idle');
        }
    };

    const getFileExt = (doc) => {
        if (doc.doc_type === 'email') return 'EML';
        if (doc.doc_type === 'chat') return 'Chat';
        const ext = doc.original_name?.split('.').pop()?.toUpperCase();
        return ext || 'FILE';
    };

    const getDocDate = (doc) => {
        const d = doc.primary_date || doc.email_date || doc.doc_created_at;
        if (!d) return '';
        return new Date(d).toLocaleDateString();
    };

    const truncate = (str, len) => {
        if (!str) return '';
        return str.length > len ? str.slice(0, len) + '…' : str;
    };

    const toggleSort = (field) => {
        if (sortField === field) {
            if (sortDir === 'asc') setSortDir('desc');
            else { setSortField(null); setSortDir('asc'); }
        } else {
            setSortField(field);
            setSortDir('asc');
        }
    };

    const setColFilter = (col, val) => {
        setColumnFilters(prev => ({ ...prev, [col]: val }));
    };

    const getFilteredSortedResults = () => {
        let filtered = results;
        const active = Object.entries(columnFilters).filter(([, v]) => v.trim());
        if (active.length > 0) {
            filtered = filtered.filter(r => {
                return active.every(([col, val]) => {
                    const v = val.toLowerCase();
                    const fieldMap = {
                        name: getDisplayName(r),
                        from: getFrom(r),
                        date: getDocDate(r),
                        custodian: r.custodian,
                        path: r.folder_path,
                        docId: r.doc_identifier,
                        type: getFileExt(r),
                    };
                    return (fieldMap[col] || '').toLowerCase().includes(v);
                });
            });
        }
        if (sortField) {
            const getter = {
                name: r => (getDisplayName(r) || '').toLowerCase(),
                from: r => (getFrom(r)).toLowerCase(),
                date: r => r.primary_date || r.email_date || r.doc_created_at || '',
                size: r => r.size_bytes || 0,
                textSize: r => r.text_content_size || 0,
                attachments: r => r.attachment_count || 0,
                recipients: r => r.recipient_count || 0,
                custodian: r => (r.custodian || '').toLowerCase(),
                score: r => r.ai_score || 0,
                path: r => (r.folder_path || '').toLowerCase(),
                docId: r => r.doc_identifier || '',
                type: r => getFileExt(r),
                status: r => r.review_status || '',
            }[sortField];
            if (getter) {
                filtered = [...filtered].sort((a, b) => {
                    const av = getter(a), bv = getter(b);
                    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
                    return sortDir === 'desc' ? -cmp : cmp;
                });
            }
        }
        return filtered;
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
        return doc.doc_title || doc.original_name;
    };

    const getFrom = (doc) => {
        return doc.email_from || doc.doc_author || '';
    };

    const exportCsv = async () => {
        try {
            const res = await apiFetch(`/api/search?${buildSearchParams()}`);
            const data = await res.json();
            let docs = data.results || [];

            if (selectedIds.size > 0) {
                docs = docs.filter(d => selectedIds.has(d.id));
            }

            if (docs.length === 0) {
                addToast('No results to export', 'error');
                return;
            }

            const csvEscape = (val) => {
                if (val == null) return '';
                const s = String(val);
                if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            };

            const getExt = (d) => {
                if (d.doc_type === 'email') return 'EML';
                if (d.doc_type === 'chat') return 'Chat';
                return d.original_name?.split('.').pop()?.toUpperCase() || 'FILE';
            };
            const getPrimaryDate = (d) => {
                const dt = d.primary_date || d.email_date || d.doc_created_at;
                return dt ? new Date(dt).toISOString() : '';
            };

            const headers = ['Doc ID', 'Type', 'Name', 'From', 'To', 'CC', 'Subject', 'Date', 'Size', 'Text Size', 'Attachments', 'Recipients', 'Path', 'Custodian', 'Review Status', 'AI Score', 'Tags'];
            const rows = docs.map(d => [
                d.doc_identifier || '',
                getExt(d),
                d.doc_type === 'email' || d.doc_type === 'chat' ? (d.email_subject || d.doc_title || d.original_name) : (d.doc_title || d.original_name),
                d.email_from || d.doc_author || '',
                d.email_to || '',
                d.email_cc || '',
                d.email_subject || d.doc_title || '',
                getPrimaryDate(d),
                d.size_bytes,
                d.text_content_size || 0,
                d.attachment_count ?? 0,
                d.recipient_count ?? 0,
                d.folder_path || '',
                d.custodian || '',
                d.review_status || '',
                d.ai_score || '',
                (d.tags || []).map(t => t.name).join('; '),
            ].map(csvEscape));

            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const caseName = (activeInvestigation?.name || 'all').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
            a.download = `${caseName}-export-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            addToast(`Exported ${docs.length} results to CSV`, 'success');
        } catch (err) {
            console.error('CSV export failed:', err);
            addToast('Failed to export CSV', 'error');
        }
    };

    const getSubline = (doc) => {
        const from = getFrom(doc);
        if (doc.doc_type === 'email') {
            const parts = [];
            if (from) parts.push(`From: ${from.split('<')[0].trim()}`);
            const d = getDocDate(doc);
            if (d) parts.push(d);
            return parts.join(' • ');
        }
        if (doc.doc_type === 'chat') {
            const parts = [];
            if (from) parts.push(`From: ${from}`);
            const d = getDocDate(doc);
            if (d) parts.push(d);
            return parts.join(' • ');
        }
        if (from) return `Author: ${from}`;
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
                <div style={{ position: 'absolute', right: '8px', top: '8px', display: 'flex', gap: '4px' }}>
                    <button
                        onClick={() => setShowExamples(true)}
                        style={{
                            background: 'transparent', color: 'var(--text-secondary)',
                            border: '1px solid var(--border)', borderRadius: '4px',
                            padding: '6px 8px', fontSize: '13px', cursor: 'pointer',
                            display: 'flex', alignItems: 'center'
                        }}
                        title="Search examples"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                        </svg>
                    </button>
                    <button
                        onClick={executeNlSearch}
                        disabled={loading || !query.trim()}
                        style={{
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
                        <option value="technical_issue">Technical Issue</option>
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
                            onChange={(e) => { setHideDuplicates(e.target.checked); setShouldRefresh(prev => prev + 1); }}
                            style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                        />
                        Hide Duplicates
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', userSelect: 'none', whiteSpace: 'nowrap' }}>
                        <input
                            type="checkbox"
                            checked={latestThreadOnly}
                            onChange={(e) => { setLatestThreadOnly(e.target.checked); setShouldRefresh(prev => prev + 1); }}
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
                    {batchIdFilter && (
                        <span className="status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', background: 'var(--accent-primary)', color: '#fff' }}>
                            Batch #{batchNumLabel || '?'}
                            <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => { setBatchIdFilter(''); setBatchNumLabel(''); setShouldRefresh(n => n + 1); }}>&times;</span>
                        </span>
                    )}
                    {ocrAppliedFilter && (
                        <span className="status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                            OCR Processed
                            <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => { setOcrAppliedFilter(''); setShouldRefresh(n => n + 1); }}>&times;</span>
                        </span>
                    )}
                    {results.length > 0 && (
                        <>
                            <button className="btn btn-secondary btn-sm" disabled title="Coming soon" style={{ marginLeft: 'auto', opacity: 0.5, cursor: 'not-allowed' }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px', marginRight: '5px' }}>
                                    <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" />
                                    <line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
                                </svg>
                                Batch Summarize
                            </button>
                            <button className="btn btn-secondary btn-sm" disabled title="Coming soon" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px', marginRight: '5px' }}>
                                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                                </svg>
                                Batch AI Classify
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setShowCreateBatchPanel(p => !p)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px', marginRight: '5px' }}>
                                    <rect x="2" y="3" width="20" height="5" rx="1" />
                                    <rect x="2" y="10" width="20" height="5" rx="1" />
                                    <rect x="2" y="17" width="20" height="5" rx="1" />
                                </svg>
                                Create Batches
                            </button>
                        </>
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

            {/* Create Batches Panel */}
            {showCreateBatchPanel && pagination && (
                <div className="card fade-in" style={{ marginBottom: '24px', border: '1px solid var(--primary)', background: 'var(--bg-tertiary)' }}>
                    <h3 style={{ marginTop: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '18px', height: '18px', color: 'var(--primary)' }}>
                            <rect x="2" y="3" width="20" height="5" rx="1" />
                            <rect x="2" y="10" width="20" height="5" rx="1" />
                            <rect x="2" y="17" width="20" height="5" rx="1" />
                        </svg>
                        Create Review Batches
                    </h3>
                    <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
                                <strong>{pagination.total}</strong> documents match the current search.
                                Split into batches for reviewer assignment.
                            </p>
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                <strong>Filters:</strong>{' '}
                                {[
                                    query && `"${query}"`,
                                    docType && `type: ${docType}`,
                                    reviewStatus && `status: ${reviewStatus}`,
                                    custodianFilter && `custodian: ${custodianFilter}`,
                                    (dateFrom || dateTo) && `${dateFrom || '...'} – ${dateTo || '...'}`,
                                    scoreFilter && `score: ${scoreFilter}`,
                                ].filter(Boolean).join(', ') || 'None (all documents)'}
                            </div>
                        </div>
                        <div style={{ width: '220px' }}>
                            <label className="text-sm text-secondary block mb-8">Batch Size</label>
                            <input type="number" min="1" max="10000" value={batchSizeInput}
                                onChange={e => setBatchSizeInput(Math.max(1, parseInt(e.target.value) || 1))}
                                style={{
                                    width: '100%', padding: '8px', borderRadius: '6px', fontSize: '14px',
                                    background: 'var(--bg-primary)', color: 'var(--text-primary)',
                                    border: '1px solid var(--border-primary)', marginBottom: '8px',
                                }}
                            />
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                Will create <strong>{Math.ceil(pagination.total / batchSizeInput)}</strong> batch{Math.ceil(pagination.total / batchSizeInput) !== 1 ? 'es' : ''} of {batchSizeInput} docs
                                {pagination.total % batchSizeInput !== 0 && ` (last: ${pagination.total % batchSizeInput})`}
                            </p>
                            <button className="btn btn-primary" style={{ width: '100%' }}
                                disabled={creatingBatches || pagination.total === 0}
                                onClick={async () => {
                                    setCreatingBatches(true);
                                    try {
                                        const searchCriteria = {
                                            q: query, review_status: reviewStatus, doc_type: docType,
                                            date_from: dateFrom, date_to: dateTo, custodian: custodianFilter,
                                            score_min: scoreFilter === 'unscored' ? 'unscored' : (scoreFilter ? scoreFilter.replace('+', '') : ''),
                                            hide_duplicates: hideDuplicates ? '1' : '0',
                                            latest_thread_only: latestThreadOnly ? '1' : '0',
                                            ocr_applied: ocrAppliedFilter || '',
                                        };
                                        const res = await apiPost('/api/batches', {
                                            investigation_id: activeInvestigationId,
                                            batch_size: batchSizeInput,
                                            search_criteria: searchCriteria,
                                        });
                                        const data = await res.json();
                                        if (!res.ok) { addToast(data.error || 'Failed to create batches', 'error'); return; }
                                        addToast(`${data.batches_created} batch${data.batches_created !== 1 ? 'es' : ''} created with ${data.total_documents} documents`, 'success');
                                        setShowCreateBatchPanel(false);
                                    } catch (err) {
                                        addToast('Failed to create batches', 'error');
                                    } finally {
                                        setCreatingBatches(false);
                                    }
                                }}
                            >
                                {creatingBatches ? 'Creating...' : 'Create Batches'}
                            </button>
                        </div>
                    </div>
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

            {/* Batch Summarization Panel */}
            {showSummarizePanel && (
                <div className="card fade-in" style={{ marginBottom: '24px', border: '1px solid var(--success)', background: 'var(--bg-tertiary)' }}>
                    <h3 style={{ marginTop: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '18px', height: '18px', color: 'var(--success)' }}>
                            <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" />
                            <line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
                        </svg>
                        Batch Summarization
                    </h3>

                    <div className="flex gap-16" style={{ alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                            <label className="text-sm text-secondary block mb-8">Summarization Prompt</label>
                            <textarea
                                className="textarea"
                                placeholder="Summarize in 200 chars"
                                value={summarizePrompt}
                                onChange={(e) => setSummarizePrompt(e.target.value)}
                                rows="3"
                                disabled={summarizeStatus === 'running'}
                            />
                        </div>
                        <div style={{ width: '250px' }}>
                            <label className="text-sm text-secondary block mb-8">AI Model</label>
                            {modelsError ? (
                                <div style={{ padding: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                                    <p style={{ color: 'var(--warning)', fontSize: '13px', margin: '0 0 8px 0' }}>Warning: {modelsError}</p>
                                    <button className="btn btn-secondary" style={{ width: '100%', fontSize: '12px' }} onClick={() => { setModels([]); setModelsError(''); setShowSummarizePanel(false); setTimeout(() => toggleSummarizePanel(), 100); }}>
                                        Retry
                                    </button>
                                </div>
                            ) : (
                                <select
                                    className="select"
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                    disabled={summarizeStatus === 'running'}
                                    style={{ width: '100%', marginBottom: '16px' }}
                                >
                                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                            )}

                            {summarizeStatus === 'idle' && (
                                <button
                                    className="btn btn-primary"
                                    style={{ width: '100%', background: 'var(--success)' }}
                                    onClick={startBatchSummarize}
                                    disabled={!summarizePrompt.trim()}
                                >
                                    {selectedIds.size > 0
                                        ? `Summarize ${selectedIds.size} Selected`
                                        : 'Summarize All Results'}
                                </button>
                            )}

                            {(summarizeStatus === 'running' || summarizeStatus === 'done') && (
                                <div style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-secondary)' }}>
                                    <div className="flex justify-between text-sm mb-4">
                                        <span style={{ fontWeight: 600 }}>{summarizeTotal > 0 ? Math.round((summarizeProgress / summarizeTotal) * 100) : 0}%</span>
                                        <span className="text-secondary">{summarizeProgress} / {summarizeTotal} docs</span>
                                    </div>
                                    <div style={{ height: '6px', background: 'var(--border-secondary)', borderRadius: '3px', overflow: 'hidden', marginBottom: '8px' }}>
                                        <div style={{ height: '100%', background: 'var(--success)', width: `${summarizeTotal > 0 ? (summarizeProgress / summarizeTotal) * 100 : 0}%`, transition: 'width 0.3s' }}></div>
                                    </div>
                                    <div className="text-xs text-tertiary flex justify-between">
                                        <span>{summarizeStatus === 'running' ? 'Summarizing...' : 'Complete!'}</span>
                                        <span>{Math.floor(summarizeTime / 60)}m {summarizeTime % 60}s</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="text-xs text-muted" style={{ marginTop: '10px', fontStyle: 'italic' }}>
                        Results will be available on the Summaries page after completion.
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
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
                                    <span className="text-sm text-muted">
                                        {pagination.total} result(s){query.trim() ? <> for "<strong style={{ color: 'var(--text-primary)' }}>{query}</strong>"</> : ' (filtered)'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <button className="btn btn-ghost btn-sm" onClick={exportCsv} title="Export results to CSV" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px' }}>
                                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                        </svg>
                                        Export CSV
                                    </button>
                                    <div className="view-toggle">
                                        <button className={`view-toggle-btn${viewMode === 'cards' ? ' active' : ''}`} onClick={() => setViewMode('cards')} title="Card view">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                                        </button>
                                        <button className={`view-toggle-btn${viewMode === 'table' ? ' active' : ''}`} onClick={() => setViewMode('table')} title="Table view">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            {viewMode === 'cards' ? (
                            <div className="search-results">
                                {results.map(r => (
                                    <div
                                        key={r.id}
                                        className="search-result-card"
                                        onClick={() => navigate(buildDocUrl(r.id))}
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
                                                <div className="search-result-title">
                                                    {r.doc_identifier && (
                                                        <span style={{
                                                            fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--primary)',
                                                            background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: '3px',
                                                            marginRight: '8px', fontWeight: 500
                                                        }}>{r.doc_identifier}</span>
                                                    )}
                                                    {getDisplayName(r)}
                                                </div>
                                                {getSubline(r) && (
                                                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{getSubline(r)}</div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="search-result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet ? r.snippet.replace(/<(?!\/?mark\b)[^>]*>/gi, '') : 'No preview available' }} />
                                        <div className="search-result-meta">
                                            <span>{formatSize(r.size_bytes)}</span>
                                            {r.text_content_size > 0 && (
                                                <>
                                                    <span>•</span>
                                                    <span title="Extracted text size">{formatSize(r.text_content_size)} text</span>
                                                </>
                                            )}
                                            <span>•</span>
                                            <span>{getDocDate(r) || 'No date'}</span>
                                            {r.folder_path && r.folder_path !== '/' && (
                                                <>
                                                    <span>•</span>
                                                    <span title="PST folder path" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>📁 {r.folder_path}</span>
                                                </>
                                            )}
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
                            ) : (
                            <div className="results-table-wrap">
                                <table className="results-table">
                                    <thead>
                                        <tr>
                                            <th style={{ width: '36px' }}></th>
                                            {[
                                                { key: 'type', label: 'Type', width: '70px' },
                                                { key: 'docId', label: 'Doc ID', width: '90px' },
                                                { key: 'name', label: 'Name', width: null },
                                                { key: 'from', label: 'From', width: '160px' },
                                                { key: 'date', label: 'Date', width: '100px' },
                                                { key: 'size', label: 'Size', width: '80px' },
                                                { key: 'textSize', label: 'Text', width: '70px' },
                                                { key: 'attachments', label: 'Attach', width: '60px' },
                                                { key: 'recipients', label: 'Recip', width: '60px' },
                                                { key: 'path', label: 'Path', width: '140px' },
                                                { key: 'custodian', label: 'Custodian', width: '110px' },
                                                { key: 'status', label: 'Status', width: '90px' },
                                                { key: 'score', label: 'Score', width: '60px' },
                                            ].map(col => (
                                                <th key={col.key} style={col.width ? { width: col.width } : {}} onClick={() => toggleSort(col.key)} className="sortable-th">
                                                    <div className="th-content">
                                                        <span>{col.label}</span>
                                                        {sortField === col.key && <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                                                    </div>
                                                </th>
                                            ))}
                                            <th style={{ width: '100px' }}>Tags</th>
                                        </tr>
                                        <tr className="filter-row">
                                            <td></td>
                                            {['type', 'docId', 'name', 'from', 'date', 'path', 'custodian'].map(col => (
                                                <td key={col} colSpan={col === 'date' ? 1 : 1}>
                                                    <input
                                                        className="table-column-filter"
                                                        placeholder="Filter…"
                                                        value={columnFilters[col] || ''}
                                                        onChange={e => setColFilter(col, e.target.value)}
                                                    />
                                                </td>
                                            ))}
                                            <td></td>
                                            <td></td>
                                            <td></td>
                                            <td></td>
                                            <td></td>
                                            <td></td>
                                            <td></td>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {getFilteredSortedResults().map(r => (
                                            <tr
                                                key={r.id}
                                                className={`results-table-row${selectedIds.has(r.id) ? ' selected' : ''}`}
                                                onClick={() => navigate(buildDocUrl(r.id))}
                                            >
                                                <td onClick={e => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.has(r.id)}
                                                        onChange={() => toggleSelect(r.id)}
                                                        style={{ width: '14px', height: '14px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                                                    />
                                                </td>
                                                <td><span className="type-cell">{getDocIcon(r)} {getFileExt(r)}</span></td>
                                                <td><span className="docid-cell">{r.doc_identifier || '—'}</span></td>
                                                <td className="name-cell" title={getDisplayName(r)}>{truncate(getDisplayName(r), 50)}</td>
                                                <td title={getFrom(r)}>{truncate(getFrom(r).split('<')[0]?.trim(), 20) || '—'}</td>
                                                <td>{getDocDate(r) || '—'}</td>
                                                <td>{formatSize(r.size_bytes)}</td>
                                                <td>{r.text_content_size ? formatSize(r.text_content_size) : '—'}</td>
                                                <td style={{ textAlign: 'center' }}>{r.attachment_count ?? 0}</td>
                                                <td style={{ textAlign: 'center' }}>{r.recipient_count ?? 0}</td>
                                                <td className="path-cell" title={r.folder_path || ''}>{truncate(r.folder_path, 20) || '—'}</td>
                                                <td title={r.custodian || ''}>{truncate(r.custodian, 14) || '—'}</td>
                                                <td><span className={`status-badge ${r.review_status}`}>{r.review_status?.replace('_', ' ') || '—'}</span></td>
                                                <td>{renderScoreBadge(r.ai_score)}</td>
                                                <td>
                                                    {r.tags?.length > 0
                                                        ? r.tags.map(t => (
                                                            <span key={t.id} className="tag-chip" style={{
                                                                background: `${t.color}20`, color: t.color, borderColor: `${t.color}40`,
                                                                fontSize: '10px', padding: '1px 5px', marginRight: '2px'
                                                            }}>{t.name}</span>
                                                        ))
                                                        : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            )}
                            <div className="pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                                {pagination.pages > 1 && (
                                    <>
                                        <button className="pagination-btn" disabled={pagination.page <= 1} onClick={() => doSearch(pagination.page - 1)}>← Previous</button>
                                        <span className="pagination-info">Page {pagination.page} of {pagination.pages}</span>
                                        <button className="pagination-btn" disabled={pagination.page >= pagination.pages} onClick={() => doSearch(pagination.page + 1)}>Next →</button>
                                    </>
                                )}
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', marginLeft: pagination.pages > 1 ? '12px' : '0' }}>
                                    Show
                                    <select
                                        value={pageSize}
                                        onChange={e => { setPageSize(Number(e.target.value)); setShouldRefresh(n => n + 1); }}
                                        style={{ padding: '4px 6px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '12px' }}
                                    >
                                        {[15, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                    per page
                                </label>
                            </div>
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
            {/* Examples Modal */}
            {showExamples && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }} onClick={() => setShowExamples(false)}>
                    <div style={{
                        background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                        padding: '24px', maxWidth: '560px', width: '90%', maxHeight: '80vh',
                        overflow: 'auto', border: '1px solid var(--border)'
                    }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0, fontSize: '16px' }}>Search Examples</h3>
                            <button onClick={() => setShowExamples(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--text-secondary)' }}>&times;</button>
                        </div>

                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                            Type a query and press Enter for direct FTS search, or click <strong>Ask AI</strong> to translate natural language into search filters.
                        </p>

                        <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                                <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-secondary)' }}>Direct Search (Enter)</div>
                                {[
                                    { q: 'cost', desc: 'Documents containing "cost"' },
                                    { q: '"project budget"', desc: 'Exact phrase match' },
                                    { q: 'email_from:"Atul"', desc: 'Emails from a specific sender' },
                                    { q: 'contract NOT renewal', desc: 'Exclude a term' },
                                    { q: 'merger OR acquisition', desc: 'Either term' },
                                ].map((ex, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border-secondary)' }}>
                                        <code style={{ background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', flexShrink: 0, cursor: 'pointer' }}
                                            onClick={() => { setQuery(ex.q); setShowExamples(false); }}
                                            title="Click to use"
                                        >{ex.q}</code>
                                        <span style={{ color: 'var(--text-secondary)' }}>{ex.desc}</span>
                                    </div>
                                ))}
                            </div>

                            <div>
                                <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-secondary)' }}>Ask AI (natural language)</div>
                                {[
                                    { q: 'all whatsapp chats', desc: 'Filters to chat type, no text search' },
                                    { q: 'emails from Atul to John in January 2022', desc: 'Sender, recipient, and date range' },
                                    { q: 'documents about cost', desc: 'Keyword search across all types' },
                                    { q: 'attachments from last month', desc: 'Type filter with date range' },
                                    { q: 'emails between Sandeep and Manoj without CC', desc: 'Targeted 1-to-1 email search' },
                                ].map((ex, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border-secondary)' }}>
                                        <code style={{ background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', flexShrink: 0, cursor: 'pointer' }}
                                            onClick={() => { setQuery(ex.q); setShowExamples(false); }}
                                            title="Click to use"
                                        >{ex.q}</code>
                                        <span style={{ color: 'var(--text-secondary)' }}>{ex.desc}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
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
