import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

function Search() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    // Filters
    const [reviewStatus, setReviewStatus] = useState('');
    const [docType, setDocType] = useState('');
    const [scoreFilter, setScoreFilter] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    // All documents view (when no search query)
    const [documents, setDocuments] = useState([]);
    const [docPagination, setDocPagination] = useState(null);
    const [docPage, setDocPage] = useState(1);

    const navigate = useNavigate();

    // Load all documents on mount
    useEffect(() => {
        loadDocuments(1);
    }, []);

    const loadDocuments = async (page) => {
        try {
            const res = await fetch(`/api/documents?page=${page}&limit=15`);
            const data = await res.json();
            setDocuments(data.documents);
            setDocPagination(data.pagination);
            setDocPage(page);
        } catch (err) {
            console.error('Failed to load documents:', err);
        }
    };

    const doSearch = useCallback(async (page = 1) => {
        if (!query.trim()) return;

        setLoading(true);
        setSearched(true);

        const params = new URLSearchParams({ q: query, page, limit: 15 });
        if (reviewStatus) params.set('review_status', reviewStatus);
        if (docType) params.set('doc_type', docType);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);

        try {
            const res = await fetch(`/api/search?${params}`);
            const data = await res.json();
            setResults(data.results);
            setPagination(data.pagination);
        } catch (err) {
            console.error('Search failed:', err);
        }

        setLoading(false);
    }, [query, reviewStatus, docType, dateFrom, dateTo]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') doSearch();
    };

    const clearSearch = () => {
        setQuery('');
        setSearched(false);
        setResults([]);
        setPagination(null);
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
                {searched && <button className="btn btn-ghost" onClick={clearSearch}>Clear</button>}
            </div>

            {/* Search Results */}
            {searched ? (
                <>
                    {loading ? (
                        <div className="loading-overlay"><div className="spinner"></div></div>
                    ) : results.length > 0 ? (
                        <>
                            <div className="text-sm text-muted mb-16">
                                {pagination.total} result(s) for "<strong style={{ color: 'var(--text-primary)' }}>{query}</strong>"
                            </div>
                            <div className="search-results">
                                {results.map(r => (
                                    <div key={r.id} className="search-result-card" onClick={() => navigate(`/documents/${r.id}`)}>
                                        <div className="flex items-center gap-8">
                                            <span style={{ fontSize: '18px' }}>{getDocIcon(r)}</span>
                                            <div style={{ flex: 1 }}>
                                                <div className="search-result-title">{getDisplayName(r)}</div>
                                                {getSubline(r) && (
                                                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{getSubline(r)}</div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="search-result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet || 'No preview available' }} />
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
            ) : (
                /* All Documents Table */
                <>
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        All Documents
                    </h3>
                    {documents.length > 0 ? (
                        <>
                            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th></th>
                                            <th>Name / Subject</th>
                                            <th>From</th>
                                            <th>Size</th>
                                            <th>Status</th>
                                            <th>Review</th>
                                            <th>AI Score</th>
                                            <th>Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {documents.map(doc => (
                                            <tr key={doc.id} onClick={() => navigate(`/documents/${doc.id}`)}>
                                                <td style={{ width: '30px', textAlign: 'center', fontSize: '16px' }}>{getDocIcon(doc)}</td>
                                                <td className="doc-name" style={{ maxWidth: '300px' }}>
                                                    <span className="truncate" style={{ display: 'block' }}>{getDisplayName(doc)}</span>
                                                    {doc.doc_type === 'email' && doc.attachment_count > 0 && (
                                                        <span className="text-sm text-muted">📎 {doc.attachment_count}</span>
                                                    )}
                                                </td>
                                                <td className="text-sm truncate" style={{ maxWidth: '180px', color: 'var(--text-secondary)' }}>
                                                    {doc.email_from ? doc.email_from.split('<')[0].trim() : '—'}
                                                </td>
                                                <td>{formatSize(doc.size_bytes)}</td>
                                                <td><span className={`status-badge ${doc.status}`}>{doc.status}</span></td>
                                                <td>
                                                    <span className={`status-badge ${doc.review_status || 'pending'}`}>
                                                        {(doc.review_status || 'pending').replace('_', ' ')}
                                                    </span>
                                                </td>
                                                <td>{renderScoreBadge(doc.ai_score)}</td>
                                                <td className="text-muted text-sm">
                                                    {doc.email_date
                                                        ? new Date(doc.email_date).toLocaleDateString()
                                                        : new Date(doc.uploaded_at).toLocaleDateString()}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {docPagination && docPagination.pages > 1 && (
                                <div className="pagination">
                                    <button className="pagination-btn" disabled={docPage <= 1} onClick={() => loadDocuments(docPage - 1)}>← Previous</button>
                                    <span className="pagination-info">Page {docPage} of {docPagination.pages}</span>
                                    <button className="pagination-btn" disabled={docPage >= docPagination.pages} onClick={() => loadDocuments(docPage + 1)}>Next →</button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="empty-state">
                            <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <h3 className="empty-state-title">No documents yet</h3>
                            <p className="empty-state-text">Upload your first document to get started.</p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function formatSize(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export default Search;

function getScoreColor(score) {
    const colors = { 1: '#6b7280', 2: '#3b82f6', 3: '#f59e0b', 4: '#f97316', 5: '#ef4444' };
    return colors[score] || '#6b7280';
}

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
