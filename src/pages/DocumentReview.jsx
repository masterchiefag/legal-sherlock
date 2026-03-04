import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

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
                // Set current review status from latest review
                if (docData.reviews?.length > 0) {
                    setReviewStatus(docData.reviews[0].status);
                    setNotes(docData.reviews[0].notes || '');
                }
            }
            setAllTags(tagsData);
        } catch (err) {
            console.error('Failed to load document:', err);
        }
        setLoading(false);
    }, [id]);

    useEffect(() => { loadDocument(); }, [loadDocument]);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            const option = REVIEW_OPTIONS.find(o => o.key === e.key);
            if (option) {
                handleReview(option.status);
            }
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

    const deleteDoc = async () => {
        if (!confirm('Delete this document permanently?')) return;
        try {
            await fetch(`/api/documents/${id}`, { method: 'DELETE' });
            addToast('Document deleted', 'success');
            navigate('/search');
        } catch (err) {
            addToast('Failed to delete', 'error');
        }
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
                {/* Document Info */}
                <div className="doc-sidebar-section">
                    <h3>Document Info</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                        <div className="flex justify-between">
                            <span className="text-muted">Name</span>
                            <span style={{ color: 'var(--text-primary)', fontWeight: 500, textAlign: 'right', maxWidth: '200px', wordBreak: 'break-word' }}>{doc.original_name}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted">Size</span>
                            <span style={{ color: 'var(--text-primary)' }}>{formatSize(doc.size_bytes)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted">Type</span>
                            <span style={{ color: 'var(--text-primary)' }}>{doc.mime_type}</span>
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
                        {allTags.length === 0 && (
                            <span className="text-sm text-muted">No tags created yet</span>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="doc-sidebar-section">
                    <h3>Actions</h3>
                    <div className="flex flex-col gap-8">
                        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/search')} style={{ width: '100%' }}>
                            ← Back to Search
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={deleteDoc} style={{ width: '100%' }}>
                            Delete Document
                        </button>
                    </div>
                </div>
            </div>
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

export default DocumentReview;
