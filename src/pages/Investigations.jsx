import { useState, useEffect } from 'react';
import { formatSize } from '../utils/format';

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

            <div className="grid-stats">
                {investigations.filter(inv => inv.status !== 'archived').map(inv => {
                    const isActive = inv.id === activeInvestigationId;
                    return (
                        <div key={inv.id} className={`card ${isActive ? 'ring-2 ring-primary bg-primary-10' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative' }}>
                            {isActive && (
                                <div style={{ position: 'absolute', top: '12px', right: '12px' }}>
                                    <span className="status-badge ready">Active Case</span>
                                </div>
                            )}
                            <div>
                                <h3 className="text-lg fw-bold m-0" style={{ color: 'var(--text-primary)' }}>{inv.name}</h3>
                                {inv.description && <p className="text-sm text-secondary mt-4 mb-0">{inv.description}</p>}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div>
                                    <span className="text-xs text-muted block uppercase tracking-wide">Documents</span>
                                    <span className="text-sm fw-bold">{inv.document_count?.toLocaleString() || 0}</span>
                                </div>
                                <div>
                                    <span className="text-xs text-muted block uppercase tracking-wide">Reviewed</span>
                                    <span className="text-sm fw-bold">{inv.reviewed_count?.toLocaleString() || 0}</span>
                                </div>
                            </div>
                            
                            {(inv.date_range_start || inv.date_range_end) && (
                                <div className="text-xs text-muted">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: '4px' }}>
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>
                                    </svg>
                                    Period: {inv.date_range_start || 'Any'} to {inv.date_range_end || 'Any'}
                                </div>
                            )}

                            <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'flex-end' }}>
                                {!isActive && (
                                    <button className="btn btn-outline" onClick={() => {
                                        if (onInvestigationChange) onInvestigationChange(inv.id);
                                        addToast(`Switched to ${inv.name}`, 'success');
                                    }}>
                                        Switch to Case
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 100 }}>
                    <div className="card" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto' }}>
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
                </div>
            )}
        </div>
    );
}

export default Investigations;
