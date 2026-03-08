import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function ClassificationLogs() {
    const [logs, setLogs] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        loadLogs(1);
    }, []);

    const loadLogs = async (page) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/classify/logs?page=${page}&limit=20`);
            const data = await res.json();
            setLogs(data.logs || []);
            setPagination(data.pagination);
        } catch (err) {
            console.error('Failed to load logs:', err);
        }
        setLoading(false);
    };

    const getScoreColor = (score) => {
        const colors = { 1: '#6b7280', 2: '#3b82f6', 3: '#f59e0b', 4: '#f97316', 5: '#ef4444' };
        return colors[score] || '#6b7280';
    };

    const renderScoreBadge = (score) => {
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
    };

    return (
        <div className="fade-in" style={{ paddingBottom: '40px' }}>
            <div className="flex justify-between items-center mb-24">
                <h2 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>AI Activity Logs</h2>
            </div>

            <p className="text-secondary mb-24" style={{ fontSize: '14px', maxWidth: '800px' }}>
                A complete history of every AI classification run across your Sherlock deployment. Click any row to view the full document and its complete AI reasoning.
            </p>

            {loading ? (
                <div className="loading-overlay" style={{ height: '300px' }}><div className="spinner"></div></div>
            ) : logs.length > 0 ? (
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <table className="data-table" style={{ fontSize: '13px' }}>
                        <thead>
                            <tr>
                                <th style={{ width: '140px' }}>Date</th>
                                <th style={{ width: '25%' }}>Document</th>
                                <th>Model & Prompt</th>
                                <th style={{ width: '100px', textAlign: 'center' }}>Score</th>
                                <th style={{ width: '80px', textAlign: 'right' }}>Time</th>
                                <th style={{ width: '25%' }}>AI Reasoning Snippet</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <tr key={log.id} onClick={() => navigate(`/documents/${log.document_id}`)} style={{ cursor: 'pointer' }}>
                                    <td className="text-muted">
                                        {new Date(log.classified_at).toLocaleString([], {
                                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                                        })}
                                    </td>
                                    <td>
                                        <div style={{ fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">
                                            {log.email_subject || log.original_name || 'Unknown Document'}
                                        </div>
                                        <div className="text-muted text-xs truncate" style={{ marginTop: '2px' }}>
                                            {log.doc_type === 'email' ? 'Email' : 'File'} • ID: {log.document_id.substring(0, 8)}...
                                        </div>
                                    </td>
                                    <td>
                                        <div style={{ fontWeight: 500, color: 'var(--text-secondary)' }} className="truncate">
                                            {log.model}
                                        </div>
                                        <div className="text-muted text-xs truncate" style={{ marginTop: '2px', maxWidth: '200px' }}>
                                            "{log.investigation_prompt}"
                                        </div>
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                        {renderScoreBadge(log.score)}
                                    </td>
                                    <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                                        {log.elapsed_seconds ? `${log.elapsed_seconds}s` : '—'}
                                    </td>
                                    <td>
                                        <div className="truncate" style={{ maxWidth: '250px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                            {log.reasoning}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <h3 className="empty-state-title">No AI Activity Found</h3>
                    <p className="empty-state-text">No documents have been classified by the AI yet.</p>
                </div>
            )}

            {pagination && pagination.pages > 1 && (
                <div className="pagination" style={{ marginTop: '24px' }}>
                    <button className="pagination-btn" disabled={pagination.page <= 1} onClick={() => loadLogs(pagination.page - 1)}>← Previous</button>
                    <span className="pagination-info">Page {pagination.page} of {pagination.pages}</span>
                    <button className="pagination-btn" disabled={pagination.page >= pagination.pages} onClick={() => loadLogs(pagination.page + 1)}>Next →</button>
                </div>
            )}
        </div>
    );
}

export default ClassificationLogs;
