/**
 * Backfill script for unextracted ZIP attachments.
 *
 * Phase 1.6 of pst-worker.js extracts ZIP contents during ingestion. In
 * practice some ZIPs still land with zero children — either because Phase
 * 1.6 failed on that specific file, or because the ZIP was inserted AFTER
 * 1.6 ran (e.g. via the Phase 1.4 S/MIME backfill which can surface new
 * ZIP attachments post-hoc).
 *
 * This script scans for non-duplicate ZIP attachments with zero children
 * and re-runs the same listZipContents + extractFileFromZip logic Phase
 * 1.6 uses, inserting the real contents as grandchildren.
 *
 * Scope (intentionally narrow for MVP):
 *   - Only zero-child ZIPs. ZIPs that got partial extraction (e.g. one
 *     DICT.zip instance with 2 of ~60 entries) are left alone — detecting
 *     partial extraction requires a name-level diff against zipinfo, which
 *     is a follow-up.
 *   - Non-recursive. If an extracted grandkid is itself a ZIP, we don't
 *     recurse into it. Fresh re-ingestion's Phase 1.9 handles that.
 *
 * Safe to re-run — each iteration only inserts children for ZIPs that
 * still have zero children.
 *
 * Usage:
 *   node server/scripts/backfill-unextracted-zips.mjs <investigation_id>
 *
 * Example (Yesha):
 *   node server/scripts/backfill-unextracted-zips.mjs 1df96512-6a05-4e72-8361-cfedd40f5eb8
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

import {
    listZipContents,
    extractFileFromZip,
    SKIP_EXTS,
    mimeFromExt,
} from '../lib/container-helpers.js';
import { resolveFileExtension } from '../lib/file-extension.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const DATA_DIR   = path.join(__dirname, '..', '..', 'data');

const investigationId = process.argv[2];
if (!investigationId) {
    console.error('Usage: node backfill-unextracted-zips.mjs <investigation_id>');
    process.exit(1);
}

const dbPath = path.join(DATA_DIR, 'investigations', `${investigationId}.db`);
if (!fs.existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}`);
    process.exit(1);
}

console.log(`✦ Opening ${dbPath}`);
const db = new Database(dbPath);
db.pragma('busy_timeout = 15000');

// Seed dedup set from everything already on disk
const seenHashes = new Map();
for (const row of db.prepare("SELECT content_hash, filename FROM documents WHERE content_hash IS NOT NULL AND investigation_id = ?").all(investigationId)) {
    if (!seenHashes.has(row.content_hash)) seenHashes.set(row.content_hash, row.filename);
}
console.log(`✦ Seeded seenHashes with ${seenHashes.size} existing content hashes`);

// Find zero-child non-duplicate ZIPs
const candidates = db.prepare(`
    SELECT p.id, p.filename, p.original_name, p.doc_identifier, p.parent_id, p.size_bytes, p.custodian
    FROM documents p
    WHERE p.investigation_id = ?
      AND p.doc_type = 'attachment' AND p.is_duplicate = 0
      AND LOWER(p.original_name) LIKE '%.zip'
      AND NOT EXISTS(SELECT 1 FROM documents c WHERE c.parent_id = p.id)
    ORDER BY p.size_bytes DESC
`).all(investigationId);

console.log(`✦ Zero-child ZIPs to process: ${candidates.length}`);
if (candidates.length === 0) {
    console.log('Nothing to do.');
    db.close();
    process.exit(0);
}

const insertChild = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate, investigation_id, custodian, doc_identifier, file_extension
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL,
        ?, ?, ?, ?, ?, ?)
`);
const getParentThread = db.prepare("SELECT thread_id FROM documents WHERE id = ?");
const tx = db.transaction((ops) => { for (const op of ops) op(); });

const t0 = Date.now();
let zipsProcessed = 0;
let zipsMissing = 0;
let zipsEmpty = 0;
let zipsErrored = 0;
let attsInserted = 0;
let attsDuped = 0;
let attsSkippedExt = 0;
let attsErrored = 0;
const attsByExt = {};
const batch = [];

for (let i = 0; i < candidates.length; i++) {
    const zip = candidates[i];
    const zipPath = path.join(UPLOADS_DIR, zip.filename);

    if (!fs.existsSync(zipPath)) {
        zipsMissing++;
        if (zipsMissing <= 5) console.log(`  ZIP file missing on disk: ${zip.original_name} (${zip.filename})`);
        continue;
    }

    let entries;
    try {
        entries = await listZipContents(zipPath);
    } catch (err) {
        zipsErrored++;
        if (zipsErrored <= 10) console.warn(`  listZipContents failed on ${zip.original_name}: ${err.message}`);
        continue;
    }

    if (!entries || entries.length === 0) {
        zipsEmpty++;
        continue;
    }

    // Thread id — grandchildren share the ZIP's email's thread
    const parentThread = getParentThread.get(zip.parent_id);
    const threadId = parentThread?.thread_id || null;

    if (zipsProcessed < 5) {
        console.log(`  [${zipsProcessed + 1}] ${zip.original_name} → ${entries.length} entries: ${entries.slice(0, 5).map(e => e.path).join(', ')}${entries.length > 5 ? ' …' : ''}`);
    }

    let childIdx = 0;
    for (const entry of entries) {
        const ext = path.extname(entry.path).toLowerCase();
        if (SKIP_EXTS.has(ext)) { attsSkippedExt++; continue; }

        let content;
        try {
            content = await extractFileFromZip(zipPath, entry.path);
        } catch (err) {
            attsErrored++;
            if (attsErrored <= 10) console.warn(`    extract failed: ${entry.path} in ${zip.original_name} — ${err.message}`);
            continue;
        }

        if (!content || content.length === 0) {
            attsErrored++;
            continue;
        }

        const attHash = crypto.createHash('md5').update(content).digest('hex');
        const isDuplicate = seenHashes.has(attHash) ? 1 : 0;
        const basename = path.basename(entry.path);
        const fileExt = ext || '.bin';

        let finalFilename;
        if (isDuplicate) {
            finalFilename = seenHashes.get(attHash);
            attsDuped++;
        } else {
            const attId = uuidv4();
            finalFilename = `${investigationId}/${attId}${fileExt}`;
            seenHashes.set(attHash, finalFilename);
            await fsp.mkdir(path.join(UPLOADS_DIR, investigationId), { recursive: true });
            await fsp.writeFile(path.join(UPLOADS_DIR, finalFilename), content);
        }

        childIdx++;
        const docIdentifier = zip.doc_identifier ? `${zip.doc_identifier}_${String(childIdx).padStart(3, '0')}` : null;
        const mime = mimeFromExt(fileExt);
        const extKey = (fileExt.slice(1) || 'nobin');
        attsByExt[extKey] = (attsByExt[extKey] || 0) + 1;

        batch.push(() => {
            insertChild.run(
                uuidv4(), finalFilename, basename,
                mime, content.length,
                zip.id, threadId,
                attHash, isDuplicate, investigationId, zip.custodian || null,
                docIdentifier, resolveFileExtension(basename, mime, finalFilename)
            );
        });
        attsInserted++;
    }

    zipsProcessed++;

    if (batch.length >= 200) {
        try { tx(batch); } catch (err) { console.error(`FLUSH ERROR: ${err.message}`); }
        batch.length = 0;
    }

    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
        console.log(`  ${i + 1}/${candidates.length} — processed=${zipsProcessed} atts=${attsInserted} dupes=${attsDuped} empty=${zipsEmpty} err=${zipsErrored}`);
    }
}

if (batch.length > 0) {
    try { tx(batch); } catch (err) { console.error(`Final FLUSH ERROR: ${err.message}`); }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ Done in ${elapsed}s`);
console.log(`  ZIPs processed:              ${zipsProcessed}`);
console.log(`  ZIPs missing on disk:        ${zipsMissing}`);
console.log(`  ZIPs empty (no entries):     ${zipsEmpty}`);
console.log(`  ZIPs errored (list failed):  ${zipsErrored}`);
console.log(`  Children inserted:           ${attsInserted}`);
console.log(`    (of which content-dupes:   ${attsDuped})`);
console.log(`  Children skipped (SKIP_EXTS):${attsSkippedExt}`);
console.log(`  Children errored (extract):  ${attsErrored}`);

if (Object.keys(attsByExt).length) {
    console.log(`\nBy extension:`);
    for (const [e, c] of Object.entries(attsByExt).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        console.log(`    .${e}: ${c}`);
    }
}

db.close();
