/**
 * Image Metadata Worker
 *
 * Phase 2 of the 3-phase flow: Scan (fls) → Metadata (istat) → Ingest.
 * Runs istat on selected files from a prior scan job to collect metadata
 * (size, dates, cloud-only detection). For ZIP/UFDR archives, metadata
 * is already embedded in scan results so we pass through immediately.
 */
import { workerData } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ediscovery.db');
const db = new Database(DB_PATH, { timeout: 15000 });
// Don't set journal_mode — already WAL from main process; setting it deadlocks worker threads
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

const { jobId, imagePath, selectedFiles } = workerData;
const IS_ARCHIVE = /\.(zip|ufdr)$/i.test(imagePath);
const CONCURRENCY = 10;
const LOG_INTERVAL = 5000; // log every 5s

const updateJob = db.prepare(
    'UPDATE image_jobs SET status = ?, phase = ?, progress_percent = ?, result_data = ?, error_log = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\') THEN datetime(\'now\') ELSE completed_at END WHERE id = ?'
);

function update(status, phase, pct, resultData, errorLog) {
    updateJob.run(status, phase, pct, resultData, errorLog, status, jobId);
}

// ═══════════════════════════════════════════════════
// istat Output Parser
// ═══════════════════════════════════════════════════
function parseIstat(output) {
    const meta = { size: 0, created: null, modified: null, accessed: null, flags: null, is_cloud_only: false };

    const sizeMatch = output.match(/^Size:\s+(\d+)/m);
    if (sizeMatch) {
        meta.size = parseInt(sizeMatch[1]);
    } else {
        const dataMatch = output.match(/\$DATA\s.*\bsize:\s+(\d+)/m);
        if (dataMatch) meta.size = parseInt(dataMatch[1]);
    }

    const createdMatch = output.match(/^Created:\s+(.+?)(?:\s+\(|$)/m);
    if (createdMatch) meta.created = createdMatch[1].trim();
    else {
        const crtimeMatch = output.match(/^crtime:\s+(.+?)(?:\s+\(|$)/m);
        if (crtimeMatch) meta.created = crtimeMatch[1].trim();
    }

    const fmodMatch = output.match(/^File Modified:\s+(.+?)(?:\s+\(|$)/m);
    if (fmodMatch) meta.modified = fmodMatch[1].trim();
    else {
        const modMatch = output.match(/(?:Written|mtime|Modified):\s+(.+?)(?:\s+\(|$)/m);
        if (modMatch) meta.modified = modMatch[1].trim();
    }

    const accessedMatch = output.match(/^Accessed:\s+(.+?)(?:\s+\(|$)/m);
    if (accessedMatch) meta.accessed = accessedMatch[1].trim();
    else {
        const atimeMatch = output.match(/^atime:\s+(.+?)(?:\s+\(|$)/m);
        if (atimeMatch) meta.accessed = atimeMatch[1].trim();
    }

    const flagsMatch = output.match(/^\$STANDARD_INFORMATION[\s\S]*?^Flags:\s+(.+)$/m);
    if (flagsMatch) {
        meta.flags = flagsMatch[1].trim();
        if (/Sparse/i.test(meta.flags) && /Offline/i.test(meta.flags)) {
            meta.is_cloud_only = true;
        }
    }

    return meta;
}

// ═══════════════════════════════════════════════════
// E01 Disk Image Metadata Collection
// ═══════════════════════════════════════════════════
async function collectMetadata(files) {
    const metaStart = Date.now();
    let metaCompleted = 0;
    let metaFailed = 0;
    let lastLogTime = Date.now();

    console.log(`✦ Image Metadata: starting istat for ${files.length} files (concurrency: ${CONCURRENCY})`);

    update('processing', 'metadata', 5, JSON.stringify({
        phase_detail: 'metadata', processed: 0, total: files.length, rate: 0, eta_seconds: null, failed: 0,
    }), null);

    for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (f) => {
            try {
                const args = ['-o', String(f.partition_offset), imagePath, f.inode.split('-')[0]];
                const { stdout } = await execFileAsync('istat', args, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
                const meta = parseIstat(stdout);
                f.size = meta.size;
                f.created = meta.created;
                f.modified = meta.modified;
                f.accessed = meta.accessed;
                if (meta.is_cloud_only) f.is_cloud_only = true;
                if (meta.flags) f.flags = meta.flags;
            } catch (e) {
                f.size = f.size || 0;
                f.created = f.created || null;
                f.modified = f.modified || null;
                f.accessed = f.accessed || null;
                metaFailed++;
            }
        }));

        metaCompleted = Math.min(i + CONCURRENCY, files.length);
        const pct = 5 + Math.round((metaCompleted / files.length) * 90);
        const elapsed = (Date.now() - metaStart) / 1000;
        const rate = metaCompleted / elapsed;
        const remaining = files.length - metaCompleted;
        const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

        update('processing', 'metadata', pct, JSON.stringify({
            phase_detail: 'metadata', processed: metaCompleted, total: files.length,
            rate: Math.round(rate * 10) / 10, eta_seconds: etaSeconds, failed: metaFailed,
        }), null);

        // Periodic console logging
        if (Date.now() - lastLogTime >= LOG_INTERVAL) {
            const etaMin = etaSeconds != null ? `${Math.floor(etaSeconds / 60)}m${etaSeconds % 60}s` : '?';
            console.log(`✦ Image Metadata: ${metaCompleted}/${files.length} (${Math.round(rate)}/s, ETA ${etaMin}, ${metaFailed} failed)`);
            lastLogTime = Date.now();
        }
    }

    const totalTime = ((Date.now() - metaStart) / 1000).toFixed(1);
    console.log(`✦ Image Metadata: complete — ${files.length} files in ${totalTime}s (${metaFailed} failed)`);

    return files;
}

// ═══════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════
async function main() {
    try {
        const t0 = Date.now();
        console.log(`✦ Image Metadata: jobId="${jobId}", image="${imagePath}", files=${selectedFiles.length}`);

        let enrichedFiles;

        if (IS_ARCHIVE) {
            // ZIP/UFDR: metadata is already embedded from the scan phase
            console.log(`✦ Image Metadata: ZIP/UFDR archive — metadata already present, passing through`);
            update('processing', 'metadata', 50, JSON.stringify({
                phase_detail: 'metadata', processed: selectedFiles.length, total: selectedFiles.length,
                rate: 0, eta_seconds: 0, failed: 0,
            }), null);
            enrichedFiles = selectedFiles.map(f => ({ ...f, is_zip: true }));
        } else {
            // E01: run istat on each selected file
            enrichedFiles = await collectMetadata(selectedFiles);
        }

        // Done
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        const resultJson = JSON.stringify(enrichedFiles);
        update('completed', 'done', 100, resultJson, null);
        console.log(`✦ Image Metadata: complete — ${enrichedFiles.length} files enriched in ${totalTime}s`);

    } catch (err) {
        console.error('✦ Image Metadata: fatal error:', err);
        update('failed', 'error', 0, null, JSON.stringify([{ error: err.message, fatal: true }]));
    } finally {
        db.close();
    }
}

main();
