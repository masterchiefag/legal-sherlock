import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatSize } from '../utils/format';

function Dashboard() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        fetch('/api/reviews/stats')
            .then(r => {
                if (!r.ok) throw new Error('Failed to load dashboard');
                return r.json();
            })
            .then(data => { setStats(data); setLoading(false); })
            .catch(err => { setError(err.message); setLoading(false); });
    }, []);

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

    return (
        <div className="fade-in">
            {/* Stats Grid */}
            <div className="grid-stats mb-24">
                <div className="stat-card">
                    <span className="stat-label">Total Documents</span>
                    <span className="stat-value">{stats.total_documents}</span>
                    <span className="stat-sub">{stats.ready_documents} ready for review</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Reviewed</span>
                    <span className="stat-value">{stats.review_percentage}%</span>
                    <span className="stat-sub">{stats.reviewed_documents} of {stats.total_documents} documents</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Review Breakdown</span>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {stats.status_breakdown.length > 0 ? stats.status_breakdown.map(s => (
                            <span key={s.status} className={`status-badge ${s.status}`}>
                                {s.status.replace('_', ' ')} ({s.count})
                            </span>
                        )) : (
                            <span className="text-sm text-muted">No reviews yet</span>
                        )}
                    </div>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Tags Used</span>
                    <span className="stat-value">{stats.tag_breakdown.length}</span>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {stats.tag_breakdown.slice(0, 5).map(t => (
                            <span key={t.name} className="tag-chip" style={{
                                background: `${t.color}20`,
                                color: t.color,
                                borderColor: `${t.color}40`,
                            }}>
                                {t.name} ({t.count})
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {/* Quick Actions */}
            <div className="flex gap-16 mb-24">
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

            {/* Recent Uploads */}
            <div className="card">
                <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                    Recent Uploads
                </h3>
                {stats.recent_uploads.length > 0 ? (
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Document</th>
                                <th>Size</th>
                                <th>Status</th>
                                <th>Uploaded</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stats.recent_uploads.map(doc => (
                                <tr key={doc.id} onClick={() => navigate(`/documents/${doc.id}`)}>
                                    <td className="doc-name">{doc.original_name}</td>
                                    <td>{formatSize(doc.size_bytes)}</td>
                                    <td><span className={`status-badge ${doc.status}`}>{doc.status}</span></td>
                                    <td>{new Date(doc.uploaded_at).toLocaleDateString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty-state" style={{ padding: '32px' }}>
                        <p className="empty-state-text">No documents uploaded yet. <Link to="/upload" style={{ color: 'var(--text-accent)' }}>Upload your first document</Link></p>
                    </div>
                )}
            </div>
        </div>
    );
}

export default Dashboard;
