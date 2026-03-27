import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatSize } from '../utils/format';

const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' };
const tdStyle = { padding: '12px 14px', color: 'var(--text-secondary)' };

function Investigations({ activeInvestigationId, onInvestigationChange, addToast }) {
    const [investigations, setInvestigations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState({
        name: '', description: '', allegation: '', key_parties: '',
        remarks: '', date_range_start: '', date_range_end: ''
    });

    const loadInvestigations = async () => {
        try {
            const res = await fetch('/api/investigations');
            if (res.ok) {
                const data = await res.json();
                setInvestigations(data);
                // If no active case is set, or the active case is not in the list (e.g., archived),
                // default to the first one available.
                if (data.length > 0 && (!activeInvestigationId || !data.some(i => i.id === activeInvestigationId))) {
                    const defaultGeneral = data.find(i => i.name === 'General Investigation') || data[0];
                    if (onInvestigationChange) onInvestigationChange(defaultGeneral.id);
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

    useEffect(() => {
        loadInvestigations();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await fetch('/api/investigations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            if (res.ok) {
                const newInv = await res.json();
                setInvestigations(prev => [newInv, ...prev]);
                setShowModal(false);
                setFormData({ name: '', description: '', allegation: '', key_parties: '', remarks: '', date_range_start: '', date_range_end: '' });
                addToast('Investigation created successfully', 'success');
                if (onInvestigationChange) onInvestigationChange(newInv.id);
            } else {
                const data = await res.json();
                addToast(data.error || 'Failed to create investigation', 'error');
            }
        } catch (err) {
            addToast('Network error', 'error');
        }
    };

    if (loading) {
        return <div className="loading-overlay"><div className="spinner"></div></div>;
    }

    return (
        <div className="fade-in max-w-5xl">
            <div className="flex items-center justify-between mb-24">
                <div>
                    <h2 className="text-xl fw-bold m-0" style={{ color: 'var(--text-primary)' }}>Manage Investigations</h2>
                    <p className="text-sm text-muted mt-4 mb-0">Switch between cases or create a new investigation to scope your workspace.</p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowModal(true)}>
                    + New Investigation
                </button>
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-secondary)' }}>
                            <th style={thStyle}>Case Name</th>
                            <th style={thStyle}>Source File</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Emails</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Attachments</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Total Docs</th>
                            <th style={thStyle}>Imported</th>
                            <th style={thStyle}>Status</th>
                            <th style={{ ...thStyle, textAlign: 'center' }}>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {investigations.filter(inv => inv.status !== 'archived').map(inv => {
                            const isActive = inv.id === activeInvestigationId;
                            const jobs = inv.import_jobs || [];
                            const latestJob = jobs[0];
                            const sourceFiles = jobs.map(j => j.original_name).filter(Boolean);
                            const uniqueFiles = [...new Set(sourceFiles)];
                            return (
                                <tr key={inv.id} style={{
                                    borderBottom: '1px solid var(--border-secondary)',
                                    background: isActive ? 'var(--bg-primary-subtle, rgba(99, 102, 241, 0.06))' : 'transparent'
                                }}>
                                    <td style={tdStyle}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span className="fw-bold" style={{ color: 'var(--text-primary)' }}>{inv.name}</span>
                                            {isActive && <span className="status-badge ready" style={{ fontSize: '10px', padding: '2px 6px' }}>Active</span>}
                                        </div>
                                        {inv.description && <div className="text-xs text-muted" style={{ marginTop: '2px' }}>{inv.description}</div>}
                                    </td>
                                    <td style={tdStyle}>
                                        {uniqueFiles.length > 0
                                            ? uniqueFiles.map((f, i) => <div key={i} className="text-xs" style={{ color: 'var(--text-secondary)' }}>{f}</div>)
                                            : <span className="text-xs text-muted">-</span>
                                        }
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                        {inv.email_count?.toLocaleString() || 0}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                        {inv.attachment_count?.toLocaleString() || 0}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                                        {inv.document_count?.toLocaleString() || 0}
                                    </td>
                                    <td style={tdStyle}>
                                        {latestJob?.completed_at
                                            ? <span className="text-xs">{new Date(latestJob.completed_at + 'Z').toLocaleDateString()}</span>
                                            : latestJob?.started_at
                                                ? <span className="text-xs text-muted">{new Date(latestJob.started_at + 'Z').toLocaleDateString()}</span>
                                                : <span className="text-xs text-muted">-</span>
                                        }
                                    </td>
                                    <td style={tdStyle}>
                                        {latestJob ? (
                                            <span className={`status-badge ${latestJob.status === 'completed' ? 'ready' : latestJob.status === 'processing' ? 'processing' : 'error'}`} style={{ fontSize: '11px' }}>
                                                {latestJob.status === 'completed' ? 'Imported' : latestJob.status === 'processing' ? 'Importing...' : 'Failed'}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-muted">No imports</span>
                                        )}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                                        {!isActive && (
                                            <button className="btn btn-outline btn-sm" style={{ fontSize: '11px', padding: '4px 10px' }} onClick={() => {
                                                if (onInvestigationChange) onInvestigationChange(inv.id);
                                                addToast(`Switched to ${inv.name}`, 'success');
                                            }}>
                                                Switch
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Modal */}
            {showModal && createPortal(
                <div className="modal-overlay" onClick={() => setShowModal(false)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
                    <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <div className="flex items-center justify-between mb-24">
                            <h3 className="m-0 text-lg fw-bold text-primary">Create New Investigation</h3>
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowModal(false)}>✕</button>
                        </div>
                        
                        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div>
                                <label className="form-label" style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Investigation Name *</label>
                                <input required type="text" className="input" style={{ width: '100%' }} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Project Apollo Internal Review" />
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
                                <button type="submit" className="btn btn-primary">Create Case</button>
                            </div>
                        </form>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

export default Investigations;
