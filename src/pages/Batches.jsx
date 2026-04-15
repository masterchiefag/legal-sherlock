import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch, apiPatch, apiDelete } from '../utils/api';

function Batches({ activeInvestigationId, activeInvestigation, addToast, user }) {
    const navigate = useNavigate();
    const [batches, setBatches] = useState([]);
    const [loading, setLoading] = useState(true);

    // Filters
    const [statusFilter, setStatusFilter] = useState('');
    const [assigneeFilter, setAssigneeFilter] = useState('');

    // Detail view
    const [selectedBatch, setSelectedBatch] = useState(null);

    // Members for admin reassign
    const [members, setMembers] = useState([]);

    const isAdmin = user?.role === 'admin';

    const loadBatches = useCallback(async () => {
        if (!activeInvestigationId) return;
        try {
            let url = `/api/batches?investigation_id=${activeInvestigationId}`;
            if (statusFilter) url += `&status=${statusFilter}`;
            if (assigneeFilter) url += `&assignee_id=${assigneeFilter}`;
            const res = await apiFetch(url);
            const data = await res.json();
            setBatches(data.batches || []);
        } catch (err) {
            console.error('Failed to load batches:', err);
        } finally {
            setLoading(false);
        }
    }, [activeInvestigationId, statusFilter, assigneeFilter]);

    useEffect(() => {
        setLoading(true);
        setSelectedBatch(null);
        loadBatches();
    }, [loadBatches]);

    // Load all active users for admin reassign dropdown
    useEffect(() => {
        if (!isAdmin) return;
        apiFetch('/api/users')
            .then(r => r.json())
            .then(data => {
                const active = (Array.isArray(data) ? data : []).filter(u => u.is_active && u.role !== 'viewer');
                setMembers(active.map(u => ({ user_id: u.id, name: u.name || u.email })));
            })
            .catch(() => {});
    }, [isAdmin]);

    const loadBatchDetail = async (batch) => {
        setSelectedBatch(batch);
        try {
            const res = await apiFetch(`/api/batches/${batch.id}?investigation_id=${activeInvestigationId}`);
            const data = await res.json();
            setSelectedBatch(data.batch);
        } catch (err) {
            console.error('Failed to load batch detail:', err);
            addToast('Failed to load batch detail', 'error');
        }
    };

    const handleAssign = async (batchId, assigneeId) => {
        try {
            const res = await apiPatch(`/api/batches/${batchId}/assign?investigation_id=${activeInvestigationId}`, { assignee_id: assigneeId });
            const data = await res.json();
            if (!res.ok) { addToast(data.error || 'Failed to assign', 'error'); return; }
            addToast('Batch assigned successfully', 'success');
            loadBatches();
            if (selectedBatch?.id === batchId) {
                setSelectedBatch(data.batch);
            }
        } catch (err) {
            addToast('Failed to assign batch', 'error');
        }
    };

    const handleStatusChange = async (batchId, status) => {
        try {
            const res = await apiPatch(`/api/batches/${batchId}/status?investigation_id=${activeInvestigationId}`, { status });
            if (!res.ok) { addToast('Failed to update status', 'error'); return; }
            addToast(`Batch marked as ${status}`, 'success');
            loadBatches();
            if (selectedBatch?.id === batchId) {
                setSelectedBatch(prev => ({ ...prev, status }));
            }
        } catch (err) {
            addToast('Failed to update status', 'error');
        }
    };

    const handleDelete = async (batchId) => {
        if (!confirm('Delete this batch? Documents will not be affected.')) return;
        try {
            const res = await apiDelete(`/api/batches/${batchId}?investigation_id=${activeInvestigationId}`);
            if (!res.ok) { addToast('Failed to delete batch', 'error'); return; }
            addToast('Batch deleted', 'success');
            if (selectedBatch?.id === batchId) setSelectedBatch(null);
            loadBatches();
        } catch (err) {
            addToast('Failed to delete batch', 'error');
        }
    };

    const formatCriteria = (criteria) => {
        if (!criteria || typeof criteria === 'string') return criteria || '—';
        const parts = [];
        if (criteria.q) parts.push(`"${criteria.q}"`);
        if (criteria.doc_type) parts.push(`type: ${criteria.doc_type}`);
        if (criteria.review_status) parts.push(`status: ${criteria.review_status}`);
        if (criteria.custodian) parts.push(`custodian: ${criteria.custodian}`);
        if (criteria.date_from || criteria.date_to) {
            parts.push(`${criteria.date_from || '...'} – ${criteria.date_to || '...'}`);
        }
        if (criteria.score_min) parts.push(`score >= ${criteria.score_min}`);
        if (criteria.hide_duplicates === '1') parts.push('no dupes');
        if (criteria.latest_thread_only === '1') parts.push('latest in thread');
        return parts.length > 0 ? parts.join(', ') : 'All documents';
    };

    const statusBadge = (s) => {
        const colors = { pending: '#6b7280', in_progress: '#3b82f6', completed: '#22c55e' };
        const labels = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };
        return (
            <span style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: '12px', fontSize: '11px',
                fontWeight: 600, color: '#fff', background: colors[s] || '#6b7280',
            }}>
                {labels[s] || s}
            </span>
        );
    };

    const canActOnBatch = (batch) => {
        return isAdmin || batch.assignee_id === user?.id;
    };

    if (!activeInvestigationId) {
        return (
            <div className="empty-state">
                <h3>No Investigation Selected</h3>
                <p>Select an investigation from the sidebar to view batches.</p>
                <Link to="/investigations" className="btn btn-primary">Manage Investigations</Link>
            </div>
        );
    }

    if (loading) return <div className="loading-overlay"><div className="spinner"></div></div>;

    // ─── DETAIL VIEW ─────────────────────────────────────────
    if (selectedBatch) {
        const pct = selectedBatch.total_docs > 0
            ? Math.round((selectedBatch.reviewed_count / selectedBatch.total_docs) * 100) : 0;
        const canAct = canActOnBatch(selectedBatch);

        return (
            <div className="fade-in" style={{ padding: '0' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedBatch(null)}
                    style={{ marginBottom: '16px' }}>
                    &larr; Back to Batches
                </button>

                <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                    borderRadius: '8px', padding: '20px', marginBottom: '20px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <h3 style={{ margin: 0 }}>Batch #{selectedBatch.batch_number}</h3>
                        {statusBadge(selectedBatch.status)}
                        {selectedBatch.assignee_name && (
                            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                                Assigned to: <strong>{selectedBatch.assignee_name}</strong>
                            </span>
                        )}
                    </div>

                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                        <strong>Search:</strong> {formatCriteria(selectedBatch.search_criteria)}
                    </div>

                    {/* Progress bar */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                            flex: 1, height: '8px', background: 'var(--bg-tertiary)',
                            borderRadius: '4px', overflow: 'hidden',
                        }}>
                            <div style={{
                                width: `${pct}%`, height: '100%',
                                background: pct === 100 ? '#22c55e' : '#3b82f6',
                                borderRadius: '4px', transition: 'width 0.3s',
                            }} />
                        </div>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {selectedBatch.reviewed_count}/{selectedBatch.total_docs} reviewed ({pct}%)
                        </span>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        {!selectedBatch.assignee_id && (
                            <button className="btn btn-primary btn-sm" onClick={() => handleAssign(selectedBatch.id, user.id)}>
                                Assign to me
                            </button>
                        )}
                        {canAct && selectedBatch.status !== 'completed' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => handleStatusChange(selectedBatch.id, 'completed')}>
                                Mark Complete
                            </button>
                        )}
                        {canAct && selectedBatch.status === 'completed' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => handleStatusChange(selectedBatch.id, 'in_progress')}>
                                Reopen
                            </button>
                        )}
                    </div>

                    {!canAct && !isAdmin && (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', fontStyle: 'italic' }}>
                            Assign this batch to yourself to review documents.
                        </p>
                    )}
                </div>

                <button className="btn btn-primary" onClick={() => {
                    navigate(`/search?batch_id=${selectedBatch.id}&batch_num=${selectedBatch.batch_number}`);
                }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '16px', height: '16px' }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    View Documents in Analyze
                </button>
            </div>
        );
    }

    // ─── LIST VIEW ────────────────────────────────────────────
    return (
        <div className="fade-in" style={{ padding: '0' }}>
            {/* Filters */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                    style={{
                        padding: '6px 10px', borderRadius: '6px', fontSize: '13px',
                        background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                        border: '1px solid var(--border-primary)',
                    }}>
                    <option value="">All statuses</option>
                    <option value="pending">Pending</option>
                    <option value="in_progress">In Progress</option>
                    <option value="completed">Completed</option>
                </select>

                {isAdmin && members.length > 0 && (
                    <select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}
                        style={{
                            padding: '6px 10px', borderRadius: '6px', fontSize: '13px',
                            background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                        }}>
                        <option value="">All assignees</option>
                        {members.map(m => (
                            <option key={m.user_id} value={m.user_id}>{m.name}</option>
                        ))}
                    </select>
                )}

                <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {batches.length} batch{batches.length !== 1 ? 'es' : ''}
                </span>
            </div>

            {batches.length === 0 ? (
                <div className="empty-state">
                    <h3>No Batches</h3>
                    <p>No review batches have been created yet. Go to <Link to="/search">Analyze</Link> to create batches from search results.</p>
                </div>
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-primary)', fontSize: '12px', color: 'var(--text-muted)' }}>
                            <th style={{ padding: '8px', textAlign: 'left' }}>Batch #</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>Search Criteria</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>Docs</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>Progress</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>Assignee</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>Status</th>
                            <th style={{ padding: '8px', textAlign: 'right' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {batches.map(b => {
                            const pct = b.total_docs > 0 ? Math.round((b.reviewed_count / b.total_docs) * 100) : 0;
                            return (
                                <tr key={b.id} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                                    <td style={{ padding: '8px', fontWeight: 600 }}>{b.batch_number}</td>
                                    <td style={{ padding: '8px', fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {formatCriteria(b.search_criteria)}
                                    </td>
                                    <td style={{ padding: '8px', textAlign: 'center' }}>{b.total_docs}</td>
                                    <td style={{ padding: '8px', minWidth: '120px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <div style={{
                                                flex: 1, height: '6px', background: 'var(--bg-tertiary)',
                                                borderRadius: '3px', overflow: 'hidden',
                                            }}>
                                                <div style={{
                                                    width: `${pct}%`, height: '100%',
                                                    background: pct === 100 ? '#22c55e' : '#3b82f6',
                                                    borderRadius: '3px',
                                                }} />
                                            </div>
                                            <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                                {pct}%
                                            </span>
                                        </div>
                                    </td>
                                    <td style={{ padding: '8px', fontSize: '13px' }}>
                                        {isAdmin ? (
                                            <select
                                                value={b.assignee_id || ''}
                                                onChange={e => handleAssign(b.id, e.target.value || null)}
                                                style={{
                                                    padding: '3px 6px', borderRadius: '4px', fontSize: '12px',
                                                    background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                                                    border: '1px solid var(--border-primary)', maxWidth: '140px',
                                                }}
                                            >
                                                <option value="">Unassigned</option>
                                                {members.map(m => (
                                                    <option key={m.user_id} value={m.user_id}>{m.name}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            b.assignee_name || <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>
                                        )}
                                    </td>
                                    <td style={{ padding: '8px', textAlign: 'center' }}>{statusBadge(b.status)}</td>
                                    <td style={{ padding: '8px', textAlign: 'right' }}>
                                        <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                                            <button className="btn btn-secondary btn-sm" onClick={() => loadBatchDetail(b)}
                                                style={{ fontSize: '11px', padding: '3px 8px' }}>
                                                View
                                            </button>
                                            {!b.assignee_id && !isAdmin && (
                                                <button className="btn btn-primary btn-sm" onClick={() => handleAssign(b.id, user.id)}
                                                    style={{ fontSize: '11px', padding: '3px 8px' }}>
                                                    Assign to me
                                                </button>
                                            )}
                                            {isAdmin && (
                                                <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(b.id)}
                                                    style={{ fontSize: '11px', padding: '3px 8px', color: '#ef4444' }}>
                                                    Delete
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

export default Batches;
