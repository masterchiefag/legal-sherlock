/**
 * WhatsApp ZIP Worker
 *
 * Extracts ChatStorage.sqlite + associated media from a UFDR/ZIP archive,
 * cross-references media paths from the WhatsApp DB, resolves them against
 * the archive's actual file listing, and bundles everything into a ZIP
 * with the structure the chat-worker expects:
 *
 *   ChatStorage.sqlite
 *   Message/Media/filename.jpg
 *   Message/Media/filename.mp4
 *   ...
 */
import { workerData } from 'worker_threads';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ediscovery.db');
const db = new Database(DB_PATH, { timeout: 15000 });
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

const { jobId, imagePath, chatStoragePath, outputPath } = workerData;

const updateJob = db.prepare(
    'UPDATE image_jobs SET status = ?, phase = ?, progress_percent = ?, result_data = ?, error_log = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\') THEN datetime(\'now\') ELSE completed_at END WHERE id = ?'
);

function update(status, phase, pct, resultData, errorLog) {
    updateJob.run(status, phase, pct, resultData, errorLog, status, jobId);
}

/**
 * Extract a single file from archive via `unzip -p` (pipe to stdout).
 */
function extractFromArchive(archivePath, internalPath, destPath) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const child = spawn('unzip', ['-p', archivePath, internalPath]);
        const ws = fs.createWriteStream(destPath);
        child.stdout.pipe(ws);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        ws.on('finish', () => {
            if (child.exitCode !== null && child.exitCode !== 0 && child.exitCode !== 1) {
                reject(new Error(`unzip exited with code ${child.exitCode}: ${stderr}`));
            } else {
                resolve();
            }
        });
        child.on('error', (err) => { ws.destroy(); reject(err); });
        child.on('close', (code) => {
            if (code !== 0 && code !== 1 && !ws.destroyed) {
                ws.destroy();
                reject(new Error(`unzip exited with code ${code}: ${stderr}`));
            }
        });
    });
}

/**
 * List all files in the archive and build lookup structures.
 * Returns { allPaths: Set<string>, byBasename: Map<lowercase_basename, full_path[]> }
 */
async function indexArchive(archivePath) {
    const { stdout } = await execFileAsync('unzip', ['-l', archivePath], {
        timeout: 300000,
        maxBuffer: 100 * 1024 * 1024,
    });
    const allPaths = new Set();
    const byBasename = new Map();
    const lines = stdout.split('\n');
    for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+[\d-]+\s+[\d:]+\s+(.+)$/);
        if (!match) continue;
        const filePath = match[2].trim();
        if (filePath.endsWith('/')) continue; // skip directories
        allPaths.add(filePath);
        const basename = path.basename(filePath).toLowerCase();
        if (!byBasename.has(basename)) byBasename.set(basename, []);
        byBasename.get(basename).push(filePath);
    }
    return { allPaths, byBasename };
}

/**
 * Resolve a WhatsApp ZMEDIALOCALPATH to an archive entry.
 * Tries exact match, common prefix variations, then basename fallback.
 */
function resolveMediaPath(dbPath, allPaths, byBasename) {
    if (!dbPath) return null;

    // Exact match
    if (allPaths.has(dbPath)) return dbPath;

    // Common prefix variations
    const variants = [
        `files/Image/${path.basename(dbPath)}`,
        `files/Video/${path.basename(dbPath)}`,
        `files/Audio/${path.basename(dbPath)}`,
        `files/Document/${path.basename(dbPath)}`,
        `files/Uncategorized/${path.basename(dbPath)}`,
        `Message/${dbPath}`,
        `Message/Media/${path.basename(dbPath)}`,
        dbPath.replace(/^Message\//, ''),
        dbPath.replace(/^Media\//, 'Message/Media/'),
    ];
    for (const v of variants) {
        if (allPaths.has(v)) return v;
    }

    // Basename fallback — only use if exactly one match (avoid ambiguity)
    const basename = path.basename(dbPath).toLowerCase();
    if (basename && byBasename.has(basename)) {
        const matches = byBasename.get(basename);
        if (matches.length === 1) return matches[0];
    }

    return null;
}

async function main() {
    const tmpDir = path.join(os.tmpdir(), `whatsapp-zip-${jobId}`);

    try {
        console.log(`\u2726 WhatsApp ZIP: starting for ${imagePath}`);
        update('processing', 'extracting_db', 5, null, null);

        // Step 1: Extract ChatStorage.sqlite to temp dir
        fs.mkdirSync(tmpDir, { recursive: true });
        const sqliteDest = path.join(tmpDir, 'ChatStorage.sqlite');
        console.log(`\u2726 WhatsApp ZIP: extracting ${chatStoragePath} from archive...`);
        await extractFromArchive(imagePath, chatStoragePath, sqliteDest);

        const sqliteStat = fs.statSync(sqliteDest);
        console.log(`\u2726 WhatsApp ZIP: ChatStorage.sqlite extracted (${Math.round(sqliteStat.size / 1024 / 1024)}MB)`);
        update('processing', 'reading_db', 15, null, null);

        // Step 2: Open ChatStorage.sqlite and read media paths
        const chatDb = new Database(sqliteDest, { readonly: true });
        let mediaRows;
        try {
            chatDb.prepare("SELECT 1 FROM ZWACHATSESSION LIMIT 1").get();
            mediaRows = chatDb.prepare(`
                SELECT mi.ZMEDIALOCALPATH as media_path,
                       mi.ZTITLE as media_title,
                       mi.ZFILESIZE as media_size,
                       m.ZMESSAGETYPE as msg_type
                FROM ZWAMESSAGE m
                JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK
                WHERE mi.ZMEDIALOCALPATH IS NOT NULL AND mi.ZMEDIALOCALPATH != ''
                  AND m.ZMESSAGETYPE IN (1, 2, 3, 5, 8, 9, 15)
            `).all();
            console.log(`\u2726 WhatsApp ZIP: found ${mediaRows.length} media references in DB`);
        } catch (e) {
            chatDb.close();
            throw new Error(`Invalid WhatsApp database: ${e.message}`);
        }
        chatDb.close();

        update('processing', 'indexing_archive', 25, null, null);

        // Step 3: Index the archive for fast path resolution
        console.log(`\u2726 WhatsApp ZIP: indexing archive contents...`);
        const { allPaths, byBasename } = await indexArchive(imagePath);
        console.log(`\u2726 WhatsApp ZIP: archive contains ${allPaths.size} files`);

        // Step 4: Resolve each media path against the archive
        update('processing', 'resolving', 35, null, null);
        const resolvedMedia = []; // { dbPath, archivePath, destName }
        const seenDestNames = new Set();

        for (const row of mediaRows) {
            const archivePath = resolveMediaPath(row.media_path, allPaths, byBasename);
            if (!archivePath) continue;

            // Destination in the output ZIP: Message/Media/<filename>
            let destName = path.basename(row.media_path);
            // Handle collisions
            if (seenDestNames.has(destName.toLowerCase())) {
                const ext = path.extname(destName);
                const base = path.basename(destName, ext);
                let counter = 1;
                while (seenDestNames.has(`${base}_${counter}${ext}`.toLowerCase())) counter++;
                destName = `${base}_${counter}${ext}`;
            }
            seenDestNames.add(destName.toLowerCase());

            resolvedMedia.push({ dbPath: row.media_path, archivePath, destName });
        }

        console.log(`\u2726 WhatsApp ZIP: resolved ${resolvedMedia.length}/${mediaRows.length} media files`);
        update('processing', 'extracting_media', 40, null, null);

        // Step 5: Extract media files to temp dir under Message/Media/
        const mediaDir = path.join(tmpDir, 'Message', 'Media');
        fs.mkdirSync(mediaDir, { recursive: true });

        let extracted = 0;
        for (const media of resolvedMedia) {
            try {
                const destPath = path.join(mediaDir, media.destName);
                await extractFromArchive(imagePath, media.archivePath, destPath);
                extracted++;
            } catch (e) {
                console.warn(`\u2726 WhatsApp ZIP: failed to extract ${media.archivePath}: ${e.message}`);
            }

            if (extracted % 50 === 0 || extracted === resolvedMedia.length) {
                const pct = 40 + Math.round((extracted / resolvedMedia.length) * 40);
                update('processing', 'extracting_media', pct, null, null);
            }
        }

        console.log(`\u2726 WhatsApp ZIP: extracted ${extracted} media files`);
        update('processing', 'creating_zip', 85, null, null);

        // Step 6: Create the output ZIP
        // Use Python zipfile (supports ZIP64 for >2GB archives) instead of macOS zip CLI which
        // silently hangs at ~2GB due to ZIP32 format limitations
        const tmpZipPath = path.join(tmpDir, 'output.zip');
        console.log(`\u2726 WhatsApp ZIP: creating ZIP via Python zipfile (ZIP64)...`);
        const pyScript = `
import zipfile, os, sys
src_dir = sys.argv[1]
out_path = sys.argv[2]
with zipfile.ZipFile(out_path, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
    for root, dirs, files in os.walk(src_dir):
        for f in files:
            full = os.path.join(root, f)
            arcname = os.path.relpath(full, src_dir)
            if arcname == 'output.zip':
                continue
            zf.write(full, arcname)
            print(f'added: {arcname}', flush=True)
print('DONE', flush=True)
`;
        await new Promise((resolve, reject) => {
            const child = spawn('python3', ['-c', pyScript, tmpDir, tmpZipPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let lastLog = '';
            child.stdout.on('data', (chunk) => { lastLog = chunk.toString().trim(); });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Python zip failed (code ${code}): ${stderr}`));
                }
            });
            child.on('error', reject);
        });

        // Move from local temp to final destination
        console.log(`\u2726 WhatsApp ZIP: moving to ${outputPath}...`);
        update('processing', 'moving_zip', 95, null, null);
        fs.copyFileSync(tmpZipPath, outputPath);
        fs.unlinkSync(tmpZipPath);

        const zipStat = fs.statSync(outputPath);
        const resultData = JSON.stringify({
            outputPath,
            zipSize: zipStat.size,
            chatStorageSize: sqliteStat.size,
            totalMediaInDb: mediaRows.length,
            resolvedMedia: resolvedMedia.length,
            extractedMedia: extracted,
        });

        update('completed', 'done', 100, resultData, null);
        console.log(`\u2726 WhatsApp ZIP: complete — ${outputPath} (${Math.round(zipStat.size / 1024 / 1024)}MB), ${extracted} media files`);

    } catch (err) {
        console.error('\u2726 WhatsApp ZIP: fatal error:', err);
        update('failed', 'error', 0, null, JSON.stringify([{ error: err.message, fatal: true }]));
    } finally {
        // Clean up temp dir
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
        db.close();
    }
}

main();
