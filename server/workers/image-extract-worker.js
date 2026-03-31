/**
 * Image Extract Worker
 *
 * Extracts selected PST/OST files from an E01 forensic disk image
 * using The Sleuth Kit's icat command. Preserves file modified time.
 */
import { workerData } from 'worker_threads';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ediscovery.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const { jobId, imagePath, selectedFiles, outputDir } = workerData;

const updateJob = db.prepare(
    'UPDATE image_jobs SET status = ?, phase = ?, progress_percent = ?, result_data = ?, error_log = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\') THEN datetime(\'now\') ELSE completed_at END WHERE id = ?'
);

function update(status, phase, pct, resultData, errorLog) {
    updateJob.run(status, phase, pct, resultData, errorLog, status, jobId);
}

/**
 * Generate a unique output filename, appending _1, _2, etc. on collision.
 */
function uniquePath(dir, filename) {
    let outPath = path.join(dir, filename);
    if (!fs.existsSync(outPath)) return outPath;

    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let counter = 1;
    while (fs.existsSync(outPath)) {
        outPath = path.join(dir, `${base}_${counter}${ext}`);
        counter++;
    }
    return outPath;
}

/**
 * Extract a single file using icat, piping stdout to a file write stream.
 */
function extractFile(imgPath, offset, inode, outPath) {
    return new Promise((resolve, reject) => {
        const args = ['-o', String(offset), imgPath, inode];
        const child = spawn('icat', args);
        const ws = fs.createWriteStream(outPath);

        child.stdout.pipe(ws);

        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        ws.on('finish', () => {
            if (child.exitCode !== null && child.exitCode !== 0) {
                reject(new Error(`icat exited with code ${child.exitCode}: ${stderr}`));
            } else {
                resolve();
            }
        });

        child.on('error', (err) => {
            ws.destroy();
            reject(err);
        });

        child.on('close', (code) => {
            if (code !== 0 && !ws.destroyed) {
                ws.destroy();
                reject(new Error(`icat exited with code ${code}: ${stderr}`));
            }
        });
    });
}

async function main() {
    try {
        console.log(`\u2726 Image Extract: starting — ${selectedFiles.length} files to ${outputDir}`);
        update('processing', 'extracting', 0, null, null);

        const results = [];
        let completed = 0;

        for (const file of selectedFiles) {
            const basename = path.basename(file.path);
            const outPath = uniquePath(outputDir, basename);

            try {
                await extractFile(imagePath, file.partition_offset, file.inode, outPath);

                // Preserve modified time if available
                if (file.modified) {
                    try {
                        const mtime = new Date(file.modified);
                        if (!isNaN(mtime.getTime())) {
                            // fs.utimes(path, atime, mtime) — keep atime as now, set mtime from metadata
                            fs.utimesSync(outPath, new Date(), mtime);
                        }
                    } catch (_) { /* best effort */ }
                }

                const stat = fs.statSync(outPath);
                results.push({
                    path: file.path,
                    outputPath: outPath,
                    size: stat.size,
                    status: 'ok',
                });
                console.log(`\u2726 Image Extract: extracted ${basename} (${stat.size} bytes)`);
            } catch (err) {
                console.error(`\u2726 Image Extract: failed ${basename}: ${err.message}`);
                results.push({
                    path: file.path,
                    outputPath: outPath,
                    size: 0,
                    status: 'error',
                    error: err.message,
                });
                // Clean up partial file
                try { fs.unlinkSync(outPath); } catch (_) {}
            }

            completed++;
            const pct = Math.round((completed / selectedFiles.length) * 100);
            update('processing', 'extracting', pct, null, null);
        }

        const allFailed = results.every(r => r.status === 'error');
        const resultJson = JSON.stringify(results);

        if (allFailed) {
            update('failed', 'error', 100, resultJson, JSON.stringify([{ error: 'All extractions failed' }]));
            console.log('\u2726 Image Extract: all files failed');
        } else {
            const okCount = results.filter(r => r.status === 'ok').length;
            update('completed', 'done', 100, resultJson, null);
            console.log(`\u2726 Image Extract: complete — ${okCount}/${results.length} files extracted`);
        }

    } catch (err) {
        console.error('\u2726 Image Extract: fatal error:', err);
        update('failed', 'error', 0, null, JSON.stringify([{ error: err.message, fatal: true }]));
    } finally {
        db.close();
    }
}

main();
