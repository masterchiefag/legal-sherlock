import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatSize } from '../utils/format';
import { apiFetch } from '../utils/api';

function Dashboard({ activeInvestigationId, activeInvestigation, addToast }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [commTab, setCommTab] = useState('senders');
    const [expandedCustodians, setExpandedCustodians] = useState({});
    const navigate = useNavigate();

    useEffect(() => {
        if (!activeInvestigationId) return;
        apiFetch(`/api/reviews/stats?investigation_id=${activeInvestigationId}`)
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

    const toggleCustodian = (name) => {
        setExpandedCustodians(prev => ({ ...prev, [name]: !prev[name] }));
    };

    // Format date range span
    const formatDateSpan = (days) => {
        if (days < 1) return 'less than a day';
        const years = Math.floor(days / 365);
        const remainingDays = days % 365;
        const parts = [];
        if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`);
        if (remainingDays > 0) parts.push(`${remainingDays} day${remainingDays > 1 ? 's' : ''}`);
        return parts.join(', ');
    };

    const formatDateShort = (dateStr) => {
        if (!dateStr) return '';
        try {
            return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return dateStr; }
    };

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

            {/* Document Overview Panel */}
            <div style={{
                padding: '20px 24px', marginBottom: '24px',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Document Overview
                    </h3>
                    {stats.date_range && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {formatDateShort(stats.date_range.earliest)} – {formatDateShort(stats.date_range.latest)}
                            {' '}({formatDateSpan(stats.date_range.range_days)})
                        </span>
                    )}
                </div>
                {/* Row 1: Totals */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '12px' }}>
                    <MiniStat label="Total" value={stats.total_documents} />
                    <MiniStat label="Unique" value={stats.unique_document_count ?? 0} accent />
                    <MiniStat label="Duplicates" value={stats.duplicate_count} muted />
                    <MiniStat label="Total Size" value={formatSize(stats.total_size)} />
                </div>
                {/* Row 2: By Type */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px' }}>
                    <MiniStat label="Emails" value={typeMap.email || 0} sub="📧" />
                    <MiniStat label="Attachments" value={stats.total_attachment_count || typeMap.attachment || 0} sub="📎" subValue={`${stats.unique_attachment_count ?? 0} unique`} />
                    <MiniStat label="Files" value={typeMap.file || 0} sub="📄" />
                    <MiniStat label="Chats" value={typeMap.chat || 0} sub="💬" />
                    <MiniStat label="OCR Processed" value={stats.ocr_doc_count || 0} sub="🔍" />
                </div>
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

            {/* Attachment Types + OCR */}
            {((stats.attachment_types && stats.attachment_types.length > 0) || stats.ocr_doc_count > 0) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
                    {/* Attachment File Types */}
                    {stats.attachment_types && stats.attachment_types.length > 0 && (
                        <div style={{
                            padding: '20px 24px',
                            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                            border: '1px solid var(--border)'
                        }}>
                            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                File Types
                            </h3>
                            {/* Header row */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', marginBottom: '4px', fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                <span>Extension</span>
                                <div style={{ display: 'flex', gap: '20px' }}>
                                    <span style={{ minWidth: '50px', textAlign: 'right' }}>Total</span>
                                    <span style={{ minWidth: '50px', textAlign: 'right' }}>Unique</span>
                                </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {stats.attachment_types.map(t => (
                                    <div key={t.ext} style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        padding: '6px 10px', borderRadius: '6px',
                                        background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                                        cursor: 'pointer', fontSize: '13px'
                                    }} onClick={() => navigate(`/search?type=attachment&q=${encodeURIComponent(`original_name:"${t.ext.replace('.', '')}"`)}`)}>
                                        <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                                            {t.ext}
                                        </span>
                                        <div style={{ display: 'flex', gap: '20px' }}>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '12px', minWidth: '50px', textAlign: 'right' }}>{t.count.toLocaleString()}</span>
                                            <span style={{ color: 'var(--text-accent)', fontSize: '12px', minWidth: '50px', textAlign: 'right' }}>{(t.unique_count || 0).toLocaleString()}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* OCR Stats */}
                    {stats.ocr_doc_count > 0 && (
                        <div style={{
                            padding: '20px 24px',
                            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                            border: '1px solid var(--border)'
                        }}>
                            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                OCR Processing
                            </h3>
                            <div
                                style={{
                                    padding: '12px 16px', borderRadius: '8px',
                                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                                    cursor: 'pointer'
                                }}
                                onClick={() => navigate(`/search?ocr_applied=1&investigation_id=${activeInvestigationId}`)}
                            >
                                <p style={{ margin: '0 0 4px', fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {stats.ocr_doc_count.toLocaleString()}
                                </p>
                                <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
                                    Documents processed with OCR
                                </p>
                            </div>
                            {stats.import_jobs.some(j => j.ocr_count > 0) && (
                                <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                                    {stats.import_jobs.filter(j => j.ocr_count > 0).map((j, i) => (
                                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-secondary)' }}>
                                            <span style={{ color: 'var(--text-secondary)' }}>{j.original_name}</span>
                                            <span>{j.ocr_success}/{j.ocr_count} succeeded · {(j.ocr_time_ms / 1000).toFixed(1)}s</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Data Sources (full width) */}
            <div style={{
                padding: '20px 24px', marginBottom: '24px',
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

            {/* Custodians (full width, collapsible) */}
            <div style={{
                padding: '20px 24px', marginBottom: '24px',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border)'
            }}>
                <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                    Custodians
                </h3>
                {stats.custodians.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {/* All Custodians Summary */}
                        <CustodianSummaryRow
                            label="All Custodians"
                            data={{
                                document_count: stats.custodians.reduce((s, c) => s + c.document_count, 0),
                                unique_count: stats.custodians.reduce((s, c) => s + (c.unique_count || 0), 0),
                                email_count: stats.custodians.reduce((s, c) => s + c.email_count, 0),
                                attachment_count: stats.custodians.reduce((s, c) => s + c.attachment_count, 0),
                                unique_attachment_count: stats.custodians.reduce((s, c) => s + (c.unique_attachment_count || 0), 0),
                                chat_count: stats.custodians.reduce((s, c) => s + c.chat_count, 0),
                                file_count: stats.custodians.reduce((s, c) => s + c.file_count, 0),
                                duplicate_count: stats.custodians.reduce((s, c) => s + (c.duplicate_count || 0), 0),
                                total_size: stats.custodians.reduce((s, c) => s + (c.total_size || 0), 0),
                                reviewed_count: stats.custodians.reduce((s, c) => s + (c.reviewed_count || 0), 0),
                                classified_count: stats.custodians.reduce((s, c) => s + (c.classified_count || 0), 0),
                            }}
                            isHeader
                        />
                        {/* Individual Custodians */}
                        {stats.custodians.map(c => (
                            <div key={c.name}>
                                <div style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '10px 12px', borderRadius: '6px',
                                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)',
                                    cursor: 'pointer'
                                }} onClick={() => toggleCustodian(c.name)}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: expandedCustodians[c.name] ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                                        <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>{c.name}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
                                        <span>{c.document_count} docs</span>
                                        <span>{formatSize(c.total_size || 0)}</span>
                                        <span
                                            style={{ color: 'var(--text-accent)', cursor: 'pointer' }}
                                            onClick={(e) => { e.stopPropagation(); navigate(`/search?custodian=${encodeURIComponent(c.name)}`); }}
                                        >
                                            Search
                                        </span>
                                    </div>
                                </div>
                                {expandedCustodians[c.name] && (
                                    <div style={{ marginTop: '4px', marginLeft: '20px' }}>
                                        <CustodianSummaryRow label={c.name} data={c} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No custodians assigned yet.</p>
                )}
            </div>

            {/* Top Senders / Communication Pairs */}
            {(stats.top_senders.length > 0 || (stats.top_communication_pairs && stats.top_communication_pairs.length > 0)) && (
                <div style={{
                    padding: '20px 24px', marginBottom: '24px',
                    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0', marginBottom: '16px' }}>
                        <button
                            onClick={() => setCommTab('senders')}
                            style={{
                                padding: '6px 16px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer',
                                borderRadius: '6px 0 0 6px',
                                background: commTab === 'senders' ? 'var(--primary)' : 'var(--bg-tertiary)',
                                color: commTab === 'senders' ? '#fff' : 'var(--text-secondary)'
                            }}
                        >
                            Top Senders
                        </button>
                        <button
                            onClick={() => setCommTab('pairs')}
                            style={{
                                padding: '6px 16px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer',
                                borderRadius: '0 6px 6px 0',
                                background: commTab === 'pairs' ? 'var(--primary)' : 'var(--bg-tertiary)',
                                color: commTab === 'pairs' ? '#fff' : 'var(--text-secondary)'
                            }}
                        >
                            Top Pairs
                        </button>
                    </div>
                    {commTab === 'senders' && stats.top_senders.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {stats.top_senders.map((s, i) => {
                                const maxCount = stats.top_senders[0].count;
                                return (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                                        onClick={() => navigate(`/search?q=${encodeURIComponent(`email_from:"${s.email_from}"`)}`)}>
                                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '32px', textAlign: 'right' }}>{s.count}</span>
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
                    )}
                    {commTab === 'pairs' && stats.top_communication_pairs && stats.top_communication_pairs.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {stats.top_communication_pairs.map((p, i) => {
                                const maxCount = stats.top_communication_pairs[0].count;
                                return (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                                        onClick={() => navigate(`/search?q=${encodeURIComponent(`email_from:"${p.sender}" email_to:"${p.receiver}"`)}`)}>
                                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '32px', textAlign: 'right' }}>{p.count}</span>
                                        <div style={{ flex: 1, height: '20px', background: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                                            <div style={{
                                                height: '100%', background: 'var(--primary)', opacity: 0.3,
                                                width: `${(p.count / maxCount) * 100}%`, borderRadius: '4px'
                                            }} />
                                        </div>
                                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', minWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {p.sender} <span style={{ color: 'var(--text-muted)' }}>→</span> {p.receiver}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {commTab === 'pairs' && (!stats.top_communication_pairs || stats.top_communication_pairs.length === 0) && (
                        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No communication pair data available.</p>
                    )}
                </div>
            )}

            {/* Quick Analytics */}
            <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Analytics
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
                {/* Document Volume Over Time */}
                {stats.volume_by_month && stats.volume_by_month.length > 0 && (
                    <VolumeChart data={stats.volume_by_month} />
                )}

                {/* AI Score Distribution */}
                {stats.score_distribution && stats.score_distribution.length > 0 && (
                    <ScoreDistribution data={stats.score_distribution} />
                )}

                {/* Review Status Donut */}
                {stats.status_breakdown && stats.status_breakdown.length > 0 && (
                    <ReviewDonut data={stats.status_breakdown} total={stats.total_documents} reviewed={stats.reviewed_documents} />
                )}

                {/* Email Activity Heatmap */}
                {stats.activity_heatmap && stats.activity_heatmap.length > 0 && (
                    <ActivityHeatmap data={stats.activity_heatmap} />
                )}

                {/* Thread Depth Distribution */}
                {stats.thread_depth && stats.thread_depth.length > 0 && (
                    <ThreadDepthChart data={stats.thread_depth} />
                )}

                {/* Size by Doc Type */}
                {stats.size_by_doc_type && stats.size_by_doc_type.length > 0 && (
                    <SizeByType data={stats.size_by_doc_type} />
                )}
            </div>

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

// ── Sub-components ──

function MiniStat({ label, value, accent, muted, sub, subValue }) {
    return (
        <div style={{
            padding: '12px 16px', borderRadius: '8px',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)'
        }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                {sub && <span style={{ marginRight: '4px' }}>{sub}</span>}{label}
            </div>
            <div style={{
                fontSize: '22px', fontWeight: 700, letterSpacing: '-0.5px',
                color: accent ? 'var(--text-accent, #60a5fa)' : muted ? 'var(--text-muted)' : 'var(--text-primary)'
            }}>
                {typeof value === 'number' ? value.toLocaleString() : value}
            </div>
            {subValue && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{subValue}</div>
            )}
        </div>
    );
}

function CustodianSummaryRow({ label, data, isHeader }) {
    const reviewPct = data.document_count > 0 ? Math.round((data.reviewed_count || 0) / data.document_count * 100) : 0;
    const classifyPct = data.document_count > 0 ? Math.round((data.classified_count || 0) / data.document_count * 100) : 0;
    return (
        <div style={{
            padding: '12px 16px', borderRadius: '8px',
            background: isHeader ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
            border: `1px solid ${isHeader ? 'var(--border)' : 'var(--border-secondary)'}`,
        }}>
            {isHeader && <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)', marginBottom: '10px' }}>Summary (All Custodians)</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '8px', fontSize: '12px' }}>
                <MetricCell label="Total" value={data.document_count} />
                <MetricCell label="Unique" value={data.unique_count || 0} />
                <MetricCell label="Emails" value={data.email_count} />
                <MetricCell label="Attach." value={data.attachment_count} />
                <MetricCell label="Uniq. Attach." value={data.unique_attachment_count || 0} />
                <MetricCell label="Chats" value={data.chat_count} />
                <MetricCell label="Files" value={data.file_count} />
                <MetricCell label="Dupes" value={data.duplicate_count || 0} />
                <MetricCell label="Size" value={formatSize(data.total_size || 0)} />
            </div>
            <div style={{ display: 'flex', gap: '16px', marginTop: '10px', fontSize: '11px' }}>
                <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', marginBottom: '3px' }}>
                        <span>Reviewed</span><span>{reviewPct}%</span>
                    </div>
                    <div style={{ height: '4px', background: 'var(--border-secondary)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: 'var(--primary)', width: `${reviewPct}%`, borderRadius: '2px' }} />
                    </div>
                </div>
                <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', marginBottom: '3px' }}>
                        <span>AI Scored</span><span>{classifyPct}%</span>
                    </div>
                    <div style={{ height: '4px', background: 'var(--border-secondary)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: '#8b5cf6', width: `${classifyPct}%`, borderRadius: '2px' }} />
                    </div>
                </div>
            </div>
        </div>
    );
}

function MetricCell({ label, value }) {
    return (
        <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '14px' }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
        </div>
    );
}

// ── Analytics Charts ──

const cardStyle = {
    padding: '20px 24px',
    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border)'
};
const chartTitle = { margin: '0 0 16px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' };

function VolumeChart({ data }) {
    const maxCount = Math.max(...data.map(d => d.count));
    const showEvery = data.length > 24 ? Math.ceil(data.length / 12) : 1;
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>Document Volume Over Time</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '140px' }}>
                {data.map((d, i) => (
                    <div key={d.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }} title={`${d.month}: ${d.count}`}>
                        <div style={{
                            width: '100%', minWidth: '4px', maxWidth: '20px',
                            height: `${Math.max((d.count / maxCount) * 100, 2)}%`,
                            background: 'var(--primary)', borderRadius: '2px 2px 0 0', opacity: 0.7
                        }} />
                    </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: '2px', marginTop: '4px' }}>
                {data.map((d, i) => (
                    <div key={d.month} style={{ flex: 1, textAlign: 'center', fontSize: '9px', color: 'var(--text-muted)', overflow: 'hidden' }}>
                        {i % showEvery === 0 ? d.month.slice(2) : ''}
                    </div>
                ))}
            </div>
        </div>
    );
}

function ScoreDistribution({ data }) {
    const maxCount = Math.max(...data.map(d => d.count));
    const scoreColors = { 1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#10b981' };
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>AI Score Distribution</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[1, 2, 3, 4, 5].map(score => {
                    const entry = data.find(d => d.score === score);
                    const count = entry ? entry.count : 0;
                    return (
                        <div key={score} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: scoreColors[score], minWidth: '30px' }}>
                                Score {score}
                            </span>
                            <div style={{ flex: 1, height: '20px', background: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                                {maxCount > 0 && <div style={{
                                    height: '100%', background: scoreColors[score], opacity: 0.5,
                                    width: `${(count / maxCount) * 100}%`, borderRadius: '4px'
                                }} />}
                            </div>
                            <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '32px', textAlign: 'right' }}>{count}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ReviewDonut({ data, total, reviewed }) {
    const statusColors = { pending: '#6b7280', relevant: '#22c55e', not_relevant: '#ef4444', privileged: '#eab308' };
    const statusLabels = { pending: 'Pending', relevant: 'Relevant', not_relevant: 'Not Relevant', privileged: 'Privileged' };
    const segments = data.map(s => ({ ...s, color: statusColors[s.status] || '#6b7280' }));
    const segTotal = segments.reduce((s, seg) => s + seg.count, 0);
    let accum = 0;
    const gradientParts = segments.map(seg => {
        const start = (accum / segTotal) * 360;
        accum += seg.count;
        const end = (accum / segTotal) * 360;
        return `${seg.color} ${start}deg ${end}deg`;
    });
    // Add unreviewed portion
    if (segTotal < total) {
        gradientParts.push(`var(--border-secondary) ${(segTotal / total) * 360}deg 360deg`);
    }
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>Review Status</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                <div style={{
                    width: '120px', height: '120px', borderRadius: '50%', flexShrink: 0,
                    background: segTotal > 0 ? `conic-gradient(${gradientParts.join(', ')})` : 'var(--border-secondary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div style={{
                        width: '72px', height: '72px', borderRadius: '50%',
                        background: 'var(--bg-secondary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)'
                    }}>
                        {total > 0 ? Math.round((reviewed / total) * 100) : 0}%
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {segments.map(seg => (
                        <div key={seg.status} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                            <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: seg.color, flexShrink: 0 }} />
                            <span style={{ color: 'var(--text-secondary)' }}>{statusLabels[seg.status] || seg.status}</span>
                            <span style={{ color: 'var(--text-muted)' }}>({seg.count})</span>
                        </div>
                    ))}
                    {segTotal < total && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                            <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--border-secondary)', flexShrink: 0 }} />
                            <span style={{ color: 'var(--text-secondary)' }}>Unreviewed</span>
                            <span style={{ color: 'var(--text-muted)' }}>({total - segTotal})</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function ActivityHeatmap({ data }) {
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const maxCount = Math.max(...data.map(d => d.count));
    const grid = {};
    data.forEach(d => { grid[`${d.day_of_week}-${d.hour}`] = d.count; });
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>Email Activity Heatmap</h3>
            <div style={{ display: 'flex', gap: '2px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginRight: '4px', paddingTop: '18px' }}>
                    {dayLabels.map(d => (
                        <div key={d} style={{ height: '14px', fontSize: '9px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>{d}</div>
                    ))}
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', gap: '2px', marginBottom: '2px' }}>
                        {Array.from({ length: 24 }, (_, h) => (
                            <div key={h} style={{ flex: 1, textAlign: 'center', fontSize: '9px', color: 'var(--text-muted)' }}>
                                {h % 3 === 0 ? `${h}` : ''}
                            </div>
                        ))}
                    </div>
                    {dayLabels.map((_, dayIdx) => (
                        <div key={dayIdx} style={{ display: 'flex', gap: '2px', marginBottom: '2px' }}>
                            {Array.from({ length: 24 }, (_, h) => {
                                const count = grid[`${dayIdx}-${h}`] || 0;
                                const intensity = maxCount > 0 ? count / maxCount : 0;
                                return (
                                    <div key={h} style={{
                                        flex: 1, height: '14px', borderRadius: '2px',
                                        background: count > 0 ? `rgba(99, 102, 241, ${0.15 + intensity * 0.85})` : 'var(--bg-tertiary)',
                                    }} title={`${dayLabels[dayIdx]} ${h}:00 — ${count} messages`} />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ThreadDepthChart({ data }) {
    const maxCount = Math.max(...data.map(d => d.count));
    const displayData = data.slice(0, 15);
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>Thread Depth Distribution</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {displayData.map(d => (
                    <div key={d.depth} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '60px' }}>
                            {d.depth} email{d.depth > 1 ? 's' : ''}
                        </span>
                        <div style={{ flex: 1, height: '16px', background: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                            <div style={{
                                height: '100%', background: 'var(--primary)', opacity: 0.4,
                                width: `${(d.count / maxCount) * 100}%`, borderRadius: '4px'
                            }} />
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '40px', textAlign: 'right' }}>
                            {d.count} thread{d.count > 1 ? 's' : ''}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SizeByType({ data }) {
    const typeColors = { email: '#6366f1', attachment: '#f59e0b', file: '#22c55e', chat: '#06b6d4' };
    const typeLabels = { email: 'Emails', attachment: 'Attachments', file: 'Files', chat: 'Chats' };
    const totalSize = data.reduce((s, d) => s + d.total_size, 0);
    return (
        <div style={cardStyle}>
            <h3 style={chartTitle}>Size by Document Type</h3>
            {/* Stacked bar */}
            {totalSize > 0 && (
                <div style={{ display: 'flex', height: '28px', borderRadius: '6px', overflow: 'hidden', marginBottom: '16px' }}>
                    {data.filter(d => d.total_size > 0).map(d => (
                        <div key={d.doc_type} style={{
                            width: `${(d.total_size / totalSize) * 100}%`,
                            background: typeColors[d.doc_type] || '#6b7280',
                            opacity: 0.7,
                            minWidth: d.total_size > 0 ? '4px' : '0'
                        }} title={`${typeLabels[d.doc_type] || d.doc_type}: ${formatSize(d.total_size)}`} />
                    ))}
                </div>
            )}
            {/* Legend table */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {data.map(d => (
                    <div key={d.doc_type} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
                        <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: typeColors[d.doc_type] || '#6b7280', flexShrink: 0 }} />
                        <span style={{ color: 'var(--text-secondary)', minWidth: '80px' }}>{typeLabels[d.doc_type] || d.doc_type}</span>
                        <span style={{ color: 'var(--text-primary)', fontWeight: 600, minWidth: '70px' }}>{formatSize(d.total_size)}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{d.count} docs · avg {formatSize(Math.round(d.avg_size))}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default Dashboard;
