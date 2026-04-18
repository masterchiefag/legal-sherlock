/**
 * container-helpers.js
 *
 * Shared utilities for container extraction (ZIP, PDF portfolio, TNEF).
 * Used by pst-worker.js (Phases 1.6-1.9), zip-worker.js, and one-off scripts.
 *
 * Consolidates functions that were previously duplicated across 4+ files:
 * - listZipContents / extractFileFromZip (zip-worker, ingest-zip-attachments)
 * - mimeFromExt (msg-parser, zip-worker, ingest-zip-attachments, ingest-remaining-containers)
 * - SKIP_EXTS / EXTRACTABLE_EXTS (zip-worker, ingest-zip-attachments, msg-parser)
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);

// Max ZIP size we'll load fully into memory via jszip. Above this, skip jszip
// and go straight to the streaming unzip CLI fallback to avoid OOM.
const JSZIP_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

// ═══════════════════════════════════════════════════
// Extension sets
// ═══════════════════════════════════════════════════

/** Extensions we skip during container extraction (images, media, executables) */
export const SKIP_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv', '.webm',
    '.exe', '.dll', '.so', '.dylib',
    '.emz', '.wmf',
]);

/** Extensions we can extract text from */
export const EXTRACTABLE_EXTS = new Set([
    '.pdf', '.docx', '.doc', '.xls', '.xlsx', '.txt', '.csv', '.md', '.rtf', '.pptx', '.odt',
]);

/** Container extensions that may contain nested documents */
export const CONTAINER_EXTS = new Set([
    '.zip', '.msg', '.eml', '.rar', '.7z',
]);

// ═══════════════════════════════════════════════════
// MIME type mapping
// ═══════════════════════════════════════════════════

const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.rtf': 'application/rtf',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.eml': 'message/rfc822',
    '.msg': 'application/vnd.ms-outlook',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
};

/**
 * Get MIME type from file extension.
 * @param {string} ext - Extension with leading dot (e.g., '.pdf')
 * @returns {string} MIME type, defaults to 'application/octet-stream'
 */
export function mimeFromExt(ext) {
    return MIME_MAP[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════════════
// ZIP helpers
// ═══════════════════════════════════════════════════

/**
 * Filter applied uniformly to both jszip and unzip codepaths.
 * @param {string} p - internal path
 * @returns {boolean} true if the entry should be kept
 */
function keepZipEntry(p) {
    if (p.endsWith('/')) return false;               // directory entry
    if (p.startsWith('__MACOSX/')) return false;     // macOS resource fork junk
    if (p.includes('/.')) return false;              // hidden/dotfiles inside subfolders
    return true;
}

/**
 * Load a ZIP via jszip. Returns null on any failure so callers can fall back.
 * Skips jszip for ZIPs larger than JSZIP_MAX_BYTES (jszip loads the whole file
 * into memory; the CLI unzip streams).
 *
 * @param {string} zipPath
 * @returns {Promise<JSZip | null>}
 */
async function tryLoadJsZip(zipPath) {
    try {
        const stat = await fsp.stat(zipPath);
        if (stat.size > JSZIP_MAX_BYTES) return null;
        const buf = await fsp.readFile(zipPath);
        return await JSZip.loadAsync(buf);
    } catch (_err) {
        return null;
    }
}

/**
 * List files inside a ZIP archive.
 * Primary: jszip (UTF-8 safe — handles Gmail-exported PST ZIPs with non-ASCII
 * filenames that the system `unzip` CLI mangles; see GitHub issue #66).
 * Fallback: shell `zipinfo` for ZIPs jszip can't parse (encrypted, obscure
 * compression, > JSZIP_MAX_BYTES).
 *
 * Filters out directories, __MACOSX junk, and hidden files either way.
 *
 * @param {string} zipPath - Absolute path to the ZIP file
 * @returns {Promise<Array<{path: string, size: number}>>}
 */
export async function listZipContents(zipPath) {
    // Primary: jszip
    const zip = await tryLoadJsZip(zipPath);
    if (zip) {
        const files = [];
        for (const [name, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            if (!keepZipEntry(name)) continue;
            // jszip exposes uncompressed size in _data.uncompressedSize
            const size = entry._data?.uncompressedSize ?? 0;
            files.push({ path: name, size });
        }
        return files;
    }

    // Fallback: shell zipinfo
    const { stdout } = await execFileAsync('zipinfo', [zipPath], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
    });
    const files = [];
    for (const line of stdout.split('\n')) {
        // zipinfo detailed format: -rw-rw-rw-  2.0 unx  1483541 bX defN 25-Jan-08 14:54 folder/file.pdf
        const match = line.match(/^[-l]\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
        if (!match) continue;
        const size = parseInt(match[1], 10);
        const filePath = match[2].trim();
        if (keepZipEntry(filePath)) files.push({ path: filePath, size });
    }
    return files;
}

/**
 * Extract a single file from a ZIP archive to memory.
 * Primary: jszip (UTF-8 safe for internal filenames). Fallback: `unzip -p`.
 *
 * When callers extract many files from the same archive (common case), the
 * jszip instance gets rebuilt per-call — load once via `tryLoadJsZip` and
 * reuse for a hot loop if profiling shows this is a bottleneck.
 *
 * @param {string} zipPath - Absolute path to the ZIP file
 * @param {string} internalPath - Path of the file inside the ZIP
 * @returns {Promise<Buffer>} File content as Buffer
 */
export async function extractFileFromZip(zipPath, internalPath) {
    // Primary: jszip
    const zip = await tryLoadJsZip(zipPath);
    if (zip) {
        const entry = zip.file(internalPath);
        if (entry) {
            try {
                return await entry.async('nodebuffer');
            } catch (_err) {
                // fall through to unzip
            }
        }
        // jszip parsed the zip but didn't find the file — fall through to
        // unzip; might be a character-encoding mismatch on the path.
    }

    // Fallback: unzip -p
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn('unzip', ['-p', zipPath, internalPath]);
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', () => {}); // suppress warnings
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // code 1 = minor warnings, still valid
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`unzip exited with code ${code} for ${internalPath}`));
            }
        });
        child.on('error', reject);
    });
}

// ═══════════════════════════════════════════════════
// PDF portfolio helpers (pdfdetach from poppler-utils)
// ═══════════════════════════════════════════════════

/**
 * Detect embedded files inside a PDF (PDF portfolio / PDF package).
 * Uses pdfdetach -list which reads only the PDF catalog — fast even for large files.
 *
 * @param {string} pdfPath - Absolute path to the PDF file
 * @returns {Promise<string[]>} Array of embedded filenames, empty if none
 */
export async function detectPdfEmbeddedFiles(pdfPath) {
    try {
        const { stdout } = await execFileAsync('pdfdetach', ['-list', pdfPath], {
            timeout: 10000,
        });

        // pdfdetach -list output format:
        //   N embedded files
        //   1: filename1.pdf
        //   2: filename2.xlsx
        const files = [];
        for (const line of stdout.split('\n')) {
            const match = line.match(/^\s*\d+:\s+(.+)$/);
            if (match) {
                files.push(match[1].trim());
            }
        }
        return files;
    } catch (err) {
        // pdfdetach returns non-zero for PDFs with no embedded files, or corrupt PDFs
        // This is expected for the vast majority of PDFs — not an error
        return [];
    }
}

/**
 * Extract all embedded files from a PDF portfolio to a temp directory.
 *
 * @param {string} pdfPath - Absolute path to the PDF file
 * @returns {Promise<{tmpDir: string, files: Array<{name: string, path: string, size: number}>}>}
 */
export async function extractPdfEmbeddedFiles(pdfPath) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sherlock-pdfdetach-'));

    await execFileAsync('pdfdetach', ['-saveall', '-o', tmpDir, pdfPath], {
        timeout: 60000,
    });

    // Read extracted files from tmpDir
    const entries = await fsp.readdir(tmpDir);
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(tmpDir, entry);
        const stat = await fsp.stat(fullPath);
        if (stat.isFile() && stat.size > 0) {
            files.push({
                name: entry,
                path: fullPath,
                size: stat.size,
            });
        }
    }
    return { tmpDir, files };
}

// ═══════════════════════════════════════════════════
// TNEF helpers (winmail.dat)
// ═══════════════════════════════════════════════════

/**
 * Extract files from a TNEF (winmail.dat) container.
 *
 * @param {string} tnefPath - Absolute path to the TNEF file
 * @returns {Promise<{tmpDir: string, files: Array<{name: string, path: string, size: number}>}>}
 */
export async function extractTnefContents(tnefPath) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sherlock-tnef-'));

    await execFileAsync('tnef', ['-C', tmpDir, '--overwrite', tnefPath], {
        timeout: 30000,
    });

    const entries = await fsp.readdir(tmpDir);
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(tmpDir, entry);
        const stat = await fsp.stat(fullPath);
        if (stat.isFile() && stat.size > 0) {
            files.push({
                name: entry,
                path: fullPath,
                size: stat.size,
            });
        }
    }
    return { tmpDir, files };
}

// ═══════════════════════════════════════════════════
// Archive helpers (RAR, 7z via unar)
// ═══════════════════════════════════════════════════

/**
 * Recursively walk a directory and return all files.
 * @param {string} dir
 * @returns {Promise<Array<{name: string, path: string, size: number}>>}
 */
async function walkDir(dir) {
    const files = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const subFiles = await walkDir(fullPath);
            files.push(...subFiles);
        } else if (entry.isFile()) {
            const stat = await fsp.stat(fullPath);
            if (stat.size > 0) {
                files.push({
                    name: entry.name,
                    path: fullPath,
                    size: stat.size,
                });
            }
        }
    }
    return files;
}

/**
 * Extract a RAR, 7z, or other archive using unar (universal archive extractor).
 * unar handles RAR, 7z, ZIP, tar.gz, and many other formats.
 *
 * @param {string} archivePath - Absolute path to the archive
 * @returns {Promise<{tmpDir: string, files: Array<{name: string, path: string, size: number}>}>}
 */
export async function extractArchive(archivePath) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sherlock-unar-'));

    await execFileAsync('unar', ['-o', tmpDir, '-f', archivePath], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
    });

    const files = await walkDir(tmpDir);
    return { tmpDir, files };
}

/**
 * Clean up a temp directory (best-effort, non-throwing).
 * @param {string} tmpDir
 */
export async function cleanupTmpDir(tmpDir) {
    try {
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
}
