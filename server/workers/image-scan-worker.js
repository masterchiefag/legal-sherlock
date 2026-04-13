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

    update('processing', 'scanning', 5, JSON.stringify({
        phase_detail: 'scanning', partitions: partitions.length, files_found: 0,
    }), null);
    const allFiles = [];

    for (let i = 0; i < partitions.length; i++) {
        const part = partitions[i];
        const pct = 5 + Math.round((i / partitions.length) * 90);
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
