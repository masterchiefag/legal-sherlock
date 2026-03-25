import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatSize } from '../utils/format';

function Upload({ activeInvestigationId, activeInvestigation, addToast }) {
    const [files, setFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [results, setResults] = useState([]);
    const [activeJob, setActiveJob] = useState(null);
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef(null);
    const navigate = useNavigate();

    const pollJobStatus = async (jobId) => {
        try {
            const res = await fetch(`/api/documents/jobs/${jobId}`);
            if (res.ok) {
                const job = await res.json();
                setActiveJob(job);
                
                if (job.status === 'completed' || job.status === 'failed') {
                    if (job.status === 'completed') addToast('PST Import Complete', 'success');
                    if (job.status === 'failed') addToast('PST Import Failed', 'error');
                    return; // Stop polling
                }
            }
        } catch (err) {
            console.error("Error polling job status", err);
        }
        // Poll again in 3 seconds
        setTimeout(() => pollJobStatus(jobId), 3000);
    };

    const handleFiles = useCallback((fileList) => {
        const newFiles = Array.from(fileList).filter(f => {
            const ext = f.name.split('.').pop().toLowerCase();
            return ['pdf', 'docx', 'txt', 'csv', 'md', 'eml', 'pst'].includes(ext);
        });
        setFiles(prev => [...prev, ...newFiles]);
        setResults([]);
    }, []);

    const handleDrag = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setDragActive(true);
        } else if (e.type === 'dragleave') {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files?.length) {
            handleFiles(e.dataTransfer.files);
        }
    }, [handleFiles]);

    const removeFile = (index) => {
        setFiles(prev => prev.filter((_, i) => i !== index));
    };

    const uploadFiles = () => {
        if (files.length === 0) return;

        setUploading(true);
        setUploadProgress(0);
        setResults([]);

        const formData = new FormData();
        formData.append('investigation_id', activeInvestigationId);
        files.forEach(f => formData.append('files', f));

        try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/documents/upload', true);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 100);
                    setUploadProgress(percentComplete);
                }
            };

            xhr.onload = () => {
                setUploading(false);
                let data;
                try {
                    data = JSON.parse(xhr.responseText);
                } catch(e) {
                    addToast('Invalid API response', 'error');
                    return;
                }

                if (xhr.status === 202 && data.jobId) {
                    // Background job started (PST)
                    setFiles([]);
                    addToast(data.message, 'info');
                    setActiveJob({ id: data.jobId, status: 'pending', filename: data.filename || 'PST File' });
                    pollJobStatus(data.jobId);
                } else if (xhr.status >= 200 && xhr.status < 300) {
                    setResults(data.documents || []);
                    setFiles([]);
                    addToast(`Successfully uploaded ${data.uploaded} document(s)`, 'success');
                } else {
                    addToast(data.error || 'Upload failed', 'error');
                }
            };

            xhr.onerror = () => {
                setUploading(false);
                addToast('Upload failed due to a network error', 'error');
            };

            xhr.send(formData);
        } catch (err) {
            setUploading(false);
            addToast('Upload failed: ' + err.message, 'error');
        }
    };

    const [elapsed, setElapsed] = useState('');

    useEffect(() => {
        if (!activeJob?.started_at || activeJob.status === 'failed') return;
        const update = () => {
            const start = new Date(activeJob.started_at + 'Z').getTime();
            const end = activeJob.completed_at
                ? new Date(activeJob.completed_at + 'Z').getTime()
                : Date.now();
            const secs = Math.floor((end - start) / 1000);
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
        };
        update();
        if (activeJob.status === 'completed') return;
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [activeJob?.started_at, activeJob?.completed_at, activeJob?.status]);

    const getFileExt = (name) => name.split('.').pop().toLowerCase();

    if (!activeInvestigationId) {
        return (
            <div className="empty-state">
                <h3 className="empty-state-title">No Investigation Selected</h3>
                <p className="empty-state-text">You must select an active investigation before uploading files.</p>
            </div>
        );
    }

    return (
        <div className="fade-in" style={{ maxWidth: '800px' }}>
            <div className="flex items-center gap-8 mb-24 p-12" style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-secondary)' }}>
                <span className="text-secondary" style={{ fontSize: '13px' }}>Uploading to:</span>
                <span className="fw-bold" style={{ fontSize: '14px', color: 'var(--primary)' }}>{activeInvestigation?.name || 'Active Case'}</span>
            </div>

            {/* Dropzone */}
            <div
                className={`dropzone ${dragActive ? 'active' : ''}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
            >
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept=".pdf,.docx,.txt,.csv,.md,.eml,.pst"
                    onChange={(e) => handleFiles(e.target.files)}
                    style={{ display: 'none' }}
                />
                <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M7 18a4.6 4.4 0 0 1-.7-8.8c.3-2.9 2.8-5.2 5.7-5.2 2.5 0 4.7 1.7 5.4 4 2.4.3 4.1 2.3 4.1 4.7A4.6 4.6 0 0 1 17 18" />
                    <polyline points="15 13 12 10 9 13" />
                    <line x1="12" y1="10" x2="12" y2="20" />
                </svg>
                <p className="dropzone-text">
                    <strong>Drop files here</strong> or click to browse
                </p>
                <p className="dropzone-sub">
                    Supports PDF, DOCX, TXT, CSV, MD, EML, PST — up to 500MB each
                </p>
            </div>

            {/* Selected Files */}
            {files.length > 0 && (
                <div className="file-list">
                    <div className="flex items-center justify-between mb-8">
                        <span className="text-sm text-muted">{files.length} file(s) selected</span>
                        <button className="btn btn-primary" onClick={uploadFiles} disabled={uploading}>
                            {uploading ? (
                                <>
                                    <div className="spinner"></div>
                                    Uploading {uploadProgress}%
                                </>
                            ) : (
                                <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="17 8 12 3 7 8" />
                                        <line x1="12" y1="3" x2="12" y2="15" />
                                    </svg>
                                    Upload All
                                </>
                            )}
                        </button>
                    </div>
                    
                    {uploading && (
                        <div style={{ width: '100%', height: '4px', background: 'var(--bg-tertiary)', borderRadius: '2px', marginBottom: '16px', overflow: 'hidden' }}>
                            <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.2s ease' }} />
                        </div>
                    )}

                    {files.map((file, i) => (
                        <div key={i} className="file-item">
                            <div className={`file-icon ${getFileExt(file.name)}`}>
                                {getFileExt(file.name)}
                            </div>
                            <div className="file-info">
                                <div className="file-name">{file.name}</div>
                                <div className="file-meta">{formatSize(file.size)}</div>
                            </div>
                            <button className="btn btn-ghost btn-sm" onClick={() => removeFile(i)} title="Remove">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Background Job Progress */}
            {activeJob && (
                <div className="mt-24 p-16" style={{ background: 'var(--bg-secondary)', borderRadius: '12px', border: '1px solid var(--border-secondary)' }}>
                    <div className="flex items-center justify-between mb-16">
                        <div className="flex items-center gap-12">
                            {activeJob.status === 'processing' || activeJob.status === 'pending' ? (
                                <div className="spinner"></div>
                            ) : activeJob.status === 'completed' ? (
                                <div style={{ color: 'var(--success)', fontSize: '20px' }}>✓</div>
                            ) : (
                                <div style={{ color: 'var(--danger)', fontSize: '20px' }}>⚠</div>
                            )}
                            <div>
                                <h3 className="text-md fw-bold m-0 text-primary">PST Import: {activeJob.filename || 'Archive'}</h3>
                                <p className="text-sm text-muted m-0 capitalize">
                                    {activeJob.phase === 'extracting'
                                        ? 'Extracting text from attachments...'
                                        : activeJob.phase === 'importing' || activeJob.status === 'processing'
                                        ? 'Importing emails & attachments...'
                                        : `Status: ${activeJob.status}`}
                                </p>
                            </div>
                        </div>
                        {activeJob.status === 'completed' && (
                            <button className="btn btn-outline btn-sm" onClick={() => setActiveJob(null)}>Dismiss</button>
                        )}
                    </div>
                    
                    {(activeJob.status === 'processing' || activeJob.status === 'completed' || activeJob.status === 'failed') && (
                        <>
                            {activeJob.phase === 'extracting' && (
                                <div className="mt-12" style={{ marginBottom: '12px' }}>
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs text-muted">Text Extraction</span>
                                        <span className="text-xs fw-bold">{activeJob.progress_percent || 0}%</span>
                                    </div>
                                    <div style={{ height: '6px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${activeJob.progress_percent || 0}%`,
                                            background: 'var(--accent)',
                                            borderRadius: '3px',
                                            transition: 'width 0.3s ease'
                                        }} />
                                    </div>
                                </div>
                            )}
                            <div className="flex gap-24 mt-16" style={{ borderTop: '1px solid var(--border-secondary)', paddingTop: '16px' }}>
                                <div>
                                    <p className="text-xs text-muted m-0 uppercase tracking-wide">Emails Imported</p>
                                    <p className="text-lg fw-bold m-0">{activeJob.total_emails?.toLocaleString() || 0}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted m-0 uppercase tracking-wide">Attachments</p>
                                    <p className="text-lg fw-bold m-0">{activeJob.total_attachments?.toLocaleString() || 0}</p>
                                </div>
                                {elapsed && (
                                    <div>
                                        <p className="text-xs text-muted m-0 uppercase tracking-wide">Elapsed</p>
                                        <p className="text-lg fw-bold m-0">{elapsed}</p>
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {activeJob.error_log && JSON.parse(activeJob.error_log).length > 0 && (
                        <div className="mt-16 p-12" style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', color: 'var(--danger)', fontSize: '13px' }}>
                            <strong>Engine Errors Encountered:</strong>
                            <ul className="m-0 mt-8 pl-16">
                                {JSON.parse(activeJob.error_log).slice(0, 5).map((err, i) => (
                                    <li key={i}>{err.subject ? `[${err.subject}]: ` : ''}{err.error}</li>
                                ))}
                                {JSON.parse(activeJob.error_log).length > 5 && (
                                    <li className="text-muted italic">...and {JSON.parse(activeJob.error_log).length - 5} more errors.</li>
                                )}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* Upload Results */}
            {results.length > 0 && (
                <div className="mt-24">
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Upload Results
                    </h3>
                    <div className="file-list">
                        {results.map(r => (
                            <div key={r.id} className="file-item" onClick={() => navigate(`/documents/${r.id}`)} style={{ cursor: 'pointer' }}>
                                <div className={`file-icon ${getFileExt(r.name)}`}>
                                    {getFileExt(r.name)}
                                </div>
                                <div className="file-info">
                                    <div className="file-name">{r.name}</div>
                                    <div className="file-meta">{formatSize(r.size)}</div>
                                </div>
                                <span className={`status-badge ${r.status}`}>{r.status}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default Upload;
