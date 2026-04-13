import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch, apiPost, apiDelete } from '../utils/api';

const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' };
const tdStyle = { padding: '12px 14px', color: 'var(--text-secondary)' };

const emptyForm = { name: '', description: '', allegation: '', key_parties: '', remarks: '', date_range_start: '', date_range_end: '', short_code: '' };

function Investigations({ activeInvestigationId, onInvestigationChange, addToast, user }) {
    const isAdmin = user?.role === 'admin';
    const canCreate = user?.role === 'admin' || user?.role === 'reviewer';
    const [investigations, setInvestigations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingId, setEditingId] = useState(null); // null = create, string = edit
    const [formData, setFormData] = useState({ ...emptyForm });
    const [deleteConfirm, setDeleteConfirm] = useState(null); // investigation id pending delete
    const [deleting, setDeleting] = useState(false);

    // Members panel state
    const [membersInvId, setMembersInvId] = useState(null);
    const [members, setMembers] = useState([]);
    const [allUsers, setAllUsers] = useState([]);
    const [membersLoading, setMembersLoading] = useState(false);
    const [addUserId, setAddUserId] = useState('');

    const loadInvestigations = async () => {
        try {
            const res = await apiFetch('/api/investigations');
            if (res.ok) {
                const data = await res.json();
                setInvestigations(data);
                if (data.length > 0 && (!activeInvestigationId || !data.some(i => i.id === activeInvestigationId))) {
                    const defaultInv = data[0];
                    if (onInvestigationChange) onInvestigationChange(defaultInv.id);
                }
            } else {
                throw new Error('Failed to load investigations');
            }
        } catch (err) {
            addToast(err.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadInvestigations(); }, []);

    const openCreate = () => {
        setEditingId(null);
        setFormData({ ...emptyForm });
        setShowModal(true);
    };

    const openEdit = (inv) => {
        setEditingId(inv.id);
        setFormData({
            name: inv.name || '',
            description: inv.description || '',
            allegation: inv.allegation || '',
            key_parties: inv.key_parties || '',
            remarks: inv.remarks || '',
            date_range_start: inv.date_range_start || '',
            date_range_end: inv.date_range_end || '',
            short_code: inv.short_code || ''
        });
        setShowModal(true);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            const url = editingId ? `/api/investigations/${editingId}` : '/api/investigations';
            const method = editingId ? 'PUT' : 'POST';
            const res = await apiFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            if (res.ok) {
                setShowModal(false);
                setFormData({ ...emptyForm });
                addToast(editingId ? 'Investigation updated' : 'Investigation created', 'success');
                loadInvestigations();
                if (!editingId) {
                    const newInv = await res.json();
                    if (onInvestigationChange) onInvestigationChange(newInv.id);
                }
            } else {
                const data = await res.json();
                addToast(data.error || 'Failed to save investigation', 'error');
            }
        } catch (err) {
            addToast('Network error', 'error');
        }
    };

    const handleDelete = async (invId) => {
        setDeleting(true);
        try {
            const res = await apiFetch(`/api/investigations/${invId}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
                addToast(data.message, 'success');
                setDeleteConfirm(null);
                if (activeInvestigationId === invId && onInvestigationChange) {
                    onInvestigationChange(null);
                }
                loadInvestigations();
            } else {
                addToast(data.error || 'Failed to delete', 'error');
            }
        } catch (err) {
            addToast('Network error', 'error');
        } finally {
            setDeleting(false);
        }
    };

    const openMembers = async (invId) => {
        setMembersInvId(invId);
        setMembersLoading(true);
        setAddUserId('');
        try {
            const [membersRes, usersRes] = await Promise.all([
                apiFetch(`/api/investigations/${invId}/members`),
                apiFetch('/api/users'),
            ]);
            if (membersRes.ok) setMembers(await membersRes.json());
            if (usersRes.ok) setAllUsers(await usersRes.json());
        } catch { /* ignore */ }
        setMembersLoading(false);
    };

    const handleAddMember = async () => {
        if (!addUserId || !membersInvId) return;
        const res = await apiPost(`/api/investigations/${membersInvId}/members`, { user_id: addUserId });
        if (res.ok) {
            addToast('Member added', 'success');
            setAddUserId('');
            openMembers(membersInvId);
        } else {
            const data = await res.json();
            addToast(data.error || 'Failed to add member', 'error');
        }
    };

    const handleRemoveMember = async (userId) => {
        const res = await apiDelete(`/api/investigations/${membersInvId}/members/${userId}`);
        if (res.ok) {
            addToast('Member removed', 'success');
            openMembers(membersInvId);
        } else {
            const data = await res.json();
            addToast(data.error || 'Failed to remove member', 'error');
        }
    };

    if (loading) {
        return <div className="loading-overlay"><div className="spinner"></div></div>;
    }

    return (
        <div className="fade-in">
            <div className="flex items-center justify-between mb-24">
                <div>
                    <h2 className="text-xl fw-bold m-0" style={{ color: 'var(--text-primary)' }}>Manage Investigations</h2>
                    <p className="text-sm text-muted mt-4 mb-0">Switch between cases or create a new investigation to scope your workspace.</p>
                </div>
                {canCreate && (
                    <button className="btn btn-primary" onClick={openCreate}>
                        + New Investigation
                    </button>
                )}
            </div>

            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-secondary)' }}>
                            <th style={thStyle}>Case Name</th>
                            <th style={thStyle}>Source File</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Emails</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Files</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Total Docs</th>
                            <th style={thStyle}>Imported</th>
                            <th style={thStyle}>Status</th>
                            <th style={{ ...thStyle, textAlign: 'center' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {investigations.filter(inv => inv.status !== 'archived').map(inv => {
                            const isActive = inv.id === activeInvestigationId;
                            const jobs = inv.import_jobs || [];
                            const ingestJobs = inv.ingest_jobs || [];
                            const latestJob = jobs[0];
                            const latestIngest = ingestJobs[0];
                            const latestAnyJob = latestJob && latestIngest
                                ? (latestJob.completed_at || latestJob.started_at) >= (latestIngest.completed_at || latestIngest.started_at) ? latestJob : latestIngest
                                : latestJob || latestIngest;
                            const sourceFiles = [...new Set([
                                ...jobs.map(j => j.original_name).filter(Boolean),
                                ...ingestJobs.map(j => j.image_path ? j.image_path.split('/').pop() : null).filter(Boolean),
                            ])];
                            return (
                                <tr key={inv.id} style={{
                                    borderBottom: '1px solid var(--border-secondary)',
                                    background: isActive ? 'var(--bg-primary-subtle, rgba(99, 102, 241, 0.06))' : 'transparent'
                                }}>
                                    <td style={tdStyle}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            {inv.short_code && <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--primary)', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: '3px', fontWeight: 600 }}>{inv.short_code}</span>}
                                            <span className="fw-bold" style={{ color: 'var(--text-primary)' }}>{inv.name}</span>
                                            {isActive && <span className="status-badge ready" style={{ fontSize: '10px', padding: '2px 6px' }}>Active</span>}
                                        </div>
                                        {inv.description && <div className="text-xs text-muted" style={{ marginTop: '2px' }}>{inv.description}</div>}
                                    </td>
                                    <td style={tdStyle}>
                                        {sourceFiles.length > 0
                                            ? sourceFiles.map((f, i) => <div key={i} className="text-xs" style={{ color: 'var(--text-secondary)' }}>{f}</div>)
                                            : <span className="text-xs text-muted">-</span>
                                        }
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                        {inv.email_count?.toLocaleString() || 0}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                        {((inv.file_count || 0) + (inv.attachment_count || 0)).toLocaleString()}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                                        {inv.document_count?.toLocaleString() || 0}
                                    </td>
                                    <td style={tdStyle}>
                                        {latestAnyJob?.completed_at
                                            ? <span className="text-xs">{new Date(latestAnyJob.completed_at + 'Z').toLocaleDateString()}</span>
                                            : latestAnyJob?.started_at
                                                ? <span className="text-xs text-muted">{new Date(latestAnyJob.started_at + 'Z').toLocaleDateString()}</span>
                                                : <span className="text-xs text-muted">-</span>
                                        }
                                    </td>
                                    <td style={tdStyle}>
                                        {latestAnyJob ? (
                                            <span className={`status-badge ${latestAnyJob.status === 'completed' ? 'ready' : latestAnyJob.status === 'processing' ? 'processing' : 'error'}`} style={{ fontSize: '11px' }}>
                                                {latestAnyJob.status === 'completed' ? 'Imported' : latestAnyJob.status === 'processing' ? 'Importing...' : 'Failed'}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-muted">No imports</span>
                                        )}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                                        <div style={{ display: 'flex', gap: '2px', justifyContent: 'center' }}>
                                            {!isActive && (
                                                <button className="btn btn-ghost btn-sm" style={{ padding: '5px 6px', lineHeight: 1 }} onClick={() => {
                                                    if (onInvestigationChange) onInvestigationChange(inv.id);
                                                    addToast(`Switched to ${inv.name}`, 'success');
                                                }} title="Switch to this case">
                                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><path d="M21 3l-7 7"/><polyline points="9 21 3 21 3 15"/><path d="M3 21l7-7"/></svg>
                                                </button>
                                            )}
                                            {isAdmin && (
                                                <button className="btn btn-ghost btn-sm" style={{ padding: '5px 6px', lineHeight: 1 }} onClick={() => openMembers(inv.id)} title="Manage members">
                                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                                                </button>
                                            )}
                                            {isAdmin && (
                                                <button className="btn btn-ghost btn-sm" style={{ padding: '5px 6px', lineHeight: 1 }} onClick={() => openEdit(inv)} title="Edit">
                                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                                </button>
                                            )}
                                            {isAdmin && (
                                                <button className="btn btn-ghost btn-sm" style={{ padding: '5px 6px', lineHeight: 1, color: 'var(--error)' }}
                                                    onClick={() => setDeleteConfirm(inv.id)} title="Delete case and all data">
                                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Create/Edit Modal */}
            {showModal && createPortal(
                <div className="modal-overlay" onClick={() => setShowModal(false)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
                    <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <div className="flex items-center justify-between mb-24">
                            <h3 className="m-0 text-lg fw-bold text-primary">{editingId ? 'Edit Investigation' : 'Create New Investigation'}</h3>
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowModal(false)}>&#10005;</button>
                        </div>

                        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '16px', alignItems: 'end' }}>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Investigation Name *</label>
                                    <input required type="text" className="input" style={{ width: '100%' }} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Project Apollo Internal Review" />
                                </div>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Short Code</label>
                                    <input type="text" className="input" style={{ width: '120px', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '1px' }} value={formData.short_code} onChange={e => setFormData({...formData, short_code: e.target.value.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10)})} placeholder="APOLLO" />
                                </div>
                            </div>

                            <div>
                                <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Description</label>
                                <textarea className="input" style={{ width: '100%', minHeight: '80px', resize: 'vertical' }} value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} placeholder="Brief overview of the case" />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Allegation</label>
                                    <input type="text" className="input" style={{ width: '100%' }} value={formData.allegation} onChange={e => setFormData({...formData, allegation: e.target.value})} placeholder="The core issue being investigated" />
                                </div>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Key Parties (People/Orgs)</label>
                                    <input type="text" className="input" style={{ width: '100%' }} value={formData.key_parties} onChange={e => setFormData({...formData, key_parties: e.target.value})} placeholder="John Doe, Acme Corp, etc." />
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Period Start</label>
                                    <input type="date" className="input" style={{ width: '100%' }} value={formData.date_range_start} onChange={e => setFormData({...formData, date_range_start: e.target.value})} />
                                </div>
                                <div>
                                    <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Period End</label>
                                    <input type="date" className="input" style={{ width: '100%' }} value={formData.date_range_end} onChange={e => setFormData({...formData, date_range_end: e.target.value})} />
                                </div>
                            </div>

                            <div>
                                <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Investigator Remarks</label>
                                <textarea className="input" style={{ width: '100%', minHeight: '80px', resize: 'vertical' }} value={formData.remarks} onChange={e => setFormData({...formData, remarks: e.target.value})} placeholder="Private notes, case numbers, etc." />
                            </div>

                            <div className="flex justify-end gap-12 mt-8">
                                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">{editingId ? 'Save Changes' : 'Create Case'}</button>
                            </div>
                        </form>
                    </div>
                </div>,
                document.body
            )}

            {/* Delete Confirmation Modal */}
            {deleteConfirm && createPortal(
                <div className="modal-overlay" onClick={() => !deleting && setDeleteConfirm(null)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
                    <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '450px' }}>
                        {(() => {
                            const inv = investigations.find(i => i.id === deleteConfirm);
                            return (
                                <>
                                    <h3 className="m-0 mb-16 text-lg fw-bold" style={{ color: 'var(--error)' }}>Delete Investigation</h3>
                                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '8px' }}>
                                        Are you sure you want to permanently delete <strong>{inv?.name}</strong>?
                                    </p>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
                                        This will remove <strong>{inv?.document_count?.toLocaleString() || 0}</strong> documents ({inv?.email_count?.toLocaleString() || 0} emails, {inv?.attachment_count?.toLocaleString() || 0} attachments), all associated reviews, tags, classifications, and uploaded files from disk. This cannot be undone.
                                    </p>
                                    <div className="flex justify-end gap-12">
                                        <button className="btn btn-ghost" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</button>
                                        <button className="btn" style={{ background: 'var(--error)', color: '#fff', border: 'none' }}
                                            onClick={() => handleDelete(deleteConfirm)} disabled={deleting}>
                                            {deleting ? 'Deleting...' : 'Delete Everything'}
                                        </button>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                </div>,
                document.body
            )}
            {/* Members Modal */}
            {membersInvId && createPortal(
                <div className="modal-overlay" onClick={() => setMembersInvId(null)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
                    <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '500px', maxHeight: '80vh', overflowY: 'auto' }}>
                        <div className="flex items-center justify-between mb-24">
                            <h3 className="m-0 text-lg fw-bold text-primary">
                                Members — {investigations.find(i => i.id === membersInvId)?.name}
                            </h3>
                            <button className="btn btn-ghost btn-sm" onClick={() => setMembersInvId(null)}>&#10005;</button>
                        </div>

                        {membersLoading ? (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
                        ) : (
                            <>
                                {/* Add member */}
                                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                                    <select
                                        value={addUserId}
                                        onChange={e => setAddUserId(e.target.value)}
                                        className="input"
                                        style={{ flex: 1, fontSize: '13px' }}
                                    >
                                        <option value="">Select user to add...</option>
                                        {allUsers
                                            .filter(u => u.is_active && !members.some(m => m.id === u.id))
                                            .map(u => (
                                                <option key={u.id} value={u.id}>{u.name} ({u.email}) — {u.role}</option>
                                            ))
                                        }
                                    </select>
                                    <button className="btn btn-primary btn-sm" onClick={handleAddMember} disabled={!addUserId}>
                                        Add
                                    </button>
                                </div>

                                {/* Member list */}
                                {members.length === 0 ? (
                                    <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                                        No members yet. Add users to grant them access to this investigation.
                                    </div>
                                ) : (
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                        <thead>
                                            <tr style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                                                <th style={thStyle}>User</th>
                                                <th style={thStyle}>Role</th>
                                                <th style={thStyle}>Added</th>
                                                <th style={{ ...thStyle, textAlign: 'center' }}></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {members.map(m => (
                                                <tr key={m.id} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                                                    <td style={tdStyle}>
                                                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.name}</div>
                                                        <div className="text-xs text-muted">{m.email}</div>
                                                    </td>
                                                    <td style={tdStyle}>
                                                        <span style={{
                                                            padding: '2px 8px', borderRadius: 10, fontSize: '11px', fontWeight: 600,
                                                            background: m.global_role === 'admin' ? 'rgba(99,102,241,0.15)' : m.global_role === 'reviewer' ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
                                                            color: m.global_role === 'admin' ? '#818cf8' : m.global_role === 'reviewer' ? '#22c55e' : '#94a3b8',
                                                        }}>
                                                            {m.global_role}
                                                        </span>
                                                    </td>
                                                    <td style={tdStyle} className="text-xs">
                                                        {new Date(m.added_at).toLocaleDateString()}
                                                    </td>
                                                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                                                        <button
                                                            className="btn btn-ghost btn-sm"
                                                            style={{ fontSize: '11px', color: 'var(--error)' }}
                                                            onClick={() => handleRemoveMember(m.id)}
                                                        >
                                                            Remove
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}

                                <div style={{ marginTop: '12px', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 6, fontSize: '12px', color: 'var(--text-muted)' }}>
                                    Admins always have access to all investigations. Only non-admin users need explicit membership.
                                </div>
                            </>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

export default Investigations;
