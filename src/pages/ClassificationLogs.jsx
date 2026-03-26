import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getScoreColor } from '../utils/format';

function ClassificationLogs({ activeInvestigationId }) {
    const [activeTab, setActiveTab] = useState('logs');
    const [logs, setLogs] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const navigate = useNavigate();

    // Comparison state
    const [prompts, setPrompts] = useState([]);
    const [selectedPrompt, setSelectedPrompt] = useState('');
    const [comparison, setComparison] = useState(null);
    const [compLoading, setCompLoading] = useState(false);

    useEffect(() => {
        loadLogs(1);
    }, [activeInvestigationId]);

    const loadLogs = async (page) => {
        setLoading(true);
        if (!activeInvestigationId) {
            setLogs([]);
            setPagination(null);
            setLoading(false);
            return;
        }
        try {
            const res = await fetch(`/api/classify/logs?page=${page}&limit=20&investigation_id=${activeInvestigationId}`);
            const data = await res.json();
            setLogs(data.logs || []);
            setPagination(data.pagination);
        } catch (err) {
            console.error('Failed to load logs:', err);
            setError('Failed to load classification logs');
        }
        setLoading(false);
    };

    const loadPrompts = async () => {
        try {
            const res = await fetch('/api/classify/compare/prompts');
            const data = await res.json();
            setPrompts(data.prompts || []);
            if (data.prompts?.length > 0 && !selectedPrompt) {
                setSelectedPrompt(data.prompts[0].investigation_prompt);
                loadComparison(data.prompts[0].investigation_prompt);
            }
        } catch (err) {
            console.error('Failed to load prompts:', err);
        }
    };

    const loadComparison = async (prompt) => {
        if (!prompt) return;
        setCompLoading(true);
        try {
            const res = await fetch(`/api/classify/compare?prompt=${encodeURIComponent(prompt)}`);
            const data = await res.json();
            setComparison(data);
        } catch (err) {
            console.error('Failed to load comparison:', err);
        }
        setCompLoading(false);
    };

    const handleTabChange = (tab) => {
        setActiveTab(tab);
        if (tab === 'compare' && prompts.length === 0) {
            loadPrompts();
        }
    };

    const handlePromptChange = (prompt) => {
        setSelectedPrompt(prompt);
        loadComparison(prompt);
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

    const renderLogsTab = () => {
        if (loading) return <div className="loading-overlay" style={{ height: '300px' }}><div className="spinner"></div></div>;
        if (error) return <div className="empty-state"><h3 className="empty-state-title">Error</h3><p className="empty-state-text">{error}</p></div>;
        if (logs.length === 0) return (
            <div className="empty-state">
                <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                </svg>
                <h3 className="empty-state-title">No AI Activity Found</h3>
                <p className="empty-state-text">No documents have been classified by the AI yet.</p>
            </div>
        );

        return (
            <>
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
                {pagination && pagination.pages > 1 && (
                    <div className="pagination" style={{ marginTop: '24px' }}>
                        <button className="pagination-btn" disabled={pagination.page <= 1} onClick={() => loadLogs(pagination.page - 1)}>← Previous</button>
                        <span className="pagination-info">Page {pagination.page} of {pagination.pages}</span>
                        <button className="pagination-btn" disabled={pagination.page >= pagination.pages} onClick={() => loadLogs(pagination.page + 1)}>Next →</button>
                    </div>
                )}
            </>
        );
    };

    const renderCompareTab = () => {
        if (compLoading) return <div className="loading-overlay" style={{ height: '300px' }}><div className="spinner"></div></div>;

        if (prompts.length === 0 && !compLoading) {
            return (
                <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <h3 className="empty-state-title">No Comparisons Available</h3>
                    <p className="empty-state-text">
                        Run batch classification on the same documents with two different models using the same investigation prompt.
                        Then come back here to compare results.
                    </p>
                </div>
            );
        }

        const modelNames = comparison ? Object.keys(comparison.models) : [];

        return (
            <div>
                {/* Prompt selector */}
                <div className="card" style={{ padding: '16px', marginBottom: '20px' }}>
                    <label className="text-sm text-secondary block mb-8">Investigation Prompt</label>
                    <select
                        className="select"
                        value={selectedPrompt}
                        onChange={e => handlePromptChange(e.target.value)}
                        style={{ width: '100%', maxWidth: '600px' }}
                    >
                        {prompts.map(p => (
                            <option key={p.investigation_prompt} value={p.investigation_prompt}>
                                {p.investigation_prompt} ({p.model_count} models, {p.total_runs} runs)
                            </option>
                        ))}
                    </select>
                </div>

                {comparison && (
                    <>
                        {/* Summary cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${modelNames.length + 1}, 1fr)`, gap: '16px', marginBottom: '20px' }}>
                            {modelNames.map(model => (
                                <div key={model} className="card" style={{ padding: '16px' }}>
                                    <div className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: '8px' }}>{model}</div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                        <div>
                                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                                {comparison.models[model].avg_time}s
                                            </div>
                                            <div className="text-xs text-muted">avg time</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                                {comparison.models[model].avg_score}
                                            </div>
                                            <div className="text-xs text-muted">avg score</div>
                                        </div>
                                    </div>
                                    <div style={{ marginTop: '12px', display: 'flex', gap: '4px' }}>
                                        {[1,2,3,4,5].map(s => {
                                            const count = comparison.models[model].score_distribution[String(s)] || 0;
                                            const color = getScoreColor(s);
                                            return count > 0 ? (
                                                <span key={s} style={{
                                                    fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                                                    background: `${color}18`, color: color, border: `1px solid ${color}30`,
                                                }}>
                                                    {s}×{count}
                                                </span>
                                            ) : null;
                                        })}
                                    </div>
                                </div>
                            ))}
                            <div className="card" style={{ padding: '16px' }}>
                                <div className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: '8px' }}>Agreement</div>
                                <div style={{ fontSize: '28px', fontWeight: 700, color: comparison.agreement_rate >= 0.7 ? 'var(--success)' : comparison.agreement_rate >= 0.4 ? 'var(--warning)' : 'var(--danger)' }}>
                                    {(comparison.agreement_rate * 100).toFixed(0)}%
                                </div>
                                <div className="text-xs text-muted">{comparison.total} docs compared</div>
                            </div>
                        </div>

                        {/* Per-document comparison table */}
                        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                            <table className="data-table" style={{ fontSize: '13px' }}>
                                <thead>
                                    <tr>
                                        <th style={{ width: '30%' }}>Document</th>
                                        {modelNames.map(m => (
                                            <th key={m} style={{ textAlign: 'center' }}>{m}</th>
                                        ))}
                                        <th style={{ width: '80px', textAlign: 'center' }}>Delta</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {comparison.comparisons.map(row => (
                                        <tr
                                            key={row.document_id}
                                            onClick={() => navigate(`/documents/${row.document_id}`)}
                                            style={{
                                                cursor: 'pointer',
                                                background: row.disagree ? 'rgba(255, 170, 50, 0.04)' : undefined
                                            }}
                                        >
                                            <td>
                                                <div style={{ fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">
                                                    {row.email_subject || row.original_name || 'Unknown'}
                                                </div>
                                                <div className="text-muted text-xs">
                                                    {row.doc_type === 'email' ? 'Email' : row.doc_type === 'attachment' ? 'Attachment' : 'File'}
                                                </div>
                                            </td>
                                            {modelNames.map(m => {
                                                const s = row.scores[m];
                                                return (
                                                    <td key={m} style={{ textAlign: 'center', verticalAlign: 'top' }}>
                                                        {s ? (
                                                            <div>
                                                                {renderScoreBadge(s.score)}
                                                                <div className="text-muted text-xs" style={{ marginTop: '4px' }}>{s.elapsed}s</div>
                                                                <div className="truncate text-xs" style={{ maxWidth: '180px', marginTop: '2px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                                                    {s.reasoning}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <span className="text-muted">—</span>
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            <td style={{ textAlign: 'center' }}>
                                                {row.disagree ? (
                                                    <span style={{
                                                        fontSize: '12px', fontWeight: 600,
                                                        color: row.score_diff >= 3 ? 'var(--danger)' : row.score_diff >= 2 ? 'var(--warning)' : 'var(--text-secondary)'
                                                    }}>
                                                        ±{row.score_diff}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: 'var(--success)', fontSize: '12px' }}>✓</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        );
    };

    return (
        <div className="fade-in" style={{ paddingBottom: '40px' }}>
            <div className="flex justify-between items-center mb-24">
                <h2 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>AI Activity Logs</h2>
            </div>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '1px solid var(--border-primary)' }}>
                <button
                    onClick={() => handleTabChange('logs')}
                    style={{
                        padding: '8px 20px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                        background: 'none', border: 'none', color: activeTab === 'logs' ? 'var(--text-accent)' : 'var(--text-secondary)',
                        borderBottom: activeTab === 'logs' ? '2px solid var(--text-accent)' : '2px solid transparent',
                        marginBottom: '-1px',
                    }}
                >
                    Activity Log
                </button>
                <button
                    onClick={() => handleTabChange('compare')}
                    style={{
                        padding: '8px 20px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                        background: 'none', border: 'none', color: activeTab === 'compare' ? 'var(--text-accent)' : 'var(--text-secondary)',
                        borderBottom: activeTab === 'compare' ? '2px solid var(--text-accent)' : '2px solid transparent',
                        marginBottom: '-1px',
                    }}
                >
                    Model Comparison
                </button>
            </div>

            {activeTab === 'logs' ? renderLogsTab() : renderCompareTab()}
        </div>
    );
}

export default ClassificationLogs;
