import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatSize } from '../utils/format';

function Dashboard({ activeInvestigationId, activeInvestigation, addToast }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        if (!activeInvestigationId) return;
        fetch(`/api/reviews/stats?investigation_id=${activeInvestigationId}`)
            .then(r => {
                if (!r.ok) throw new Error('Failed to load dashboard');
                return r.json();
            })
            .then(data => { setStats(data); setLoading(false); })
            .catch(err => { setError(err.message); setLoading(false); });
    }, [activeInvestigationId]);

    if (!activeInvestigationId) {
        return (
            <div className="empty-state">
                <h3 className="empty-state-title">No Investigation Selected</h3>
                <p className="empty-state-text">Please select or create an investigation to view its dashboard.</p>
                <Link to="/investigations" className="btn btn-primary mt-16">Manage Investigations</Link>
            </div>
        );
    }

    if (loading) {
        return <div className="loading-overlay"><div className="spinner"></div></div>;
    }

    if (error || !stats) {
        return (
            <div className="empty-state">
                <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h3 className="empty-state-title">Unable to load dashboard</h3>
                <p className="empty-state-text">{error || 'Make sure the server is running on port 3001.'}</p>
            </div>
        );
    }

    const inv = activeInvestigation || {};
    const typeMap = {};
    (stats.type_breakdown || []).forEach(t => { typeMap[t.doc_type] = t.count; });

    return (
        <div className="fade-in">
            {/* Case Header */}
            <div style={{
                padding: '20px 24px', marginBottom: '24px',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                            <h2 style={{ margin: 0, fontSize: '20px', color: 'var(--text-primary)' }}>{inv.name || 'Investigation'}</h2>
                            <span className={`status-badge ${inv.status || 'open'}`} style={{ fontSize: '11px' }}>
                                {inv.status || 'open'}
                            </span>
                        </div>
                        {inv.description && (
                            <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>{inv.description}</p>
                        )}
                        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-muted)' }}>
                            {inv.allegation && <span><strong>Allegation:</strong> {inv.allegation}</span>}
                            {inv.key_parties && <span><strong>Key Parties:</strong> {inv.key_parties}</span>}
                            {(inv.date_range_start || inv.date_range_end) && (
                                <span><strong>Period:</strong> {inv.date_range_start || '?'} – {inv.date_range_end || '?'}</span>
                            )}
                        </div>
                    </div>
                    <Link to="/investigations" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}>Edit</Link>
                </div>
            </div>

            {/* Document Breakdown */}
            <div className="grid-stats mb-24">
                <StatCard label="Emails" value={typeMap.email || 0} icon="📧" />
                <StatCard label="Attachments" value={typeMap.attachment || 0} icon="📎" />
                <StatCard label="Files" value={typeMap.file || 0} icon="📄" />
                <StatCard label="Chats" value={typeMap.chat || 0} icon="💬" />
                <StatCard label="Total Size" value={formatSize(stats.total_size)} icon="💾" />
                <StatCard label="Duplicates" value={stats.duplicate_count} icon="🔁" />
            </div>

            {/* Review Progress */}
            <div style={{
                padding: '20px 24px', marginBottom: '24px',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Review Progress
                    </h3>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        {stats.reviewed_documents} of {stats.total_documents} reviewed · {stats.classified_count} AI scored
                    </span>
                </div>
                <div style={{ height: '8px', background: 'var(--border-secondary)', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
                    <div style={{
                        height: '100%', background: 'var(--primary)', borderRadius: '4px',
                        width: `${stats.review_percentage}%`, transition: 'width 0.5s ease'
                    }} />
                </div>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {stats.status_breakdown.length > 0 ? stats.status_breakdown.map(s => (
                        <span key={s.status} className={`status-badge ${s.status}`}>
                            {s.status.replace('_', ' ')} ({s.count})
                        </span>
                    )) : (
                        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No reviews yet</span>
                    )}
                </div>
            </div>

            {/* Data Sources + Custodians side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
                {/* Data Sources */}
                <div style={{
                    padding: '20px 24px',
                    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)'
                }}>
                    <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Data Sources
                    </h3>
                    {stats.import_jobs.length > 0 ? (
                        <table className="data-table" style={{ fontSize: '13px' }}>
                            <thead>
                                <tr>
                                    <th>Source File</th>
                                    <th style={{ textAlign: 'right' }}>Emails</th>
                                    <th style={{ textAlign: 'right' }}>Attach.</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.import_jobs.map((job, i) => (
                                    <tr key={i}>
                                        <td style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                            title={job.original_name}>{job.original_name}</td>
                                        <td style={{ textAlign: 'right' }}>{job.total_emails || '—'}</td>
                                        <td style={{ textAlign: 'right' }}>{job.total_attachments || '—'}</td>
                                        <td>
                                            <span className={`status-badge ${job.status}`} style={{ fontSize: '11px' }}>
                                                {job.status === 'completed' ? 'Imported' : job.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No imports yet. <Link to="/upload" style={{ color: 'var(--text-accent)' }}>Upload data</Link></p>
                    )}
                </div>

                {/* Custodians */}
                <div style={{
                    padding: '20px 24px',
                    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)'
                }}>
                    <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Custodians
                    </h3>
                    {stats.custodians.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {stats.custodians.map(c => (
                                <div key={c.name} style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '8px 12px', borderRadius: '6px',
                                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                                    cursor: 'pointer'
                                }} onClick={() => navigate(`/search?custodian=${encodeURIComponent(c.name)}`)}>
                                    <div>
                                        <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>👤 {c.name}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
                                        {c.email_count > 0 && <span>{c.email_count} emails</span>}
                                        {c.attachment_count > 0 && <span>{c.attachment_count} attach.</span>}
                                        {c.chat_count > 0 && <span>{c.chat_count} chats</span>}
                                        {c.file_count > 0 && <span>{c.file_count} files</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No custodians assigned yet.</p>
                    )}
                </div>
            </div>

            {/* Top Senders */}
            {stats.top_senders.length > 0 && (
                <div style={{
                    padding: '20px 24px', marginBottom: '24px',
                    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)'
                }}>
                    <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Top Senders
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {stats.top_senders.map((s, i) => {
                            const maxCount = stats.top_senders[0].count;
                            return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                                    onClick={() => navigate(`/search?q=${encodeURIComponent(`email_from:"${s.email_from}"`)}`)}>
                                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '24px', textAlign: 'right' }}>{s.count}</span>
                                    <div style={{ flex: 1, height: '20px', background: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', background: 'var(--primary)', opacity: 0.3,
                                            width: `${(s.count / maxCount) * 100}%`, borderRadius: '4px'
                                        }} />
                                    </div>
                                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)', minWidth: '200px' }}>{s.email_from}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Quick Actions */}
            <div className="flex gap-16">
                <Link to="/upload" className="btn btn-primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Upload Documents
                </Link>
                <Link to="/search" className="btn btn-secondary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Search Documents
                </Link>
            </div>
        </div>
    );
}

function StatCard({ label, value, icon }) {
    return (
        <div className="stat-card">
            <span className="stat-label">{icon} {label}</span>
            <span className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
        </div>
    );
}

export default Dashboard;
