import { useState, useEffect, useRef } from 'react';
import { formatSize } from '../utils/format';
import { apiFetch } from '../utils/api';

const PRESETS = [
    { label: 'Documents', pattern: '.*\\.(pdf|docx|doc|xlsx|xls|pptx|ppt|txt|csv|md|rtf|html|htm|eml|msg)$' },
    { label: 'Documents + Images', pattern: '.*\\.(pdf|docx|doc|xlsx|xls|pptx|ppt|txt|csv|md|rtf|html|htm|eml|msg|png|jpg|jpeg|gif|bmp|webp|tiff|tif|heic|svg)$' },
    { label: 'PST/OST Files', pattern: '.*\\.(pst|ost)$' },
    { label: 'All Media', pattern: '.*\\.(jpg|jpeg|png|gif|mp4|mov|avi|mp3|aac|opus|ogg|pdf|docx|xlsx|webp|heic)$' },
    { label: 'All Files', pattern: '.*' },
];

function formatEta(seconds) {
    if (seconds == null || seconds <= 0) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function ProgressDetail({ job, phaseLabel: label }) {
    if (!job) return null;
    const progress = job.result_data; // parsed JSON from poll
    const pct = job.progress_percent || 0;

    return (
        <div style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {label} ({pct}%)
                </div>
                {progress?.processed != null && progress?.total != null && (
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', gap: '12px' }}>
                        <span>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} files</span>
                        {progress.rate > 0 && <span>{progress.rate}/s</span>}
                        {progress.eta_seconds > 0 && <span>ETA {formatEta(progress.eta_seconds)}</span>}
                    </div>
                )}
                {progress?.files_found != null && !progress.processed && (
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {progress.files_found.toLocaleString()} files found
                        {progress.partition_current && ` (partition ${progress.partition_current}/${progress.partitions})`}
                    </div>
                )}
            </div>
            <div style={{ background: 'var(--bg-tertiary)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                <div style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: 'var(--accent-primary)',
                    borderRadius: '4px',
                    transition: 'width 0.3s ease',
                }} />
            </div>
            {progress?.failed > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '4px' }}>
                    {progress.failed} failed
                </div>
            )}
        </div>
    );
}

function ImageExtraction({ addToast, activeInvestigationId, activeInvestigation }) {
    // Tab state
    const [activeTab, setActiveTab] = useState('scan'); // 'scan' | 'whatsapp'

    // Scan state
    const [imagePath, setImagePath] = useState(
        () => localStorage.getItem('sherlock_image_path') || ''
    );
    const [searchPattern, setSearchPattern] = useState('.*\\.(pst|ost)$');
    const [scanning, setScanning] = useState(false);
    const [scanJobId, setScanJobId] = useState(null);
    const [scanJob, setScanJob] = useState(null);
    const [foundFiles, setFoundFiles] = useState([]);

    // Selection state — extension-based
    const [excludedExts, setExcludedExts] = useState(new Set());
    const [excludeCloudOnly, setExcludeCloudOnly] = useState(true);

    // Metadata state (Phase 2)
    const [metadataLoaded, setMetadataLoaded] = useState(false);
    const [metadataJobId, setMetadataJobId] = useState(null);
    const [metadataJob, setMetadataJob] = useState(null);
    const [loadingMetadata, setLoadingMetadata] = useState(false);
    const [enrichedFiles, setEnrichedFiles] = useState([]); // files with istat data

    // Compute extension summary from found files (scan results — no size/cloud for E01)
    const extSummary = (() => {
        const source = metadataLoaded ? enrichedFiles : foundFiles;
        const map = {};
        for (let i = 0; i < source.length; i++) {
            const f = source[i];
            const ext = (f.path.match(/\.([^./\\]+)$/)?.[1] || 'unknown').toLowerCase();
            if (!map[ext]) map[ext] = { ext, count: 0, totalSize: 0, cloudOnly: 0, local: 0 };
            map[ext].count++;
            map[ext].totalSize += f.size || 0;
            if (f.is_cloud_only) map[ext].cloudOnly++;
            else map[ext].local++;
        }
        return Object.values(map).sort((a, b) => b.count - a.count);
    })();

    // Are we dealing with an archive? (ZIP/UFDR already have metadata from scan)
    const isArchive = /\.(zip|ufdr)$/i.test(imagePath);
    const hasMetadata = metadataLoaded || isArchive;

    // Derive selectedFiles from excluded extensions + cloud-only filter
    const activeFiles = metadataLoaded ? enrichedFiles : foundFiles;
    const selectedFiles = new Set(
        activeFiles.map((f, i) => {
            const ext = (f.path.match(/\.([^./\\]+)$/)?.[1] || 'unknown').toLowerCase();
            if (excludedExts.has(ext)) return null;
            if (hasMetadata && excludeCloudOnly && f.is_cloud_only) return null;
            return i;
        }).filter(i => i !== null)
    );

    // Extract state
    const [outputDir, setOutputDir] = useState('');
    const [extracting, setExtracting] = useState(false);
    const [extractJobId, setExtractJobId] = useState(null);
    const [extractJob, setExtractJob] = useState(null);
    const [extractResults, setExtractResults] = useState([]);

    // Ingest state
    const [ingestCustodian, setIngestCustodian] = useState('');
    const [ingesting, setIngesting] = useState(false);
    const [ingestJobId, setIngestJobId] = useState(null);
    const [ingestJob, setIngestJob] = useState(null);
    const [ingestResults, setIngestResults] = useState(null);

    // WhatsApp extract state
    const [waArchivePath, setWaArchivePath] = useState('');
    const [waOutputPath, setWaOutputPath] = useState('');
    const [waExtracting, setWaExtracting] = useState(false);
    const [waJobId, setWaJobId] = useState(null);
    const [waJob, setWaJob] = useState(null);
    const [waResult, setWaResult] = useState(null);

    const pollRefs = useRef({});

    // ═══════════════════════════════════════
    // Polling — each job gets its own timer
    // ═══════════════════════════════════════
    const pollJob = (jobId, onUpdate, onComplete) => {
        const poll = async () => {
            try {
                const res = await apiFetch(`/api/images/jobs/${jobId}`);
                if (!res.ok) return;
                const job = await res.json();
                onUpdate(job);

                if (job.status === 'completed' || job.status === 'failed') {
                    delete pollRefs.current[jobId];
                    onComplete(job);
                    return;
                }
            } catch (err) {
                console.error('Poll error:', err);
            }
            pollRefs.current[jobId] = setTimeout(() => poll(), 2000);
        };
        poll();
    };

    useEffect(() => {
        return () => {
            Object.values(pollRefs.current).forEach(t => clearTimeout(t));
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
        setExcludedExts(new Set());
        setExcludeCloudOnly(true);
        setMetadataLoaded(false);
        setMetadataJob(null);
        setMetadataJobId(null);
        setEnrichedFiles([]);
        setExtractResults([]);
        setExtractJob(null);
        setExtractJobId(null);
        setIngestResults(null);
        setIngestJob(null);
        setIngestJobId(null);

        try {
            const res = await apiFetch('/api/images/scan', {
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
                        // Archives (ZIP/UFDR) already have metadata from scan
                        if (files.length > 0 && files[0]?.is_zip) {
                            setMetadataLoaded(true);
                            setEnrichedFiles(files);
                        }
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
    const toggleExt = (ext) => {
        setExcludedExts(prev => {
            const next = new Set(prev);
            if (next.has(ext)) next.delete(ext);
            else next.add(ext);
            return next;
        });
    };

    const selectAll = () => {
        setExcludedExts(new Set());
    };

    const deselectAll = () => {
        setExcludedExts(new Set(extSummary.map(e => e.ext)));
    };

    // Legacy toggleSelect for individual file selection (kept for extract table)
    const toggleSelect = (idx) => {
        // no-op in extension mode
    };

    // ═══════════════════════════════════════
    // Metadata (Phase 2)
    // ═══════════════════════════════════════
    const handleMetadata = async () => {
        if (selectedFiles.size === 0) {
            addToast('Please select at least one extension', 'error');
            return;
        }

        setLoadingMetadata(true);
        setMetadataJob(null);

        // Send only indices — server pulls files from scan job result_data
        const indices = [...selectedFiles];

        try {
            const res = await apiFetch('/api/images/metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scanJobId, selectedIndices: indices }),
            });
            const data = await res.json();

            if (!res.ok) {
                addToast(data.error || 'Metadata collection failed', 'error');
                setLoadingMetadata(false);
                return;
            }

            setMetadataJobId(data.jobId);
            pollJob(
                data.jobId,
                (job) => setMetadataJob(job),
                (job) => {
                    setLoadingMetadata(false);
                    if (job.status === 'completed') {
                        const files = job.result_data || [];
                        setEnrichedFiles(files);
                        setMetadataLoaded(true);
                        // Reset excludedExts since the file set may have changed
                        setExcludedExts(new Set());
                        const cloudCount = files.filter(f => f.is_cloud_only).length;
                        addToast(`Metadata loaded for ${files.length} files${cloudCount > 0 ? ` (${cloudCount} cloud-only)` : ''}`, 'success');
                    } else {
                        const errMsg = job.error_log?.[0]?.error || 'Metadata collection failed';
                        addToast(errMsg, 'error');
                    }
                }
            );
        } catch (err) {
            addToast('Network error', 'error');
            setLoadingMetadata(false);
        }
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

        const indices = [...selectedFiles];

        try {
            const res = await apiFetch('/api/images/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scanJobId,
                    metadataJobId: metadataJobId || null,
                    selectedIndices: indices,
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
    // Ingest into Investigation
    // ═══════════════════════════════════════
    const handleIngest = async () => {
        if (!activeInvestigationId) {
            addToast('Please select an investigation first', 'error');
            return;
        }
        if (!ingestCustodian.trim()) {
            addToast('Please enter a custodian name', 'error');
            return;
        }
        if (selectedFiles.size === 0) {
            addToast('Please select files to ingest', 'error');
            return;
        }

        setIngesting(true);
        setIngestResults(null);

        const indices = [...selectedFiles];

        try {
            const res = await apiFetch('/api/images/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scanJobId,
                    metadataJobId: metadataJobId || null,
                    selectedIndices: indices,
                    investigationId: activeInvestigationId,
                    custodian: ingestCustodian.trim(),
                }),
            });
            const data = await res.json();

            if (!res.ok) {
                addToast(data.error || 'Ingest failed', 'error');
                setIngesting(false);
                return;
            }

            setIngestJobId(data.jobId);
            pollJob(
                data.jobId,
                (job) => setIngestJob(job),
                (job) => {
                    setIngesting(false);
                    if (job.status === 'completed') {
                        const result = job.result_data || {};
                        setIngestResults(result);
                        addToast(`Ingested ${result.ingested || 0} document${result.ingested !== 1 ? 's' : ''} into investigation`, 'success');
                    } else {
                        const errMsg = job.error_log?.[0]?.error || 'Ingestion failed';
                        addToast(errMsg, 'error');
                    }
                }
            );
        } catch (err) {
            addToast('Network error', 'error');
            setIngesting(false);
        }
    };

    // ═══════════════════════════════════════
    // WhatsApp Extract
    // ═══════════════════════════════════════
    const handleWhatsAppExtract = async () => {
        if (!waArchivePath.trim()) {
            addToast('Please enter an archive path', 'error');
            return;
        }
        if (!waOutputPath.trim()) {
            addToast('Please enter an output ZIP path', 'error');
            return;
        }

        setWaExtracting(true);
        setWaResult(null);

        try {
            const res = await apiFetch('/api/images/extract-whatsapp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imagePath: waArchivePath.trim(),
                    outputPath: waOutputPath.trim(),
                }),
            });
            const data = await res.json();

            if (!res.ok) {
                addToast(data.error || 'WhatsApp extraction failed', 'error');
                setWaExtracting(false);
                return;
            }

            setWaJobId(data.jobId);
            addToast(`Found ${data.chatStoragePath} — extracting...`, 'success');
            pollJob(
                data.jobId,
                (job) => setWaJob(job),
                (job) => {
                    setWaExtracting(false);
                    if (job.status === 'completed') {
                        setWaResult(job.result_data);
                        addToast('WhatsApp ZIP created successfully', 'success');
                    } else {
                        const errMsg = job.error_log?.[0]?.error || 'Extraction failed';
                        addToast(errMsg, 'error');
                    }
                }
            );
        } catch (err) {
            addToast('Network error', 'error');
            setWaExtracting(false);
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
            metadata: 'Collecting file metadata (istat)...',
            extracting: 'Extracting files...',
            ingesting: 'Processing and ingesting documents...',
            extracting_db: 'Extracting ChatStorage.sqlite...',
            reading_db: 'Reading WhatsApp database...',
            indexing_archive: 'Indexing archive contents...',
            resolving: 'Resolving media paths...',
            extracting_media: 'Extracting media files...',
            creating_zip: 'Creating ZIP archive...',
            moving_zip: 'Moving ZIP to destination...',
            done: 'Complete',
            error: 'Error',
        };
        return labels[job.phase] || job.phase || '';
    };

    const tabStyle = (tab) => ({
        padding: '8px 20px',
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
        border: 'none',
        borderBottom: activeTab === tab ? '2px solid var(--accent-primary)' : '2px solid transparent',
        background: 'transparent',
        color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
        transition: 'all 0.15s ease',
    });

    return (
        <div style={{ maxWidth: '900px' }}>
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid var(--border-secondary)' }}>
                <button style={tabStyle('scan')} onClick={() => setActiveTab('scan')}>File Scanner</button>
                <button style={tabStyle('whatsapp')} onClick={() => setActiveTab('whatsapp')}>WhatsApp Extract</button>
            </div>

            {/* ═══════════════════════════════════════ */}
            {/* File Scanner Tab                       */}
            {/* ═══════════════════════════════════════ */}
            {activeTab === 'scan' && (
                <>
                    {/* Scan Form */}
                    <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>Scan Disk Image or Extraction Archive</h3>
                        <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                            Enter the path to an E01 image, UFDR, or ZIP archive to scan for files matching a pattern.
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Image / Archive Path
                                </label>
                                <input
                                    type="text"
                                    className="input"
                                    value={imagePath}
                                    onChange={e => {
                                        setImagePath(e.target.value);
                                        localStorage.setItem('sherlock_image_path', e.target.value);
                                    }}
                                    placeholder="/path/to/image.E01 or .ufdr"
                                    disabled={scanning}
                                    onKeyDown={e => e.key === 'Enter' && !scanning && handleScan()}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
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
                                <div>
                                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        Preset
                                    </label>
                                    <select
                                        className="input"
                                        style={{ width: 'auto', minWidth: '160px', cursor: 'pointer' }}
                                        value={PRESETS.find(p => p.pattern === searchPattern)?.pattern || ''}
                                        onChange={e => {
                                            if (e.target.value) setSearchPattern(e.target.value);
                                        }}
                                        disabled={scanning}
                                    >
                                        {!PRESETS.find(p => p.pattern === searchPattern) && (
                                            <option value="">Custom</option>
                                        )}
                                        {PRESETS.map(p => (
                                            <option key={p.label} value={p.pattern}>{p.label}</option>
                                        ))}
                                    </select>
                                </div>
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
                            <ProgressDetail job={scanJob} phaseLabel={phaseLabel(scanJob)} />
                        )}
                    </div>

                    {/* Found Files — Extension Summary */}
                    {foundFiles.length > 0 && !scanning && (
                        <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                                    Found {foundFiles.length.toLocaleString()} Files
                                    <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: '8px' }}>
                                        ({selectedFiles.size.toLocaleString()} selected)
                                    </span>
                                </h3>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    {hasMetadata && (
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={excludeCloudOnly}
                                                onChange={e => setExcludeCloudOnly(e.target.checked)}
                                            />
                                            Exclude cloud-only
                                        </label>
                                    )}
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
                                                    checked={excludedExts.size === 0}
                                                    onChange={e => e.target.checked ? selectAll() : deselectAll()}
                                                />
                                            </th>
                                            <th style={{ padding: '8px 12px', textAlign: 'left' }}>Extension</th>
                                            <th style={{ padding: '8px 12px', textAlign: 'right' }}>Files</th>
                                            {hasMetadata && <th style={{ padding: '8px 12px', textAlign: 'right' }}>Total Size</th>}
                                            {hasMetadata && <th style={{ padding: '8px 12px', textAlign: 'right' }}>Local</th>}
                                            {hasMetadata && <th style={{ padding: '8px 12px', textAlign: 'right' }}>Cloud Only</th>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {extSummary.map(e => {
                                            const isSelected = !excludedExts.has(e.ext);
                                            return (
                                                <tr
                                                    key={e.ext}
                                                    onClick={() => toggleExt(e.ext)}
                                                    style={{
                                                        borderBottom: '1px solid var(--border-secondary)',
                                                        cursor: 'pointer',
                                                        background: isSelected ? 'var(--bg-primary-subtle, rgba(59,130,246,0.08))' : 'transparent',
                                                        opacity: isSelected ? 1 : 0.5,
                                                    }}
                                                >
                                                    <td style={{ padding: '10px 12px' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => toggleExt(e.ext)}
                                                            onClick={ev => ev.stopPropagation()}
                                                        />
                                                    </td>
                                                    <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                                                        .{e.ext}
                                                    </td>
                                                    <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                        {e.count.toLocaleString()}
                                                    </td>
                                                    {hasMetadata && (
                                                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                            {formatSize(e.totalSize)}
                                                        </td>
                                                    )}
                                                    {hasMetadata && (
                                                        <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--accent-success, #22c55e)', fontVariantNumeric: 'tabular-nums' }}>
                                                            {e.local.toLocaleString()}
                                                        </td>
                                                    )}
                                                    {hasMetadata && (
                                                        <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                            {e.cloudOnly > 0 ? (
                                                                <span style={{ color: 'var(--warning, #f59e0b)' }}>{e.cloudOnly.toLocaleString()}</span>
                                                            ) : (
                                                                <span style={{ color: 'var(--text-tertiary)' }}>0</span>
                                                            )}
                                                        </td>
                                                    )}
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                    <tfoot>
                                        <tr style={{ borderTop: '2px solid var(--border-secondary)', fontWeight: 600, fontSize: '12px' }}>
                                            <td style={{ padding: '10px 12px' }}></td>
                                            <td style={{ padding: '10px 12px' }}>Total Selected</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                {selectedFiles.size.toLocaleString()}
                                            </td>
                                            {hasMetadata && (
                                                <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                                                    {formatSize(Array.from(selectedFiles).reduce((sum, i) => sum + (activeFiles[i]?.size || 0), 0))}
                                                </td>
                                            )}
                                            {hasMetadata && <td style={{ padding: '10px 12px' }} colSpan={2}></td>}
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>

                            {/* Phase 2: Get Metadata (E01 only — archives already have it) */}
                            {!hasMetadata && (
                                <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-secondary)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                                                Step 2: Collect File Metadata
                                            </div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                                Runs istat on {selectedFiles.size.toLocaleString()} selected files to get sizes, dates, and detect cloud-only files.
                                            </div>
                                        </div>
                                        <button
                                            className="btn btn-primary"
                                            onClick={handleMetadata}
                                            disabled={loadingMetadata || selectedFiles.size === 0}
                                            style={{ whiteSpace: 'nowrap' }}
                                        >
                                            {loadingMetadata ? (
                                                <>
                                                    <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                                    Loading Metadata...
                                                </>
                                            ) : `Get Metadata for ${selectedFiles.size.toLocaleString()} Files`}
                                        </button>
                                    </div>

                                    {/* Metadata progress */}
                                    {loadingMetadata && metadataJob && (
                                        <ProgressDetail job={metadataJob} phaseLabel={phaseLabel(metadataJob)} />
                                    )}
                                </div>
                            )}

                            {/* Extract controls (only after metadata) */}
                            {hasMetadata && (
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
                                    <ProgressDetail job={extractJob} phaseLabel={phaseLabel(extractJob)} />
                                )}
                            </div>
                            )}

                            {/* Ingest into Investigation (only after metadata) */}
                            {hasMetadata && (
                            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-secondary)' }}>
                                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>
                                    Ingest into Investigation
                                </div>
                                {!activeInvestigationId ? (
                                    <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                                        Select an investigation from the sidebar to enable ingestion.
                                    </div>
                                ) : (
                                    <>
                                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                                            Investigation: <strong>{activeInvestigation?.name || activeInvestigationId}</strong>
                                        </div>
                                        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                                            <div style={{ flex: 1 }}>
                                                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                    Custodian Name
                                                </label>
                                                <input
                                                    type="text"
                                                    className="input"
                                                    value={ingestCustodian}
                                                    onChange={e => setIngestCustodian(e.target.value)}
                                                    placeholder="e.g. John Doe"
                                                    disabled={ingesting}
                                                />
                                            </div>
                                            <button
                                                className="btn btn-primary"
                                                onClick={handleIngest}
                                                disabled={ingesting || selectedFiles.size === 0 || !ingestCustodian.trim()}
                                                style={{ whiteSpace: 'nowrap' }}
                                            >
                                                {ingesting ? (
                                                    <>
                                                        <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                                        Ingesting...
                                                    </>
                                                ) : `Ingest ${selectedFiles.size} File${selectedFiles.size !== 1 ? 's' : ''}`}
                                            </button>
                                        </div>

                                        {/* Ingest progress */}
                                        {ingesting && ingestJob && (
                                            <ProgressDetail job={ingestJob} phaseLabel={phaseLabel(ingestJob)} />
                                        )}
                                    </>
                                )}
                            </div>
                            )}
                        </div>
                    )}

                    {/* Ingest Results */}
                    {ingestResults && !ingesting && (
                        <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>Ingestion Results</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                                <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Ingested</div>
                                    <div style={{ fontSize: '20px', fontWeight: 600 }}>{ingestResults.ingested || 0}</div>
                                </div>
                                {ingestResults.cloudOnly > 0 && (
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(147,130,220,0.08)', border: '1px solid rgba(147,130,220,0.2)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Cloud Only</div>
                                        <div style={{ fontSize: '20px', fontWeight: 600 }}>{ingestResults.cloudOnly}</div>
                                    </div>
                                )}
                                {ingestResults.duplicates > 0 && (
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Duplicates</div>
                                        <div style={{ fontSize: '20px', fontWeight: 600 }}>{ingestResults.duplicates}</div>
                                    </div>
                                )}
                                {ingestResults.failed > 0 && (
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Failed</div>
                                        <div style={{ fontSize: '20px', fontWeight: 600 }}>{ingestResults.failed}</div>
                                    </div>
                                )}
                                <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Total</div>
                                    <div style={{ fontSize: '20px', fontWeight: 600 }}>{ingestResults.totalFiles || 0}</div>
                                </div>
                            </div>

                            {ingestResults.files && ingestResults.files.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {ingestResults.files.map((r, idx) => (
                                        <div key={idx} style={{
                                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                            padding: '8px 12px', borderRadius: '6px',
                                            background: r.status === 'ok' ? 'rgba(16,185,129,0.05)' : r.status === 'duplicate' ? 'rgba(234,179,8,0.05)' : r.status === 'cloud_only' ? 'rgba(147,130,220,0.05)' : 'rgba(239,68,68,0.05)',
                                            border: `1px solid ${r.status === 'ok' ? 'rgba(16,185,129,0.15)' : r.status === 'duplicate' ? 'rgba(234,179,8,0.15)' : r.status === 'cloud_only' ? 'rgba(147,130,220,0.15)' : 'rgba(239,68,68,0.15)'}`,
                                            fontSize: '12px',
                                        }}>
                                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0 }}>
                                                <span style={{ fontWeight: 500 }}>
                                                    {r.status === 'ok' ? '\u2713' : r.status === 'duplicate' ? '\u2248' : r.status === 'cloud_only' ? '\u2601' : '\u2717'}
                                                </span>
                                                <span style={{ fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {r.path?.split('/').pop() || r.path}
                                                </span>
                                            </div>
                                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
                                                {r.doc_identifier && (
                                                    <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--accent-primary)', fontWeight: 500 }}>
                                                        {r.doc_identifier}
                                                    </span>
                                                )}
                                                {r.doc_type && (
                                                    <span style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.05em' }}>
                                                        {r.doc_type}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
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
                </>
            )}

            {/* ═══════════════════════════════════════ */}
            {/* WhatsApp Extract Tab                    */}
            {/* ═══════════════════════════════════════ */}
            {activeTab === 'whatsapp' && (
                <>
                    <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
                        <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600 }}>WhatsApp Media Extraction</h3>
                        <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                            Extract WhatsApp chat database and media from a UFDR or ZIP archive into a single ZIP file
                            ready for ingestion. The tool finds ChatStorage.sqlite, cross-references media paths from
                            the database against the archive contents, and bundles everything together.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div>
                                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Source Archive Path (UFDR / ZIP)
                                </label>
                                <input
                                    type="text"
                                    className="input"
                                    value={waArchivePath}
                                    onChange={e => setWaArchivePath(e.target.value)}
                                    placeholder="/path/to/extraction.ufdr"
                                    disabled={waExtracting}
                                />
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Output ZIP Path
                                </label>
                                <input
                                    type="text"
                                    className="input"
                                    value={waOutputPath}
                                    onChange={e => setWaOutputPath(e.target.value)}
                                    placeholder="/path/to/output/whatsapp-media.zip"
                                    disabled={waExtracting}
                                />
                            </div>
                            <div>
                                <button
                                    className="btn btn-primary"
                                    onClick={handleWhatsAppExtract}
                                    disabled={waExtracting || !waArchivePath.trim() || !waOutputPath.trim()}
                                    style={{ whiteSpace: 'nowrap' }}
                                >
                                    {waExtracting ? (
                                        <>
                                            <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                            Extracting...
                                        </>
                                    ) : 'Extract WhatsApp Data'}
                                </button>
                            </div>
                        </div>

                        {/* Progress */}
                        {waExtracting && waJob && (
                            <ProgressDetail job={waJob} phaseLabel={phaseLabel(waJob)} />
                        )}
                    </div>

                    {/* WhatsApp Result */}
                    {waResult && !waExtracting && (
                        <div className="card" style={{ padding: '24px' }}>
                            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>
                                Extraction Complete
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{
                                    padding: '14px 16px', borderRadius: '8px',
                                    background: 'rgba(16,185,129,0.08)',
                                    border: '1px solid rgba(16,185,129,0.2)',
                                }}>
                                    <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '8px' }}>
                                        ZIP created successfully
                                    </div>
                                    <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                                        {waResult.outputPath}
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>ZIP Size</div>
                                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{formatSize(waResult.zipSize)}</div>
                                    </div>
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>ChatStorage</div>
                                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{formatSize(waResult.chatStorageSize)}</div>
                                    </div>
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Media in DB</div>
                                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{waResult.totalMediaInDb?.toLocaleString()}</div>
                                    </div>
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Media Resolved</div>
                                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{waResult.resolvedMedia?.toLocaleString()}</div>
                                    </div>
                                    <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'var(--bg-tertiary)' }}>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Media Extracted</div>
                                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{waResult.extractedMedia?.toLocaleString()}</div>
                                    </div>
                                </div>

                                <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                                    Upload this ZIP file through the Documents page to ingest the WhatsApp chat data and media.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Empty state */}
                    {!waExtracting && !waResult && !waJobId && (
                        <div className="empty-state">
                            <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            <h3 className="empty-state-title">WhatsApp Media Extraction</h3>
                            <p className="empty-state-text">
                                Point to a UFDR or ZIP archive containing a Cellebrite extraction.
                                The tool will locate ChatStorage.sqlite, match media files from the database,
                                and create a ready-to-ingest ZIP.
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default ImageExtraction;
