import { useState, useEffect, useRef } from 'react';
import { formatSize } from '../utils/format';

function ImageExtraction({ addToast }) {
    // Scan state
    const [imagePath, setImagePath] = useState('');
    const [searchPattern, setSearchPattern] = useState('.*\\.(pst|ost)$');
    const [scanning, setScanning] = useState(false);
    const [scanJobId, setScanJobId] = useState(null);
    const [scanJob, setScanJob] = useState(null);
    const [foundFiles, setFoundFiles] = useState([]);

    // Selection state
    const [selectedFiles, setSelectedFiles] = useState(new Set());

    // Extract state
    const [outputDir, setOutputDir] = useState('');
    const [extracting, setExtracting] = useState(false);
    const [extractJobId, setExtractJobId] = useState(null);
    const [extractJob, setExtractJob] = useState(null);
    const [extractResults, setExtractResults] = useState([]);

    const pollRef = useRef(null);

    // ═══════════════════════════════════════
    // Polling
    // ═══════════════════════════════════════
    const pollJob = (jobId, onUpdate, onComplete) => {
        const poll = async () => {
            try {
                const res = await fetch(`/api/images/jobs/${jobId}`);
                if (!res.ok) return;
                const job = await res.json();
                onUpdate(job);

                if (job.status === 'completed' || job.status === 'failed') {
                    onComplete(job);
                    return;
                }
            } catch (err) {
                console.error('Poll error:', err);
            }
            pollRef.current = setTimeout(() => poll(), 2000);
        };
        poll();
    };

    useEffect(() => {
        return () => {
            if (pollRef.current) clearTimeout(pollRef.current);
        };
    }, []);

    // ═══════════════════════════════════════
    // Scan
    // ═══════════════════════════════════════
    const handleScan = async () => {
        if (!imagePath.trim()) {
            addToast('Please enter a path to an E01 image', 'error');
            return;
        }

        setScanning(true);
        setFoundFiles([]);
        setSelectedFiles(new Set());
        setExtractResults([]);
        setExtractJob(null);
        setExtractJobId(null);

        try {
            const res = await fetch('/api/images/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imagePath: imagePath.trim(), searchPattern: searchPattern.trim() }),
            });
            const data = await res.json();

            if (!res.ok) {
                addToast(data.error || 'Scan failed', 'error');
                setScanning(false);
                return;
            }

            setScanJobId(data.jobId);
            pollJob(
                data.jobId,
                (job) => setScanJob(job),
                (job) => {
                    setScanning(false);
                    if (job.status === 'completed') {
                        const files = job.result_data || [];
                        setFoundFiles(files);
                        if (files.length === 0) {
                            addToast('No matching files found in image', 'info');
                        } else {
                            addToast(`Found ${files.length} matching file${files.length > 1 ? 's' : ''}`, 'success');
                        }
                    } else {
                        const errMsg = job.error_log?.[0]?.error || 'Scan failed';
                        addToast(errMsg, 'error');
                    }
                }
            );
        } catch (err) {
            addToast('Network error', 'error');
            setScanning(false);
        }
    };

    // ═══════════════════════════════════════
    // Selection
    // ═══════════════════════════════════════
    const toggleSelect = (idx) => {
        setSelectedFiles(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    };

    const selectAll = () => {
        setSelectedFiles(new Set(foundFiles.map((_, i) => i)));
    };

    const deselectAll = () => {
        setSelectedFiles(new Set());
    };

    // ═══════════════════════════════════════
    // Extract
    // ═══════════════════════════════════════
    const handleExtract = async () => {
        if (!outputDir.trim()) {
            addToast('Please enter an output directory', 'error');
            return;
        }
        if (selectedFiles.size === 0) {
            addToast('Please select files to extract', 'error');
            return;
        }

        setExtracting(true);
        setExtractResults([]);

        const filesToExtract = [...selectedFiles].map(idx => foundFiles[idx]);

        try {
            const res = await fetch('/api/images/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scanJobId,
                    selectedFiles: filesToExtract,
                    outputDir: outputDir.trim(),
                }),
            });
            const data = await res.json();

            if (!res.ok) {
                addToast(data.error || 'Extract failed', 'error');
                setExtracting(false);
                return;
            }

            setExtractJobId(data.jobId);
            pollJob(
                data.jobId,
                (job) => setExtractJob(job),
                (job) => {
                    setExtracting(false);
                    const results = job.result_data || [];
                    setExtractResults(results);
                    if (job.status === 'completed') {
                        const okCount = results.filter(r => r.status === 'ok').length;
                        addToast(`Extracted ${okCount} file${okCount > 1 ? 's' : ''} to ${outputDir}`, 'success');
                    } else {
                        addToast('Extraction failed', 'error');
                    }
                }
            );
        } catch (err) {
            addToast('Network error', 'error');
            setExtracting(false);
        }
    };

    // ═══════════════════════════════════════
    // Render helpers
    // ═══════════════════════════════════════
    const phaseLabel = (job) => {
        if (!job) return '';
        const labels = {
            queued: 'Queued...',
            partitions: 'Reading partition table...',
            scanning: 'Scanning for matching files...',
            metadata: 'Reading file metadata...',
            extracting: 'Extracting files...',
            done: 'Complete',
            error: 'Error',
        };
        return labels[job.phase] || job.phase || '';
    };

    return (
        <div style={{ maxWidth: '900px' }}>
            {/* Scan Form */}
            <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>Scan Disk Image or Extraction Archive</h3>
                <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    Enter the path to an E01 image, UFDR, or ZIP archive to scan for files matching a pattern.
                </p>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ flex: 2 }}>
                        <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            Image / Archive Path
                        </label>
                        <input
                            type="text"
                            className="input"
                            value={imagePath}
                            onChange={e => setImagePath(e.target.value)}
                            placeholder="/path/to/image.E01 or .ufdr"
                            disabled={scanning}
                            onKeyDown={e => e.key === 'Enter' && !scanning && handleScan()}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            File Match Regex
                        </label>
                        <input
                            type="text"
                            className="input"
                            value={searchPattern}
                            onChange={e => setSearchPattern(e.target.value)}
                            placeholder=".*\.(pst|ost)$"
                            disabled={scanning}
                            onKeyDown={e => e.key === 'Enter' && !scanning && handleScan()}
                        />
                    </div>
                    <div style={{ paddingTop: '22px' }}>
                        <button
                        className="btn btn-primary"
                        onClick={handleScan}
                        disabled={scanning || !imagePath.trim()}
                        style={{ whiteSpace: 'nowrap' }}
                    >
                        {scanning ? (
                            <>
                                <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                Scanning...
                            </>
                        ) : 'Scan Image'}
                    </button>
                    </div>
                </div>

                {/* Scan progress */}
                {scanning && scanJob && (
                    <div style={{ marginTop: '16px' }}>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            {phaseLabel(scanJob)}
                        </div>
                        <div style={{ background: 'var(--bg-tertiary)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                            <div style={{
                                width: `${scanJob.progress_percent || 0}%`,
                                height: '100%',
                                background: 'var(--accent-primary)',
                                borderRadius: '4px',
                                transition: 'width 0.3s ease',
                            }} />
                        </div>
                    </div>
                )}
            </div>

            {/* Found Files */}
            {foundFiles.length > 0 && !scanning && (
                <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                            Found {foundFiles.length} Matching File{foundFiles.length > 1 ? 's' : ''}
                        </h3>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select All</button>
                            <button className="btn btn-ghost btn-sm" onClick={deselectAll}>Deselect All</button>
                        </div>
                    </div>

                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-secondary)', color: 'var(--text-tertiary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    <th style={{ padding: '8px 12px', textAlign: 'left', width: '40px' }}>
                                        <input
                                            type="checkbox"
                                            checked={selectedFiles.size === foundFiles.length}
                                            onChange={e => e.target.checked ? selectAll() : deselectAll()}
                                        />
                                    </th>
                                    <th style={{ padding: '8px 12px', textAlign: 'left' }}>File Path</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'right' }}>Size</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'left' }}>Modified</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'left' }}>Partition</th>
                                </tr>
                            </thead>
                            <tbody>
                                {foundFiles.map((f, idx) => (
                                    <tr
                                        key={idx}
                                        onClick={() => toggleSelect(idx)}
                                        style={{
                                            borderBottom: '1px solid var(--border-secondary)',
                                            cursor: 'pointer',
                                            background: selectedFiles.has(idx) ? 'var(--bg-primary-subtle, rgba(59,130,246,0.08))' : 'transparent',
                                        }}
                                    >
                                        <td style={{ padding: '10px 12px' }}>
                                            <input
                                                type="checkbox"
                                                checked={selectedFiles.has(idx)}
                                                onChange={() => toggleSelect(idx)}
                                                onClick={e => e.stopPropagation()}
                                            />
                                        </td>
                                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', wordBreak: 'break-all' }}>
                                            {f.path}
                                        </td>
                                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                            {f.size ? formatSize(f.size) : '—'}
                                        </td>
                                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                            {f.modified || '—'}
                                        </td>
                                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '12px' }}>
                                            {f.partition_desc || '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Extract controls */}
                    <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-secondary)' }}>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Output Directory
                                </label>
                                <input
                                    type="text"
                                    className="input"
                                    value={outputDir}
                                    onChange={e => setOutputDir(e.target.value)}
                                    placeholder="/path/to/output"
                                    disabled={extracting}
                                />
                            </div>
                            <button
                                className="btn btn-primary"
                                onClick={handleExtract}
                                disabled={extracting || selectedFiles.size === 0 || !outputDir.trim()}
                                style={{ whiteSpace: 'nowrap' }}
                            >
                                {extracting ? (
                                    <>
                                        <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                        Extracting...
                                    </>
                                ) : `Extract ${selectedFiles.size} File${selectedFiles.size !== 1 ? 's' : ''}`}
                            </button>
                        </div>

                        {/* Extract progress */}
                        {extracting && extractJob && (
                            <div style={{ marginTop: '16px' }}>
                                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                                    {phaseLabel(extractJob)} ({extractJob.progress_percent || 0}%)
                                </div>
                                <div style={{ background: 'var(--bg-tertiary)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                                    <div style={{
                                        width: `${extractJob.progress_percent || 0}%`,
                                        height: '100%',
                                        background: 'var(--accent-primary)',
                                        borderRadius: '4px',
                                        transition: 'width 0.3s ease',
                                    }} />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Extraction Results */}
            {extractResults.length > 0 && !extracting && (
                <div className="card" style={{ padding: '24px' }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>Extraction Results</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {extractResults.map((r, idx) => (
                            <div key={idx} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '10px 14px', borderRadius: '6px',
                                background: r.status === 'ok' ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                                border: `1px solid ${r.status === 'ok' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                            }}>
                                <div>
                                    <div style={{ fontSize: '13px', fontWeight: 500 }}>
                                        {r.status === 'ok' ? '\u2713' : '\u2717'} {r.path.split('/').pop()}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px', fontFamily: 'var(--font-mono, monospace)' }}>
                                        {r.status === 'ok' ? r.outputPath : r.error}
                                    </div>
                                </div>
                                {r.status === 'ok' && (
                                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                        {formatSize(r.size)}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Empty state after scan with no results */}
            {!scanning && scanJob?.status === 'completed' && foundFiles.length === 0 && (
                <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
                    </svg>
                    <h3 className="empty-state-title">No Matching Files Found</h3>
                    <p className="empty-state-text">The image was scanned successfully but no files matching the pattern were found.</p>
                </div>
            )}
        </div>
    );
}

export default ImageExtraction;
