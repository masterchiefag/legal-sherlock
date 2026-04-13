/**
 * Image Scan Worker
 *
 * Scans an E01 forensic disk image or UFDR/ZIP archive for files matching a pattern.
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

// Pull new searchPattern from workerData, default to pst/ost
const { jobId, imagePath, searchPattern = '.*\\.(pst|ost)$' } = workerData;
const IS_ARCHIVE = /\.(zip|ufdr)$/i.test(imagePath);

const updateJob = db.prepare(
    'UPDATE image_jobs SET status = ?, phase = ?, progress_percent = ?, result_data = ?, error_log = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\') THEN datetime(\'now\') ELSE completed_at END WHERE id = ?'
);

function update(status, phase, pct, resultData, errorLog) {
    updateJob.run(status, phase, pct, resultData, errorLog, status, jobId);
}

// ═══════════════════════════════════════════════════
// E01 Disk Image Parsing (Sleuth Kit)
// ═══════════════════════════════════════════════════
function parsePartitions(output) {
    const lines = output.split('\n');
    const partitions = [];
    for (const line of lines) {
        // mmls output: "Slot  Start  End  Length  Description"
        // e.g. "004:  000       0000002048   0000411647   0000409600   Basic data partition"
        // or   "001:  -------   0000000000   0000002047   0000002048   Unallocated"
        const match = line.match(/^\d+:\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
            const slot = match[1];
            const start = parseInt(match[2]);
            const length = parseInt(match[4]);
            const desc = match[5].trim();
            if (/unalloc|meta|safety|primary table|gpt/i.test(desc)) continue;
            if (slot === '-------') continue; // skip unallocated slots
            partitions.push({
                offset: start,
                length,
                description: desc,
            });
        }
    }
    return partitions;
}

function parseFls(output, regex) {
    const lines = output.split('\n');
    const files = [];
    for (const line of lines) {
        const match = line.match(/^[rd]\/[rd]\s+(\S+?):\s+(.+)$/);
        if (!match) continue;
        const filePath = match[2].trim();
        if (regex.test(filePath)) {
            files.push({
                inode: match[1],
                path: filePath,
            });
        }
    }
    return files;
}

function parseIstat(output) {
    const meta = { size: 0, created: null, modified: null, accessed: null, flags: null, is_cloud_only: false };

    // Size: works for ext/FAT; for NTFS, size is in the $DATA attribute line
    const sizeMatch = output.match(/^Size:\s+(\d+)/m);
    if (sizeMatch) {
        meta.size = parseInt(sizeMatch[1]);
    } else {
        // NTFS: "$DATA (128-X)   Name: N/A   ...   size: 1405"
        const dataMatch = output.match(/\$DATA\s.*\bsize:\s+(\d+)/m);
        if (dataMatch) meta.size = parseInt(dataMatch[1]);
    }

    // Created: works across NTFS ("Created:"), ext ("crtime:"), and others
    const createdMatch = output.match(/^Created:\s+(.+?)(?:\s+\(|$)/m);
    if (createdMatch) meta.created = createdMatch[1].trim();
    else {
        const crtimeMatch = output.match(/^crtime:\s+(.+?)(?:\s+\(|$)/m);
        if (crtimeMatch) meta.created = crtimeMatch[1].trim();
    }

    // Modified: NTFS uses "File Modified:", ext uses "Written:" or "mtime:"
    const fmodMatch = output.match(/^File Modified:\s+(.+?)(?:\s+\(|$)/m);
    if (fmodMatch) meta.modified = fmodMatch[1].trim();
    else {
        const modMatch = output.match(/(?:Written|mtime|Modified):\s+(.+?)(?:\s+\(|$)/m);
        if (modMatch) meta.modified = modMatch[1].trim();
    }

    // Accessed: same keyword on NTFS and ext
    const accessedMatch = output.match(/^Accessed:\s+(.+?)(?:\s+\(|$)/m);
    if (accessedMatch) meta.accessed = accessedMatch[1].trim();
    else {
        const atimeMatch = output.match(/^atime:\s+(.+?)(?:\s+\(|$)/m);
        if (atimeMatch) meta.accessed = atimeMatch[1].trim();
    }

    // NTFS flags: detect cloud-only (OneDrive) files
    const flagsMatch = output.match(/^\$STANDARD_INFORMATION[\s\S]*?^Flags:\s+(.+)$/m);
    if (flagsMatch) {
        meta.flags = flagsMatch[1].trim();
        // OneDrive cloud-only files have Sparse + Offline + Reparse Point
        if (/Sparse/i.test(meta.flags) && /Offline/i.test(meta.flags)) {
            meta.is_cloud_only = true;
        }
    }

    return meta;
}

async function scanDiskImage(regex) {
    const scanStart = Date.now();
    console.log(`\u2726 Image Scan: starting E01 scan for ${imagePath}`);
    update('processing', 'partitions', 0, null, null);

    let partitions = [];
    let singlePartition = false;
    try {
        const { stdout } = await execFileAsync('mmls', [imagePath], { timeout: 60000 });
        partitions = parsePartitions(stdout);
        console.log(`\u2726 Image Scan: found ${partitions.length} partitions`);
    } catch (e) {
        console.log(`\u2726 Image Scan: mmls failed (${e.message}), trying direct fls`);
        singlePartition = true;
        partitions = [{ offset: 0, length: 0, description: 'Direct (no partition table)' }];
    }

    if (partitions.length === 0) {
        return [];
    }

    update('processing', 'scanning', 10, JSON.stringify({
        phase_detail: 'scanning', partitions: partitions.length, files_found: 0,
    }), null);
    const allFiles = [];

    for (let i = 0; i < partitions.length; i++) {
        const part = partitions[i];
        const pct = 10 + Math.round((i / partitions.length) * 60);
        update('processing', 'scanning', pct, null, null);

        console.log(`\u2726 Image Scan: scanning partition ${i + 1}/${partitions.length} at offset ${part.offset} (${part.description})`);
        const flsStart = Date.now();
        try {
            const args = ['-r', '-p'];
            if (!singlePartition) args.push('-o', String(part.offset));
            args.push(imagePath);

            const { stdout } = await execFileAsync('fls', args, { timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
            const found = parseFls(stdout, regex);
            const flsTime = ((Date.now() - flsStart) / 1000).toFixed(1);
            console.log(`\u2726 Image Scan: found ${found.length} matching files in partition (${flsTime}s)`);

            for (const f of found) {
                f.partition_offset = part.offset;
                f.partition_desc = part.description;
                allFiles.push(f);
            }

            update('processing', 'scanning', pct, JSON.stringify({
                phase_detail: 'scanning', partitions: partitions.length,
                partition_current: i + 1, files_found: allFiles.length,
            }), null);
        } catch (e) {
            const flsTime = ((Date.now() - flsStart) / 1000).toFixed(1);
            console.log(`\u2726 Image Scan: fls failed for partition at offset ${part.offset} (${flsTime}s): ${e.message}`);
        }
    }

    // Metadata phase: run istat in concurrent batches for performance
    const CONCURRENCY = 10;
    const metaStart = Date.now();
    let metaCompleted = 0;
    let metaFailed = 0;
    let lastLogTime = Date.now();
    const LOG_INTERVAL = 5000; // log every 5s

    update('processing', 'metadata', 70, JSON.stringify({
        phase_detail: 'metadata', processed: 0, total: allFiles.length, rate: 0, eta_seconds: null,
    }), null);

    console.log(`\u2726 Image Scan: starting metadata for ${allFiles.length} files (concurrency: ${CONCURRENCY})`);

    for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
        const batch = allFiles.slice(i, i + CONCURRENCY);
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
                f.size = 0;
                f.created = null;
                f.modified = null;
                f.accessed = null;
                metaFailed++;
            }
        }));

        metaCompleted = Math.min(i + CONCURRENCY, allFiles.length);
        const pct = 70 + Math.round((metaCompleted / allFiles.length) * 25);
        const elapsed = (Date.now() - metaStart) / 1000;
        const rate = metaCompleted / elapsed;
        const remaining = allFiles.length - metaCompleted;
        const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

        update('processing', 'metadata', pct, JSON.stringify({
            phase_detail: 'metadata', processed: metaCompleted, total: allFiles.length,
            rate: Math.round(rate * 10) / 10, eta_seconds: etaSeconds, failed: metaFailed,
        }), null);

        // Periodic console logging
        if (Date.now() - lastLogTime >= LOG_INTERVAL) {
            const etaMin = etaSeconds != null ? `${Math.floor(etaSeconds / 60)}m${etaSeconds % 60}s` : '?';
            console.log(`\u2726 Image Scan: metadata ${metaCompleted}/${allFiles.length} (${Math.round(rate)}/s, ETA ${etaMin}, ${metaFailed} failed)`);
            lastLogTime = Date.now();
        }
    }

    const totalMetaTime = ((Date.now() - metaStart) / 1000).toFixed(1);
    console.log(`\u2726 Image Scan: metadata complete — ${allFiles.length} files in ${totalMetaTime}s (${metaFailed} failed)`);

    return allFiles;
}

// ═══════════════════════════════════════════════════
// Archive Parsing (ZIP/UFDR)
// ═══════════════════════════════════════════════════
async function scanArchive(regex) {
    console.log(`\u2726 Image Scan: starting ZIP/UFDR scan for ${imagePath}`);
    update('processing', 'scanning', 10, null, null);

    const allFiles = [];
    try {
        const { stdout } = await execFileAsync('unzip', ['-l', imagePath], { timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
        
        const lines = stdout.split('\n');
        for (const line of lines) {
            const match = line.match(/^\s*(\d+)\s+([\d-]+)\s+([\d:]+)\s+(.+)$/);
            if (!match) continue;
            
            const size = parseInt(match[1]);
            const dateStr = match[2];
            const timeStr = match[3];
            const filePath = match[4].trim();

            if (filePath.endsWith('/') || !regex.test(filePath)) continue;

            allFiles.push({
                path: filePath,
                size,
                modified: `${dateStr} ${timeStr}`,
                is_zip: true,
                partition_desc: 'Archive Content'
            });
        }
        console.log(`\u2726 Image Scan: found ${allFiles.length} matching files in archive`);
    } catch (e) {
        console.error(`\u2726 Image Scan: unzip failed: ${e.message}`);
        throw new Error(`Failed to list archive contents: ${e.message}`);
    }

    update('processing', 'metadata', 90, null, null);
    return allFiles;
}

// ═══════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════
async function main() {
    try {
        const t0 = Date.now();
        console.log(`\u2726 Image Scan: pattern="${searchPattern}", image="${imagePath}"`);
        const regex = new RegExp(searchPattern, 'i');

        // Route to specific scanner
        const allFiles = IS_ARCHIVE
            ? await scanArchive(regex)
            : await scanDiskImage(regex);

        // Done
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        const resultJson = JSON.stringify(allFiles);
        update('completed', 'done', 100, resultJson, null);
        console.log(`\u2726 Image Scan: complete — found ${allFiles.length} files in ${totalTime}s`);

    } catch (err) {
        console.error('\u2726 Image Scan: fatal error:', err);
        update('failed', 'error', 0, null, JSON.stringify([{ error: err.message, fatal: true }]));
    } finally {
        db.close();
    }
}

main();
