import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatSize } from '../utils/format';

function Upload({ activeInvestigationId, activeInvestigation, addToast }) {
    const [files, setFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [results, setResults] = useState([]);
    const [activeJob, setActiveJob] = useState(null);
    const [failedJobs, setFailedJobs] = useState([]);
    const [dragActive, setDragActive] = useState(false);
    const [custodian, setCustodian] = useState('');
    const inputRef = useRef(null);
    const navigate = useNavigate();

    // Load recent jobs for this investigation on mount
    useEffect(() => {
        if (!activeInvestigationId) return;
        fetch(`/api/documents/jobs/recent/${activeInvestigationId}`)
            .then(r => r.json())
            .then(data => {
                const jobs = data.jobs || [];
                setFailedJobs(jobs.filter(j => j.status === 'failed'));
                // Resume polling for in-progress jobs, or show the latest completed one
                const active = jobs.find(j => j.status === 'processing' || j.status === 'pending');
                const recent = jobs.find(j => j.status === 'completed');
                if (active) {
                    setActiveJob(active);
                    pollJobStatus(active.id);
                } else if (recent) {
                    setActiveJob(recent);
                }
            })
            .catch(() => {});
    }, [activeInvestigationId]);

    const pollJobStatus = async (jobId) => {
        try {
            const res = await fetch(`/api/documents/jobs/${jobId}`);
            if (res.ok) {
                const job = await res.json();
                setActiveJob(job);
                
                if (job.status === 'completed' || job.status === 'failed') {
                    if (job.status === 'completed') addToast(`${getJobLabel(job)} Complete`, 'success');
                    if (job.status === 'failed') addToast(`${getJobLabel(job)} Failed`, 'error');
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
            return ['pdf', 'docx', 'txt', 'csv', 'md', 'eml', 'pst', 'ost', 'sqlite', 'db'].includes(ext);
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
        if (custodian.trim()) formData.append('custodian', custodian.trim());
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
                    setActiveJob({ id: data.jobId, status: 'pending', filename: data.filename || 'File' });
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
    const [phase1Time, setPhase1Time] = useState('');
    const [phase2Time, setPhase2Time] = useState('');

    const formatDuration = (ms) => {
        const secs = Math.floor(ms / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    useEffect(() => {
        if (!activeJob?.started_at || activeJob.status === 'failed') return;
        const update = () => {
            const start = new Date(activeJob.started_at + 'Z').getTime();
            const end = activeJob.completed_at
                ? new Date(activeJob.completed_at + 'Z').getTime()
                : Date.now();
            const priorMs = (activeJob.elapsed_seconds || 0) * 1000;
            setElapsed(formatDuration(end - start + priorMs));

            // Phase 1 time: started_at → phase1_completed_at
            // Skip phase breakdown on resumed jobs (timestamps span different runs)
            if (activeJob.phase1_completed_at && !activeJob.elapsed_seconds) {
                const p1End = new Date(activeJob.phase1_completed_at + 'Z').getTime();
                setPhase1Time(formatDuration(p1End - start));
                // Phase 2 time: phase1_completed_at → completed_at (or now)
                const p2End = activeJob.completed_at
                    ? new Date(activeJob.completed_at + 'Z').getTime()
                    : Date.now();
                setPhase2Time(formatDuration(p2End - p1End));
            } else {
                setPhase1Time('');
                setPhase2Time('');
            }
        };
        update();
        if (activeJob.status === 'completed') return;
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [activeJob?.started_at, activeJob?.completed_at, activeJob?.phase1_completed_at, activeJob?.status, activeJob?.elapsed_seconds]);

    const resumeJob = async (jobId) => {
        try {
            const res = await fetch(`/api/documents/jobs/${jobId}/resume`, { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                addToast('Import resumed', 'info');
                setFailedJobs(prev => prev.filter(j => j.id !== jobId));
                setActiveJob({ id: jobId, status: 'processing', phase: 'importing' });
                pollJobStatus(jobId);
            } else {
                addToast(data.error || 'Resume failed', 'error');
            }
        } catch (err) {
            addToast('Resume failed: ' + err.message, 'error');
        }
    };

    const getFileExt = (name) => name.split('.').pop().toLowerCase();

    const getJobType = (job) => {
        const ext = job?.filename?.split('.').pop().toLowerCase() || '';
        if (ext === 'sqlite' || ext === 'db') return 'chat';
        return 'pst'; // PST/OST
    };

    const getJobLabel = (job) => {
        return getJobType(job) === 'chat' ? 'Chat Import' : 'PST Import';
    };

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
            <div className="flex items-center gap-8 mb-16 p-12" style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-secondary)' }}>
                <span className="text-secondary" style={{ fontSize: '13px' }}>Uploading to:</span>
                <span className="fw-bold" style={{ fontSize: '14px', color: 'var(--primary)' }}>{activeInvestigation?.name || 'Active Case'}</span>
            </div>

            {/* Failed Jobs — Resume */}
            {failedJobs.length > 0 && !activeJob && (
                <div className="mb-24">
                    {failedJobs.map(job => (
                        <div key={job.id} className="p-16 mb-12" style={{ background: 'var(--bg-secondary)', borderRadius: '12px', border: '1px solid var(--warning)', borderLeftWidth: '4px' }}>
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="flex items-center gap-8">
                                        <span style={{ color: 'var(--warning)', fontSize: '16px' }}>⚠</span>
                                        <span className="fw-bold text-primary">{job.filename}</span>
                                        <span className="text-sm text-muted">— Import failed</span>
                                    </div>
                                    <p className="text-sm text-muted m-0 mt-4">
                                        {job.total_emails || 0} emails, {job.total_attachments || 0} attachments imported before failure.
                                        {job.total_emails > 0 && ' Resume will skip already-imported emails.'}
                                    </p>
                                </div>
                                <div className="flex gap-8">
                                    <button className="btn btn-primary btn-sm" onClick={() => resumeJob(job.id)}>
                                        ↻ Resume
                                    </button>
                                    <button className="btn btn-ghost btn-sm" onClick={() => setFailedJobs(prev => prev.filter(j => j.id !== job.id))}>
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Custodian */}
            <div className="input-group mb-16" style={{ maxWidth: '400px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', display: 'block' }}>
                    Custodian <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span>
                </label>
                <input
                    type="text"
                    className="input"
                    placeholder="e.g. John Doe"
                    value={custodian}
                    onChange={(e) => setCustodian(e.target.value)}
                    style={{ fontSize: '14px' }}
                />
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Person whose data is being uploaded. Applied to all documents in this upload.
                </p>
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
                    accept=".pdf,.docx,.txt,.csv,.md,.eml,.pst,.ost,.sqlite,.db"
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
                    Supports PDF, DOCX, TXT, CSV, MD, EML, PST, SQLite
                </p>
                <p className="dropzone-sub" style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text-muted)' }}>
                    💡 For large PST files, keep your laptop awake during import (run <code>caffeinate -i</code> in Terminal)
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
                <div className="mt-24" style={{ background: 'var(--bg-secondary)', borderRadius: '12px', border: '1px solid var(--border-secondary)', padding: '20px 24px' }}>
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
                                <h3 className="text-md fw-bold m-0 text-primary">{getJobLabel(activeJob)}: {activeJob.filename || 'Archive'}</h3>
                                <p className="text-sm text-muted m-0 capitalize">
                                    {activeJob.phase === 'reading'
                                        ? getJobType(activeJob) === 'chat'
                                            ? 'Reading chat database...'
                                            : 'Reading PST file (this takes a few minutes)...'
                                        : activeJob.phase === 'extracting'
                                        ? 'Extracting text from attachments...'
                                        : activeJob.phase === 'importing' || activeJob.status === 'processing'
                                        ? getJobType(activeJob) === 'chat'
                                            ? 'Importing chat messages...'
                                            : 'Importing emails & attachments...'
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
                            {/* Chat import progress (uses progress_percent directly) */}
                            {activeJob.phase === 'importing' && getJobType(activeJob) === 'chat' && activeJob.progress_percent > 0 && (
                                <div style={{ marginBottom: '12px' }}>
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs text-muted">
                                            Importing: {activeJob.total_emails?.toLocaleString() || 0} chats
                                        </span>
                                        <span className="text-xs fw-bold">{activeJob.progress_percent}%</span>
                                    </div>
                                    <div style={{ height: '6px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${activeJob.progress_percent}%`,
                                            background: 'var(--accent)',
                                            borderRadius: '3px',
                                            transition: 'width 0.3s ease'
                                        }} />
                                    </div>
                                </div>
                            )}
                            {/* PST import progress (uses total_emails / total_eml_files) */}
                            {activeJob.phase === 'importing' && getJobType(activeJob) !== 'chat' && activeJob.total_eml_files > 0 && (() => {
                                const pct = Math.min(100, Math.round((activeJob.total_emails / activeJob.total_eml_files) * 100));
                                const elapsedMs = activeJob.started_at ? Date.now() - new Date(activeJob.started_at + 'Z').getTime() : 0;
                                const rate = elapsedMs > 0 && activeJob.total_emails > 0 ? activeJob.total_emails / (elapsedMs / 60000) : 0;
                                const remaining = rate > 0 ? Math.round((activeJob.total_eml_files - activeJob.total_emails) / rate) : 0;
                                const etaText = remaining > 60 ? `~${Math.round(remaining / 60)}h ${remaining % 60}m` : remaining > 0 ? `~${remaining}m` : '';
                                return (
                                    <div className="mt-12" style={{ marginBottom: '12px' }}>
                                        <div className="flex items-center justify-between mb-4">
                                            <span className="text-xs text-muted">
                                                Importing: {activeJob.total_emails?.toLocaleString()} / {activeJob.total_eml_files?.toLocaleString()} {getJobType(activeJob) === 'chat' ? 'chats' : 'emails'}
                                            </span>
                                            <span className="text-xs fw-bold">
                                                {pct}%{etaText ? ` · ETA ${etaText}` : ''}
                                            </span>
                                        </div>
                                        <div style={{ height: '6px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                                            <div style={{
                                                height: '100%',
                                                width: `${pct}%`,
                                                background: 'var(--accent)',
                                                borderRadius: '3px',
                                                transition: 'width 0.3s ease'
                                            }} />
                                        </div>
                                        {rate > 0 && (
                                            <p className="text-xs text-muted m-0 mt-4">{Math.round(rate)} {getJobType(activeJob) === 'chat' ? 'chats' : 'emails'}/min</p>
                                        )}
                                    </div>
                                );
                            })()}
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
                                    <p className="text-xs text-muted m-0 uppercase tracking-wide">
                                        {getJobType(activeJob) === 'chat' ? 'Chats Imported' : 'Emails Imported'}
                                    </p>
                                    <p className="text-lg fw-bold m-0">{activeJob.total_emails?.toLocaleString() || 0}</p>
                                </div>
                                {getJobType(activeJob) !== 'chat' && (
                                <div>
                                    <p className="text-xs text-muted m-0 uppercase tracking-wide">Attachments</p>
                                    <p className="text-lg fw-bold m-0">{activeJob.total_attachments?.toLocaleString() || 0}</p>
                                </div>
                                )}
                                {elapsed && (
                                    <div>
                                        <p className="text-xs text-muted m-0 uppercase tracking-wide">Total Time</p>
                                        <p className="text-lg fw-bold m-0">{elapsed}</p>
                                    </div>
                                )}
                                {phase1Time && (
                                    <div>
                                        <p className="text-xs text-muted m-0 uppercase tracking-wide">Phase 1 (Import)</p>
                                        <p className="text-lg fw-bold m-0">{phase1Time}</p>
                                    </div>
                                )}
                                {phase2Time && (
                                    <div>
                                        <p className="text-xs text-muted m-0 uppercase tracking-wide">Phase 2 (Extract)</p>
                                        <p className="text-lg fw-bold m-0">{phase2Time}</p>
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
