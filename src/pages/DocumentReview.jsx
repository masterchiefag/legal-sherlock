import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';

const REVIEW_OPTIONS = [
    { status: 'relevant', label: 'Relevant', color: '#10b981', key: 'r' },
    { status: 'not_relevant', label: 'Not Relevant', color: '#ef4444', key: 'n' },
    { status: 'privileged', label: 'Privileged', color: '#f59e0b', key: 'p' },
];

function DocumentReview({ addToast }) {
    const { id } = useParams();
    const navigate = useNavigate();
    const [doc, setDoc] = useState(null);
    const [loading, setLoading] = useState(true);
    const [allTags, setAllTags] = useState([]);
    const [reviewStatus, setReviewStatus] = useState('pending');
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);
    const [newTagName, setNewTagName] = useState('');
    const [showNewTag, setShowNewTag] = useState(false);
    const [textSearch, setTextSearch] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // AI Classification state
    const [investigationPrompt, setInvestigationPrompt] = useState(
        () => localStorage.getItem('sherlock_investigation_prompt') || ''
    );
    const [classifying, setClassifying] = useState(false);
    const [classification, setClassification] = useState(null);
    const [classificationHistory, setClassificationHistory] = useState([]);

    const loadDocument = useCallback(async () => {
        try {
            const [docRes, tagsRes] = await Promise.all([
                fetch(`/api/documents/${id}`),
                fetch('/api/tags'),
            ]);
            const docData = await docRes.json();
            const tagsData = await tagsRes.json();

            if (docRes.ok) {
                setDoc(docData);
                if (docData.reviews?.length > 0) {
                    setReviewStatus(docData.reviews[0].status);
                    setNotes(docData.reviews[0].notes || '');
                } else {
                    setReviewStatus('pending');
                    setNotes('');
                }
            }
            setAllTags(tagsData);
        } catch (err) {
            console.error('Failed to load document:', err);
        }
        setLoading(false);
    }, [id]);

    useEffect(() => { setLoading(true); loadDocument(); loadClassifications(); }, [loadDocument]);

    const loadClassifications = useCallback(async () => {
        try {
            const res = await fetch(`/api/classify/${id}`);
            const data = await res.json();
            if (data.classifications?.length > 0) {
                setClassification(data.classifications[0]);
                setClassificationHistory(data.classifications);
                // Restore the prompt from the last classification
                if (!investigationPrompt && data.classifications[0].investigation_prompt) {
                    setInvestigationPrompt(data.classifications[0].investigation_prompt);
                }
            } else {
                setClassification(null);
                setClassificationHistory([]);
            }
        } catch (err) {
            console.error('Failed to load classifications:', err);
        }
    }, [id]);

    const handleClassify = async () => {
        if (!investigationPrompt.trim() || classifying) return;
        setClassifying(true);
        localStorage.setItem('sherlock_investigation_prompt', investigationPrompt);
        try {
            const res = await fetch(`/api/classify/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ investigationPrompt: investigationPrompt.trim() }),
            });
            const data = await res.json();
            if (res.ok) {
                setClassification(data);
                loadClassifications();
                addToast(`Classified: ${data.score}/5`, 'success');
            } else {
                addToast(data.error || 'Classification failed', 'error');
            }
        } catch (err) {
            addToast('Classification failed: ' + err.message, 'error');
        }
        setClassifying(false);
    };

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            const option = REVIEW_OPTIONS.find(o => o.key === e.key);
            if (option) handleReview(option.status);
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [id]);

    const handleReview = async (status) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/reviews/documents/${id}/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, notes }),
            });
            if (res.ok) {
                setReviewStatus(status);
                addToast(`Marked as ${status.replace('_', ' ')}`, 'success');
                loadDocument();
            }
        } catch (err) {
            addToast('Failed to save review', 'error');
        }
        setSaving(false);
    };

    const saveNotes = async () => {
        setSaving(true);
        try {
            await fetch(`/api/reviews/documents/${id}/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: reviewStatus, notes }),
            });
            addToast('Notes saved', 'success');
            loadDocument();
        } catch (err) {
            addToast('Failed to save notes', 'error');
        }
        setSaving(false);
    };

    const toggleTag = async (tagId) => {
        const hasTag = doc.tags?.some(t => t.id === tagId);
        try {
            if (hasTag) {
                await fetch(`/api/tags/documents/${id}/tags/${tagId}`, { method: 'DELETE' });
            } else {
                await fetch(`/api/tags/documents/${id}/tags`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tag_id: tagId }),
                });
            }
            loadDocument();
        } catch (err) {
            addToast('Failed to update tags', 'error');
        }
    };

    const createTag = async () => {
        if (!newTagName.trim()) return;
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        try {
            const res = await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newTagName.trim(), color }),
            });
            if (res.ok) {
                setNewTagName('');
                setShowNewTag(false);
                const tagsRes = await fetch('/api/tags');
                setAllTags(await tagsRes.json());
                addToast('Tag created', 'success');
            } else {
                const err = await res.json();
                addToast(err.error, 'error');
            }
        } catch (err) {
            addToast('Failed to create tag', 'error');
        }
    };

    const requestDelete = () => {
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        try {
            await fetch(`/api/documents/${id}`, { method: 'DELETE' });
            addToast('Document deleted', 'success');
            navigate('/search');
        } catch (err) {
            addToast('Failed to delete', 'error');
            setShowDeleteConfirm(false);
        }
    };

    const cancelDelete = () => {
        setShowDeleteConfirm(false);
    };

    // Highlight search term in text
    const highlightedText = textSearch.trim()
        ? doc?.text_content?.replace(
            new RegExp(`(${textSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
            '<mark>$1</mark>'
        )
        : doc?.text_content;

    if (loading) return <div className="loading-overlay"><div className="spinner"></div></div>;

    if (!doc) {
        return (
            <div className="empty-state">
                <h3 className="empty-state-title">Document not found</h3>
                <button className="btn btn-secondary mt-16" onClick={() => navigate('/search')}>← Back to Search</button>
            </div>
        );
    }

    const isEmail = doc.doc_type === 'email';

    return (
        <div className="doc-viewer fade-in">
            {/* Text Viewer */}
            <div className="doc-text-panel">
                {/* In-doc search */}
                <div className="input-group mb-16">
                    <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '16px', height: '16px', left: '12px' }}>
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        className="input search-input"
                        placeholder="Search within document…"
                        value={textSearch}
                        onChange={(e) => setTextSearch(e.target.value)}
                        style={{ padding: '8px 12px 8px 38px', fontSize: '13px' }}
                    />
                </div>

                {/* Email header bar */}
                {isEmail && (
                    <div style={{
                        padding: '16px 20px',
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '13px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        border: '1px solid var(--border-secondary)'
                    }}>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                            {doc.email_subject || '(no subject)'}
                        </div>
                        <div className="flex gap-8">
                            <span style={{ color: 'var(--text-tertiary)', minWidth: '40px' }}>From</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{doc.email_from || '—'}</span>
                        </div>
                        <div className="flex gap-8">
                            <span style={{ color: 'var(--text-tertiary)', minWidth: '40px' }}>To</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{doc.email_to || '—'}</span>
                        </div>
                        {doc.email_cc && (
                            <div className="flex gap-8">
                                <span style={{ color: 'var(--text-tertiary)', minWidth: '40px' }}>CC</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{doc.email_cc}</span>
                            </div>
                        )}
                        <div className="flex gap-8">
                            <span style={{ color: 'var(--text-tertiary)', minWidth: '40px' }}>Date</span>
                            <span style={{ color: 'var(--text-secondary)' }}>
                                {doc.email_date ? new Date(doc.email_date).toLocaleString() : '—'}
                            </span>
                        </div>
                    </div>
                )}

                {highlightedText ? (
                    <div className="doc-text-content" dangerouslySetInnerHTML={{ __html: highlightedText }} />
                ) : (
                    <div className="empty-state">
                        <p className="empty-state-text">No text content available for this document.</p>
                    </div>
                )}
            </div>

            {/* Sidebar */}
            <div className="doc-sidebar-panel">
                {/* Document / Email Info */}
                <div className="doc-sidebar-section">
                    <h3>{isEmail ? 'Email Info' : 'Document Info'}</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                        <div className="flex justify-between">
                            <span className="text-muted">Name</span>
                            <span style={{ color: 'var(--text-primary)', fontWeight: 500, textAlign: 'right', maxWidth: '200px', wordBreak: 'break-word' }}>
                                {isEmail ? (doc.email_subject || doc.original_name) : doc.original_name}
                            </span>
                        </div>
                        {isEmail && (
                            <div className="flex justify-between">
                                <span className="text-muted">Type</span>
                                <span style={{ color: 'var(--text-accent)' }}>✉ Email</span>
                            </div>
                        )}
                        <div className="flex justify-between">
                            <span className="text-muted">Size</span>
                            <span style={{ color: 'var(--text-primary)' }}>{formatSize(doc.size_bytes)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted">Uploaded</span>
                            <span style={{ color: 'var(--text-primary)' }}>{new Date(doc.uploaded_at).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted">Status</span>
                            <span className={`status-badge ${doc.status}`}>{doc.status}</span>
                        </div>
                    </div>
                </div>

                {/* Email Thread */}
                {doc.thread && doc.thread.length > 1 && (
                    <div className="doc-sidebar-section">
                        <h3>Thread ({doc.thread.length} emails)</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {doc.thread.map((t, i) => (
                                <Link
                                    key={t.id}
                                    to={`/documents/${t.id}`}
                                    style={{
                                        display: 'block',
                                        padding: '10px 12px',
                                        borderRadius: 'var(--radius-sm)',
                                        background: t.id === id ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-tertiary)',
                                        border: `1px solid ${t.id === id ? 'var(--border-active)' : 'var(--border-secondary)'}`,
                                        textDecoration: 'none',
                                        transition: 'all 150ms ease',
                                    }}
                                    onMouseEnter={e => { if (t.id !== id) e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
                                    onMouseLeave={e => { if (t.id !== id) e.currentTarget.style.borderColor = 'var(--border-secondary)'; }}
                                >
                                    <div style={{ fontSize: '12px', fontWeight: 600, color: t.id === id ? 'var(--text-accent)' : 'var(--text-primary)', marginBottom: '2px' }}>
                                        {t.email_subject || t.original_name}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                        {t.email_from?.split('<')[0].trim()} • {t.email_date ? new Date(t.email_date).toLocaleDateString() : ''}
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* Attachments */}
                {doc.attachments && doc.attachments.length > 0 && (
                    <div className="doc-sidebar-section">
                        <h3>Attachments ({doc.attachments.length})</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {doc.attachments.map(att => {
                                const ext = att.original_name?.split('.').pop().toLowerCase() || '';
                                return (
                                    <a
                                        key={att.id}
                                        href={`/uploads/${att.filename}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ textDecoration: 'none' }}
                                    >
                                        <div className="file-item" style={{ cursor: 'pointer' }}>
                                            <div className={`file-icon ${ext}`}>{ext || '?'}</div>
                                            <div className="file-info">
                                                <div className="file-name">{att.original_name}</div>
                                                <div className="file-meta">{formatSize(att.size_bytes)}</div>
                                            </div>
                                        </div>
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Parent email (if this is an attachment) */}
                {doc.parent && (
                    <div className="doc-sidebar-section">
                        <h3>Parent Email</h3>
                        <Link
                            to={`/documents/${doc.parent.id}`}
                            style={{
                                display: 'block',
                                padding: '10px 12px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-secondary)',
                                textDecoration: 'none',
                            }}
                        >
                            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-accent)', marginBottom: '2px' }}>
                                ✉ {doc.parent.email_subject || doc.parent.original_name}
                            </div>
                            {doc.parent.email_from && (
                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                    From: {doc.parent.email_from.split('<')[0].trim()}
                                </div>
                            )}
                        </Link>
                    </div>
                )}

                {/* AI Classification */}
                <div className="doc-sidebar-section">
                    <h3>🔍 AI Classification</h3>
                    <textarea
                        className="textarea"
                        placeholder="Describe the investigation focus, e.g. 'Find evidence of bribery, off-the-books payments, or corruption involving government officials'"
                        value={investigationPrompt}
                        onChange={(e) => setInvestigationPrompt(e.target.value)}
                        rows="3"
                        style={{ fontSize: '12px', marginBottom: '8px' }}
                    />
                    <button
                        className="btn btn-primary btn-sm"
                        onClick={handleClassify}
                        disabled={classifying || !investigationPrompt.trim()}
                        style={{ width: '100%', position: 'relative' }}
                    >
                        {classifying ? (
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                <span className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px' }}></span>
                                Analyzing…
                            </span>
                        ) : '🔍 Classify Document'}
                    </button>

                    {/* Classification Result */}
                    {classification && (
                        <div style={{
                            marginTop: '12px',
                            padding: '14px',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--bg-tertiary)',
                            border: `1px solid ${getScoreColor(classification.score)}30`,
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                                <div style={{
                                    width: '36px', height: '36px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: `${getScoreColor(classification.score)}20`,
                                    color: getScoreColor(classification.score),
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: 700, fontSize: '18px',
                                    border: `2px solid ${getScoreColor(classification.score)}40`,
                                }}>
                                    {classification.score}
                                </div>
                                <div>
                                    <div style={{ fontSize: '13px', fontWeight: 600, color: getScoreColor(classification.score) }}>
                                        {getScoreLabel(classification.score)}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                        {classification.model || 'unknown'} • {classification.elapsed_seconds ? `${classification.elapsed_seconds}s` : ''}
                                    </div>
                                </div>
                            </div>
                            <div style={{
                                fontSize: '12px',
                                color: 'var(--text-secondary)',
                                lineHeight: '1.5',
                                padding: '8px 10px',
                                background: 'var(--bg-primary)',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--border-secondary)',
                            }}>
                                {classification.reasoning}
                            </div>
                        </div>
                    )}

                    {/* Classification History */}
                    {classificationHistory.length > 1 && (
                        <details style={{ marginTop: '8px' }}>
                            <summary style={{ fontSize: '11px', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
                                Previous classifications ({classificationHistory.length - 1})
                            </summary>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                                {classificationHistory.slice(1).map(c => (
                                    <div key={c.id} style={{
                                        padding: '6px 8px',
                                        borderRadius: 'var(--radius-sm)',
                                        background: 'var(--bg-primary)',
                                        border: '1px solid var(--border-secondary)',
                                        fontSize: '11px',
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ fontWeight: 600, color: getScoreColor(c.score) }}>
                                                Score: {c.score}/5
                                            </span>
                                            <span style={{ color: 'var(--text-tertiary)' }}>
                                                {new Date(c.classified_at).toLocaleString()}
                                            </span>
                                        </div>
                                        <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                                            {c.reasoning?.substring(0, 100)}{c.reasoning?.length > 100 ? '…' : ''}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </details>
                    )}
                </div>

                {/* Review Status */}
                <div className="doc-sidebar-section">
                    <h3>Review Decision</h3>
                    <div className="review-actions">
                        {REVIEW_OPTIONS.map(opt => (
                            <button
                                key={opt.status}
                                className={`review-btn ${reviewStatus === opt.status ? `active-${opt.status}` : ''}`}
                                onClick={() => handleReview(opt.status)}
                                disabled={saving}
                            >
                                <span className="review-dot" style={{ background: opt.color }}></span>
                                {opt.label}
                                <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.5, fontFamily: 'var(--font-mono)' }}>
                                    {opt.key.toUpperCase()}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Notes */}
                <div className="doc-sidebar-section">
                    <h3>Review Notes</h3>
                    <textarea
                        className="textarea"
                        placeholder="Add review notes…"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows="4"
                    />
                    <button className="btn btn-secondary btn-sm mt-16" onClick={saveNotes} disabled={saving} style={{ width: '100%' }}>
                        {saving ? 'Saving…' : 'Save Notes'}
                    </button>
                </div>

                {/* Tags */}
                <div className="doc-sidebar-section">
                    <div className="flex justify-between items-center mb-8">
                        <h3 style={{ margin: 0 }}>Tags</h3>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowNewTag(!showNewTag)}>+ New</button>
                    </div>

                    {showNewTag && (
                        <div className="flex gap-8 mb-8">
                            <input
                                type="text"
                                className="input"
                                placeholder="Tag name"
                                value={newTagName}
                                onChange={(e) => setNewTagName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && createTag()}
                                style={{ padding: '6px 12px', fontSize: '13px' }}
                            />
                            <button className="btn btn-primary btn-sm" onClick={createTag}>Add</button>
                        </div>
                    )}

                    <div className="tag-selector">
                        {allTags.map(tag => {
                            const isSelected = doc.tags?.some(t => t.id === tag.id);
                            return (
                                <button
                                    key={tag.id}
                                    className={`tag-option ${isSelected ? 'selected' : ''}`}
                                    style={isSelected ? { background: `${tag.color}20`, color: tag.color, borderColor: `${tag.color}40` } : {}}
                                    onClick={() => toggleTag(tag.id)}
                                >
                                    {tag.name}
                                </button>
                            );
                        })}
                        {allTags.length === 0 && <span className="text-sm text-muted">No tags created yet</span>}
                    </div>
                </div>

                {/* Actions */}
                <div className="doc-sidebar-section">
                    <h3>Actions</h3>
                    <div className="flex flex-col gap-8">
                        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/search')} style={{ width: '100%' }}>
                            ← Back to Search
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={requestDelete} style={{ width: '100%' }}>
                            Delete Document
                        </button>
                    </div>
                </div>
            </div>

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
                }}>
                    <div className="card fade-in" style={{ width: '400px', maxWidth: '90vw' }}>
                        <h3 className="text-danger" style={{ marginTop: 0 }}>Delete Document?</h3>
                        <p className="text-muted">Are you sure you want to permanently delete this document and all its attachments? This action cannot be undone.</p>
                        <div className="flex justify-end gap-8 mt-24">
                            <button className="btn btn-ghost" onClick={cancelDelete}>Cancel</button>
                            <button className="btn btn-danger" onClick={confirmDelete}>Yes, Delete</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function formatSize(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getScoreColor(score) {
    const colors = { 1: '#6b7280', 2: '#3b82f6', 3: '#f59e0b', 4: '#f97316', 5: '#ef4444' };
    return colors[score] || '#6b7280';
}

function getScoreLabel(score) {
    const labels = { 1: 'Not Relevant', 2: 'Unlikely Relevant', 3: 'Potentially Relevant', 4: 'Highly Relevant', 5: 'Smoking Gun' };
    return labels[score] || 'Unknown';
}

export default DocumentReview;
