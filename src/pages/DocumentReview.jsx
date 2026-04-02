import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { formatSize, getScoreColor, getScoreLabel } from '../utils/format';
import { highlightText } from '../utils/sanitize';

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
    const [searchParams] = useSearchParams();
    const [textSearch, setTextSearch] = useState(() => searchParams.get('q') || '');
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

    // Highlight search term in text (HTML-escaped for XSS safety)
    const highlightedText = highlightText(doc?.text_content, textSearch);

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
    const isChat = doc.doc_type === 'chat';

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
                        {doc.email_bcc && (
                            <div className="flex gap-8">
                                <span style={{ color: 'var(--text-tertiary)', minWidth: '40px' }}>BCC</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{doc.email_bcc}</span>
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

                {doc.status === 'processing' ? (
                    <div className="empty-state">
                        <div className="spinner" style={{ marginBottom: '12px' }}></div>
                        <p className="empty-state-text">Text extraction in progress. Content will appear shortly.</p>
                    </div>
                ) : (() => {
                    const ext = doc.original_name?.split('.').pop().toLowerCase() || '';
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'];
                    const isImage = imageExts.includes(ext);
                    const isPdf = ext === 'pdf';
                    // Oversized files — no raw file on disk
                    if (!doc.filename) {
                        const sizeMB = doc.size_bytes ? (doc.size_bytes / 1e6).toFixed(0) : '?';
                        return (
                            <div style={{ padding: '24px', textAlign: 'center' }}>
                                <div style={{ background: 'var(--bg-tertiary)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-secondary)', display: 'inline-block', maxWidth: '500px' }}>
                                    <div style={{ fontSize: '36px', marginBottom: '12px' }}>📦</div>
                                    <p style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '8px' }}>
                                        Large file ({sizeMB} MB)
                                    </p>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0 }}>
                                        Raw file was not saved to conserve disk space. Metadata and parent email are still available.
                                    </p>
                                </div>
                            </div>
                        );
                    }
                    if (isImage) {
                        return (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px' }}>
                                <img
                                    src={`/uploads/${doc.filename}`}
                                    alt={doc.original_name}
                                    style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: '8px', border: '1px solid var(--border-secondary)' }}
                                />
                                <a
                                    href={`/uploads/${doc.filename}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ marginTop: '12px', color: 'var(--text-accent)', fontSize: '13px' }}
                                >
                                    Open full size ↗
                                </a>
                            </div>
                        );
                    }
                    if (isPdf) {
                        return (
                            <div>
                                <div style={{ display: 'flex', flexDirection: 'column', height: '80vh' }}>
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 0' }}>
                                        <a
                                            href={`/uploads/${doc.filename}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{ color: 'var(--text-accent)', fontSize: '13px' }}
                                        >
                                            Open in new tab ↗
                                        </a>
                                    </div>
                                    <object
                                        data={`/uploads/${doc.filename}`}
                                        type="application/pdf"
                                        style={{ width: '100%', flex: 1, border: 'none', borderRadius: '8px' }}
                                    >
                                        <div className="empty-state" style={{ padding: '48px' }}>
                                            <p className="empty-state-text">PDF preview not available in this browser.</p>
                                            <a
                                                href={`/uploads/${doc.filename}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="btn btn-outline btn-sm"
                                                style={{ marginTop: '12px' }}
                                            >
                                                Open PDF ↗
                                            </a>
                                        </div>
                                    </object>
                                </div>
                                {highlightedText?.trim() && (
                                    <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-secondary)', paddingTop: '20px' }}>
                                        <h4 style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                            Extracted Text
                                        </h4>
                                        <div className="doc-text-content" dangerouslySetInnerHTML={{ __html: highlightedText }} />
                                    </div>
                                )}
                            </div>
                        );
                    }
                    if (highlightedText?.trim()) {
                        return (
                            <div className="doc-text-content" dangerouslySetInnerHTML={{ __html: highlightedText }} />
                        );
                    }
                    // For emails with no body, show metadata summary
                    if (doc.doc_type === 'email') {
                        return (
                            <div style={{ padding: '24px', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.8' }}>
                                <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: '16px' }}>
                                    This email has no text body{doc.attachments?.length > 0 ? ' — content may be in the attachments below.' : '.'}
                                </p>
                                <div style={{ background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-secondary)' }}>
                                    {doc.email_subject && <p style={{ margin: '0 0 8px' }}><strong>Subject:</strong> {doc.email_subject}</p>}
                                    {doc.email_from && <p style={{ margin: '0 0 8px' }}><strong>From:</strong> {doc.email_from}</p>}
                                    {doc.email_to && <p style={{ margin: '0 0 8px' }}><strong>To:</strong> {doc.email_to}</p>}
                                    {doc.email_cc && <p style={{ margin: '0 0 8px' }}><strong>Cc:</strong> {doc.email_cc}</p>}
                                    {doc.email_date && <p style={{ margin: '0' }}><strong>Date:</strong> {new Date(doc.email_date).toLocaleString()}</p>}
                                </div>
                            </div>
                        );
                    }
                    return (
                        <div className="empty-state">
                            <p className="empty-state-text">No text content available for this document.</p>
                            <a
                                href={`/uploads/${doc.filename}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-outline btn-sm"
                                style={{ marginTop: '12px' }}
                            >
                                Download file
                            </a>
                        </div>
                    );
                })()}
            </div>

            {/* Sidebar */}
            <div className="doc-sidebar-panel">
                {/* Document / Email Info */}
                <div className="doc-sidebar-section">
                    <h3>{isEmail ? 'Email Info' : isChat ? 'Chat Info' : 'Document Info'}</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                        <div className="flex justify-between">
                            <span className="text-muted">Name</span>
                            <span style={{ color: 'var(--text-primary)', fontWeight: 500, textAlign: 'right', maxWidth: '200px', wordBreak: 'break-word' }}>
                                {isEmail || isChat ? (doc.email_subject || doc.original_name) : doc.original_name}
                            </span>
                        </div>
                        {isEmail && (
                            <div className="flex justify-between">
                                <span className="text-muted">Type</span>
                                <span style={{ color: 'var(--text-accent)' }}>✉ Email</span>
                            </div>
                        )}
                        {isChat && (
                            <div className="flex justify-between">
                                <span className="text-muted">Type</span>
                                <span style={{ color: 'var(--text-accent)' }}>💬 Chat Transcript</span>
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

                {/* Metadata Section */}
                {(isEmail || doc.doc_author || doc.doc_title || doc.doc_created_at || doc.doc_modified_at) && (
                    <div className="doc-sidebar-section">
                        <h3>📋 Metadata</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                            {/* Email transport metadata */}
                            {isEmail && (
                                <>
                                    {doc.email_originating_ip && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Originating IP</span>
                                            <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{doc.email_originating_ip}</span>
                                        </div>
                                    )}
                                    {doc.email_server_info && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Mail Server</span>
                                            <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '11px', maxWidth: '180px', wordBreak: 'break-all', textAlign: 'right' }}>{doc.email_server_info}</span>
                                        </div>
                                    )}
                                    {doc.email_delivery_date && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Delivered</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{new Date(doc.email_delivery_date).toLocaleString()}</span>
                                        </div>
                                    )}
                                    {doc.email_auth_results && (
                                        <div style={{ marginTop: '4px' }}>
                                            <span className="text-muted" style={{ display: 'block', marginBottom: '4px' }}>Auth Results</span>
                                            <div style={{
                                                padding: '6px 8px',
                                                background: 'var(--bg-primary)',
                                                borderRadius: 'var(--radius-sm)',
                                                border: '1px solid var(--border-secondary)',
                                                fontFamily: 'var(--font-mono)',
                                                fontSize: '11px',
                                                color: 'var(--text-secondary)',
                                                wordBreak: 'break-word',
                                                lineHeight: '1.4',
                                            }}>{doc.email_auth_results}</div>
                                        </div>
                                    )}
                                    {doc.email_received_chain && (() => {
                                        try {
                                            const hops = JSON.parse(doc.email_received_chain);
                                            if (hops.length === 0) return null;
                                            return (
                                                <details style={{ marginTop: '4px' }}>
                                                    <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '11px' }}>
                                                        Received chain ({hops.length} hops)
                                                    </summary>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                                                        {hops.map((hop, i) => (
                                                            <div key={i} style={{
                                                                padding: '6px 8px',
                                                                background: 'var(--bg-primary)',
                                                                borderRadius: 'var(--radius-sm)',
                                                                border: '1px solid var(--border-secondary)',
                                                                fontSize: '11px',
                                                                fontFamily: 'var(--font-mono)',
                                                            }}>
                                                                {hop.from && <div style={{ color: 'var(--text-secondary)' }}>from {hop.from}</div>}
                                                                {hop.by && <div style={{ color: 'var(--text-secondary)' }}>by {hop.by}</div>}
                                                                {hop.with && <div style={{ color: 'var(--text-tertiary)' }}>with {hop.with}</div>}
                                                                {hop.ip && <div style={{ color: 'var(--text-accent)' }}>IP: {hop.ip}</div>}
                                                                {hop.date && <div style={{ color: 'var(--text-tertiary)', marginTop: '2px' }}>{new Date(hop.date).toLocaleString()}</div>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            );
                                        } catch (_) { return null; }
                                    })()}
                                </>
                            )}

                            {/* Document metadata */}
                            {!isEmail && (
                                <>
                                    {doc.doc_author && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Author</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{doc.doc_author}</span>
                                        </div>
                                    )}
                                    {doc.doc_title && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Title</span>
                                            <span style={{ color: 'var(--text-primary)', maxWidth: '180px', textAlign: 'right', wordBreak: 'break-word' }}>{doc.doc_title}</span>
                                        </div>
                                    )}
                                    {doc.doc_created_at && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Created</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{new Date(doc.doc_created_at).toLocaleString()}</span>
                                        </div>
                                    )}
                                    {doc.doc_modified_at && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Modified</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{new Date(doc.doc_modified_at).toLocaleString()}</span>
                                        </div>
                                    )}
                                    {doc.doc_creator_tool && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Created With</span>
                                            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', maxWidth: '180px', textAlign: 'right' }}>{doc.doc_creator_tool}</span>
                                        </div>
                                    )}
                                    {doc.doc_keywords && (
                                        <div className="flex justify-between">
                                            <span className="text-muted">Keywords</span>
                                            <span style={{ color: 'var(--text-secondary)', maxWidth: '180px', textAlign: 'right', wordBreak: 'break-word' }}>{doc.doc_keywords}</span>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}

                {/* Raw Email Headers */}
                {isEmail && doc.email_headers_raw && (
                    <div className="doc-sidebar-section">
                        <details>
                            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                                📨 Raw Headers
                            </summary>
                            <pre style={{
                                marginTop: '8px',
                                padding: '10px',
                                background: 'var(--bg-primary)',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--border-secondary)',
                                fontSize: '10px',
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--text-secondary)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                maxHeight: '300px',
                                overflowY: 'auto',
                                lineHeight: '1.4',
                            }}>{doc.email_headers_raw}</pre>
                        </details>
                    </div>
                )}

                {/* Email Thread */}
                {doc.thread && doc.thread.length > 1 && (() => {
                    // Build tree from in_reply_to -> message_id relationships
                    const msgIdMap = {};
                    doc.thread.forEach(t => { if (t.message_id) msgIdMap[t.message_id] = t; });

                    // Assign children — orphans (in_reply_to not in thread) go under earliest root
                    doc.thread.forEach(t => { t._children = []; });
                    const roots = [];
                    const orphans = [];
                    doc.thread.forEach(t => {
                        const parent = t.in_reply_to ? msgIdMap[t.in_reply_to] : null;
                        if (parent) {
                            parent._children.push(t);
                        } else if (!t.in_reply_to) {
                            roots.push(t);
                        } else {
                            orphans.push(t); // in_reply_to points outside this thread
                        }
                    });

                    // Handle orphans and multiple roots
                    if (roots.length === 0 && orphans.length > 0) {
                        // No true root — promote earliest orphan as root
                        orphans.sort((a, b) => (a.email_date || '').localeCompare(b.email_date || ''));
                        roots.push(orphans.shift());
                    }
                    // Attach remaining orphans: if earlier than first root, promote to root; otherwise nest
                    if (roots.length > 0 && orphans.length > 0) {
                        const earliestRootDate = roots[0].email_date || '';
                        for (const o of orphans) {
                            if ((o.email_date || '') <= earliestRootDate) {
                                roots.unshift(o); // promote as an earlier root
                            } else {
                                roots[0]._children.push(o);
                            }
                        }
                        // Sort roots chronologically
                        roots.sort((a, b) => (a.email_date || '').localeCompare(b.email_date || ''));
                    }

                    // Flatten tree: create subtree blocks per root, then interleave by root date
                    const subtreeBlocks = [];
                    roots.sort((a, b) => (a.email_date || '').localeCompare(b.email_date || ''));
                    roots.forEach(r => {
                        const block = [];
                        const walk = (node, depth, isLast) => {
                            block.push({ ...node, _depth: depth, _isLast: isLast });
                            const children = node._children.sort((a, b) => (a.email_date || '').localeCompare(b.email_date || ''));
                            children.forEach((child, ci) => walk(child, depth + 1, ci === children.length - 1));
                        };
                        walk(r, 0, true);
                        subtreeBlocks.push(block);
                    });
                    const flatList = subtreeBlocks.flat();

                    const items = flatList.length === doc.thread.length ? flatList : doc.thread.map(t => ({ ...t, _depth: 0, _isLast: true }));

                    return (
                        <div className="doc-sidebar-section">
                            <h3>Thread ({doc.thread.length} messages)</h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
                                {items.map((t, i) => {
                                    // For each depth level, determine if a vertical line should continue
                                    const gutterCols = [];
                                    for (let d = 1; d <= t._depth; d++) {
                                        const isOwnDepth = d === t._depth;
                                        // Check if there's a later sibling at this depth level
                                        const hasMoreAtThisDepth = items.slice(i + 1).some(s => {
                                            if (s._depth < d) return false; // went up past this level
                                            if (s._depth === d) return true;
                                            return false;
                                        }) && !items.slice(i + 1).some((s, si) => {
                                            // But stop if we hit a shallower item before the sibling
                                            return s._depth < d && items.slice(i + 1 + si + 1).some(s2 => s2._depth === d);
                                        });
                                        // Actually simpler: scan forward, if we hit depth < d first, no more siblings
                                        let hasSibling = false;
                                        for (let j = i + 1; j < items.length; j++) {
                                            if (items[j]._depth < d) break;
                                            if (items[j]._depth === d) { hasSibling = true; break; }
                                        }

                                        gutterCols.push(
                                            <div key={d} style={{
                                                width: '18px',
                                                flexShrink: 0,
                                                position: 'relative',
                                            }}>
                                                {isOwnDepth ? (
                                                    <>
                                                        {/* Vertical line from top to middle */}
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: '8px',
                                                            top: 0,
                                                            height: '50%',
                                                            width: '1.5px',
                                                            background: 'var(--text-tertiary)',
                                                            opacity: 0.4,
                                                        }} />
                                                        {/* Horizontal line from middle to right */}
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: '8px',
                                                            top: '50%',
                                                            width: '10px',
                                                            height: '1.5px',
                                                            background: 'var(--text-tertiary)',
                                                            opacity: 0.4,
                                                        }} />
                                                        {/* Continue vertical line below if more siblings */}
                                                        {hasSibling && (
                                                            <div style={{
                                                                position: 'absolute',
                                                                left: '8px',
                                                                top: '50%',
                                                                bottom: 0,
                                                                width: '1.5px',
                                                                background: 'var(--text-tertiary)',
                                                                opacity: 0.4,
                                                            }} />
                                                        )}
                                                    </>
                                                ) : (
                                                    /* Pass-through vertical line for ancestor depth levels */
                                                    hasSibling && (
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: '8px',
                                                            top: 0,
                                                            bottom: 0,
                                                            width: '1.5px',
                                                            background: 'var(--text-tertiary)',
                                                            opacity: 0.4,
                                                        }} />
                                                    )
                                                )}
                                            </div>
                                        );
                                    }

                                    return (
                                        <div key={t.id} style={{ display: 'flex', alignItems: 'stretch', minHeight: '52px' }}>
                                            {gutterCols}
                                            {/* Email card */}
                                            <Link
                                                to={`/documents/${t.id}`}
                                                style={{
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    justifyContent: 'center',
                                                    flex: 1,
                                                    padding: '8px 10px',
                                                    borderRadius: 'var(--radius-sm)',
                                                    background: t.id === id ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-tertiary)',
                                                    border: `1px solid ${t.id === id ? 'var(--border-active)' : 'var(--border-secondary)'}`,
                                                    textDecoration: 'none',
                                                    transition: 'all 150ms ease',
                                                    borderLeft: t._depth > 0 ? `3px solid ${t.id === id ? 'var(--primary)' : 'var(--border-primary)'}` : undefined,
                                                    margin: '1.5px 0',
                                                }}
                                                onMouseEnter={e => { if (t.id !== id) e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
                                                onMouseLeave={e => { if (t.id !== id) e.currentTarget.style.borderColor = 'var(--border-secondary)'; }}
                                            >
                                                <div style={{ fontSize: '12px', fontWeight: 600, color: t.id === id ? 'var(--text-accent)' : 'var(--text-primary)', marginBottom: '2px' }}>
                                                    {t.email_subject || t.original_name}
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                                    {t.email_from?.split('<')[0].trim()} • {t.email_date ? new Date(t.email_date).toLocaleString() : ''}
                                                </div>
                                            </Link>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {/* Attachments */}
                {doc.attachments && doc.attachments.length > 0 && (
                    <div className="doc-sidebar-section">
                        <h3>Attachments ({doc.attachments.length})</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {doc.attachments.map(att => {
                                const ext = att.original_name?.split('.').pop().toLowerCase() || '';
                                return (
                                    <div key={att.id} className="file-item" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                        <Link
                                            to={`/documents/${att.id}`}
                                            style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
                                        >
                                            <div className={`file-icon ${ext}`}>{ext || '?'}</div>
                                            <div className="file-info" style={{ minWidth: 0 }}>
                                                <div className="file-name">{att.original_name}</div>
                                                <div className="file-meta">{formatSize(att.size_bytes)}</div>
                                            </div>
                                        </Link>
                                        <a
                                            href={`/uploads/${att.filename}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="Download file"
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ padding: '6px', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                <polyline points="7 10 12 15 17 10" />
                                                <line x1="12" y1="15" x2="12" y2="3" />
                                            </svg>
                                        </a>
                                    </div>
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

export default DocumentReview;
