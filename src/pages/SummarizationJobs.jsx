import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function SummarizationJobs({ activeInvestigationId, addToast }) {
    const navigate = useNavigate();
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);

    // Results view
    const [selectedJob, setSelectedJob] = useState(null);
    const [results, setResults] = useState([]);
    const [resultsPagination, setResultsPagination] = useState(null);
    const [resultsLoading, setResultsLoading] = useState(false);

    // Modal state for viewing summaries
    const [viewingSummary, setViewingSummary] = useState(null);

    const loadJobs = useCallback(async () => {
        try {
            const params = activeInvestigationId ? `?investigation_id=${activeInvestigationId}` : '';
            const res = await fetch(`/api/summarize/jobs${params}`);
            const data = await res.json();
            setJobs(data.jobs || []);
        } catch (err) {
            console.error('Failed to load summarization jobs:', err);
        } finally {
            setLoading(false);
        }
    }, [activeInvestigationId]);

    useEffect(() => {
        loadJobs();
    }, [loadJobs]);

    // Poll running jobs
    useEffect(() => {
        const hasRunning = jobs.some(j => j.status === 'running');
        if (!hasRunning) return;
        const interval = setInterval(loadJobs, 3000);
        return () => clearInterval(interval);
    }, [jobs, loadJobs]);

    const loadResults = async (job, page = 1) => {
        setSelectedJob(job);
        setResultsLoading(true);
        try {
            const res = await fetch(`/api/summarize/jobs/${job.id}/results?page=${page}&limit=50`);
            const data = await res.json();
            setResults(data.results || []);
            setResultsPagination(data.pagination);
        } catch (err) {
            console.error('Failed to load results:', err);
        } finally {
            setResultsLoading(false);
        }
    };

    const deleteJob = async (jobId, e) => {
        e.stopPropagation();
        try {
            await fetch(`/api/summarize/jobs/${jobId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'failed' }),
            });
            addToast('Job removed', 'info');
            loadJobs();
        } catch (err) {
            console.error('Failed to delete job:', err);
        }
    };

    const getStatusBadge = (status) => {
        const colors = {
            pending: { bg: '#6b728018', color: '#6b7280', border: '#6b728030' },
            running: { bg: '#3b82f618', color: '#3b82f6', border: '#3b82f630' },
            completed: { bg: '#10b98118', color: '#10b981', border: '#10b98130' },
            failed: { bg: '#ef444418', color: '#ef4444', border: '#ef444430' },
        };
        const c = colors[status] || colors.pending;
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '4px',
                padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600,
                background: c.bg, color: c.color, border: `1px solid ${c.border}`,
            }}>
                {status === 'running' && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: c.color, animation: 'pulse 1.5s infinite' }}></span>}
                {status}
            </span>
        );
    };

    const formatElapsed = (seconds) => {
        if (!seconds) return '-';
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const getEta = (job) => {
        if (job.status !== 'running' || !job.processed_docs || !job.elapsed_seconds) return null;
        const rate = job.elapsed_seconds / job.processed_docs;
        const remaining = (job.total_docs - job.processed_docs) * rate;
        return formatElapsed(remaining);
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '-';
        return new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z')).toLocaleString();
    };

    // Results view
    if (selectedJob) {
        return (
            <div>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setSelectedJob(null); setResults([]); }}
                    style={{ marginBottom: '16px' }}
                >
                    &larr; Back to Jobs
                </button>

                <div className="card" style={{ marginBottom: '24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <h3 style={{ margin: 0 }}>Job Results</h3>
                        {getStatusBadge(selectedJob.status)}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', fontSize: '13px' }}>
                        <div>
                            <span className="text-secondary">Prompt: </span>
                            <span style={{ fontStyle: 'italic' }}>{selectedJob.prompt}</span>
                        </div>
                        <div>
                            <span className="text-secondary">Model: </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{selectedJob.model}</span>
                        </div>
                        <div>
                            <span className="text-secondary">Documents: </span>
                            <span>{selectedJob.processed_docs} / {selectedJob.total_docs}</span>
                        </div>
                        <div>
                            <span className="text-secondary">Elapsed: </span>
                            <span>{formatElapsed(selectedJob.elapsed_seconds)}</span>
                        </div>
                    </div>
                </div>

                {resultsLoading ? (
                    <div className="loading-overlay"><div className="spinner"></div></div>
                ) : results.length === 0 ? (
                    <div className="empty-state">
                        <p className="empty-state-text">No results yet.</p>
                    </div>
                ) : (
                    <>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="table" style={{ width: '100%', fontSize: '13px' }}>
                                <thead>
                                    <tr>
                                        <th style={{ width: '130px', whiteSpace: 'nowrap' }}>Doc ID</th>
                                        <th style={{ width: '140px', whiteSpace: 'nowrap' }}>Date</th>
                                        <th style={{ width: '160px' }}>From</th>
                                        <th style={{ width: '160px' }}>To</th>
                                        <th>Summary</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.map(r => (
                                        <tr key={r.id} onClick={() => navigate(`/documents/${r.document_id}`)} style={{ cursor: 'pointer' }}>
                                            <td>
                                                <span style={{
                                                    fontFamily: 'var(--font-mono)', fontSize: '11px',
                                                    padding: '1px 6px', borderRadius: '4px',
                                                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                                                    whiteSpace: 'nowrap',
                                                }}>
                                                    {r.doc_identifier || r.document_id.substring(0, 8)}
                                                </span>
                                            </td>
                                            <td style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                                {r.email_date ? new Date(r.email_date).toLocaleDateString() : '-'}
                                            </td>
                                            <td style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                                {r.email_from || r.original_name || '-'}
                                            </td>
                                            <td style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                                {r.email_to || '-'}
                                            </td>
                                            <td style={{ fontSize: '12px', lineHeight: '1.4', color: 'var(--text-primary)' }}>
                                                {r.summary ? (
                                                    <span 
                                                        style={{ color: 'var(--primary)', textDecoration: 'underline' }}
                                                        onClick={(e) => { e.stopPropagation(); setViewingSummary(r.summary); }}
                                                    >
                                                        View Summary
                                                    </span>
                                                ) : <span className="text-muted">No summary</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {resultsPagination && resultsPagination.pages > 1 && (
                            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                                <button
                                    className="btn btn-ghost btn-sm"
                                    disabled={resultsPagination.page <= 1}
                                    onClick={() => loadResults(selectedJob, resultsPagination.page - 1)}
                                >
                                    Previous
                                </button>
                                <span className="text-sm text-secondary">
                                    Page {resultsPagination.page} of {resultsPagination.pages} ({resultsPagination.total} results)
                                </span>
                                <button
                                    className="btn btn-ghost btn-sm"
                                    disabled={resultsPagination.page >= resultsPagination.pages}
                                    onClick={() => loadResults(selectedJob, resultsPagination.page + 1)}
                                >
                                    Next
                                </button>
                            </div>
                        )}
                    </>
                )}

                {/* Markdown Summary Modal */}
                {viewingSummary && (
                    <div className="modal-overlay" onClick={() => setViewingSummary(null)}>
                        <div className="modal" style={{ maxWidth: '800px', width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <h2 style={{ margin: 0 }}>Document Summary</h2>
                                <button className="btn btn-ghost btn-sm" onClick={() => setViewingSummary(null)}>✕</button>
                            </div>
                            <div style={{ 
                                overflowY: 'auto', 
                                paddingRight: '10px',
                                fontSize: '14px',
                                lineHeight: '1.6',
                                color: 'var(--text-secondary)'
                            }}>
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        h1: ({node, ...props}) => <h1 style={{ color: 'var(--text-primary)', marginTop: '20px', marginBottom: '10px', fontSize: '1.4em' }} {...props} />,
                                        h2: ({node, ...props}) => <h2 style={{ color: 'var(--text-primary)', marginTop: '16px', marginBottom: '8px', fontSize: '1.2em' }} {...props} />,
                                        h3: ({node, ...props}) => <h3 style={{ color: 'var(--text-primary)', marginTop: '14px', marginBottom: '8px', fontSize: '1.1em' }} {...props} />,
                                        p: ({node, ...props}) => <p style={{ marginBottom: '12px' }} {...props} />,
                                        ul: ({node, ...props}) => <ul style={{ marginBottom: '12px', paddingLeft: '20px' }} {...props} />,
                                        ol: ({node, ...props}) => <ol style={{ marginBottom: '12px', paddingLeft: '20px' }} {...props} />,
                                        li: ({node, ...props}) => <li style={{ marginBottom: '4px' }} {...props} />,
                                        strong: ({node, ...props}) => <strong style={{ color: 'var(--text-primary)' }} {...props} />,
                                        blockquote: ({node, ...props}) => <blockquote style={{ borderLeft: '3px solid var(--primary)', paddingLeft: '12px', margin: '12px 0', color: 'var(--text-tertiary)', fontStyle: 'italic' }} {...props} />,
                                        table: ({node, ...props}) => (
                                            <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }} {...props} />
                                            </div>
                                        ),
                                        thead: ({node, ...props}) => <thead style={{ borderBottom: '2px solid var(--border-secondary)' }} {...props} />,
                                        th: ({node, ...props}) => <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }} {...props} />,
                                        td: ({node, ...props}) => <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', color: 'var(--text-secondary)' }} {...props} />,
                                        tr: ({node, ...props}) => <tr style={{ borderBottom: '1px solid var(--border-secondary)' }} {...props} />,
                                        hr: ({node, ...props}) => <hr style={{ border: 'none', borderTop: '1px solid var(--border-secondary)', margin: '16px 0' }} {...props} />,
                                        code: ({node, inline, ...props}) => inline
                                            ? <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'var(--font-mono)' }} {...props} />
                                            : <pre style={{ background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '8px', overflowX: 'auto', fontSize: '12px', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}><code {...props} /></pre>,
                                    }}
                                >
                                    {viewingSummary}
                                </ReactMarkdown>
                            </div>
                            <div className="modal-actions">
                                <button className="btn btn-secondary" onClick={() => setViewingSummary(null)}>Close</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Jobs list view
    return (
        <div>
            {loading ? (
                <div className="loading-overlay"><div className="spinner"></div></div>
            ) : jobs.length === 0 ? (
                <div className="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '48px', height: '48px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                        <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" />
                        <line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
                    </svg>
                    <h3 className="empty-state-title">No summarization jobs</h3>
                    <p className="empty-state-text">Use "Batch Summarize" on the Analyze page to create your first summarization job.</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {jobs.map(job => {
                        const progress = job.total_docs > 0 ? Math.round((job.processed_docs / job.total_docs) * 100) : 0;
                        const eta = getEta(job);

                        return (
                            <div
                                key={job.id}
                                className="card"
                                onClick={() => job.status === 'completed' ? loadResults(job) : null}
                                style={{
                                    cursor: job.status === 'completed' ? 'pointer' : 'default',
                                    transition: 'border-color 0.2s',
                                    border: job.status === 'completed' ? '1px solid var(--border-secondary)' : undefined,
                                }}
                                onMouseEnter={e => { if (job.status === 'completed') e.currentTarget.style.borderColor = 'var(--primary)'; }}
                                onMouseLeave={e => { if (job.status === 'completed') e.currentTarget.style.borderColor = 'var(--border-secondary)'; }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        {getStatusBadge(job.status)}
                                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                            {job.model}
                                        </span>
                                    </div>
                                    <span className="text-xs text-muted">{formatDate(job.started_at)}</span>
                                </div>

                                <div style={{ fontSize: '13px', marginBottom: '10px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                    "{job.prompt}"
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px' }}>
                                    <span>
                                        <span className="text-secondary">Docs: </span>
                                        <strong>{job.processed_docs}</strong> / {job.total_docs}
                                    </span>
                                    <span>
                                        <span className="text-secondary">Elapsed: </span>
                                        {formatElapsed(job.elapsed_seconds)}
                                    </span>
                                    {eta && (
                                        <span>
                                            <span className="text-secondary">ETA: </span>
                                            ~{eta}
                                        </span>
                                    )}
                                    {job.status === 'completed' && (
                                        <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--primary)' }}>
                                            Click to view results &rarr;
                                        </span>
                                    )}
                                </div>

                                {job.status === 'running' && (
                                    <div style={{ marginTop: '10px' }}>
                                        <div style={{ height: '6px', background: 'var(--border-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                                            <div style={{
                                                height: '100%', background: 'var(--primary)',
                                                width: `${progress}%`, transition: 'width 0.3s',
                                            }}></div>
                                        </div>
                                        <div className="text-xs text-tertiary" style={{ marginTop: '4px', textAlign: 'right' }}>
                                            {progress}%
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default SummarizationJobs;
