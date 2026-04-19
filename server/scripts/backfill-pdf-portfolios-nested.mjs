/**
 * Backfill script for GitHub issue #80.
 *
 * Phase 1.9 of pst-worker.js now recurses into MSG-extracted PDFs to scan
 * them for PDF-portfolio children. This script applies the same logic to
 * EXISTING investigations so you don't have to full re-ingest to benefit.
 *
 * Safe to re-run — each iteration only inserts children that aren't already
 * under the PDF in question.
 *
 * Usage: node server/scripts/backfill-pdf-portfolios-nested.mjs <investigation_id>
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

import {
    detectPdfEmbeddedFiles,
    extractPdfEmbeddedFiles,
    cleanupTmpDir,
    SKIP_EXTS,
    mimeFromExt,
} from '../lib/container-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const DATA_DIR   = path.join(__dirname, '..', '..', 'data');

const investigationId = process.argv[2];
if (!investigationId) {
    console.error('Usage: node backfill-pdf-portfolios-nested.mjs <investigation_id>');
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

// Find extracted attachments that could be PDFs. We widen the filter beyond
// .pdf / application/pdf because Phase 1.5's embedded-rfc822 path sometimes
// mislabels a genuine PDF attachment as mime_type='message/rfc822' with a
// .bin disk filename — we only know it's actually a PDF by reading the
// magic bytes. Scope: any non-dup attachment with parent_id set that has
// no children yet and no obvious non-PDF marker.
const candidates = db.prepare(`
    SELECT p.id, p.filename, p.original_name, p.doc_identifier, p.parent_id, p.custodian, p.content_hash, p.mime_type
    FROM documents p
    WHERE p.investigation_id = ?
      AND p.doc_type = 'attachment' AND p.is_duplicate = 0
      AND p.parent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_id = p.id)
      -- Broad filter: anything that could be a PDF either by name, mime, or
      -- by virtue of being stored as a .bin / .eml / .msg disk file (these
      -- are the synthetic-name cases that hide real PDFs).
      AND (
        LOWER(p.original_name) LIKE '%.pdf'
        OR p.mime_type = 'application/pdf'
        OR p.mime_type = 'message/rfc822'
        OR LOWER(p.filename) LIKE '%.bin'
        OR LOWER(p.filename) LIKE '%.eml'
      )
`).all(investigationId);

console.log(`✦ Candidates (nested attachments that could be PDFs, with no children yet): ${candidates.length}`);

// Magic-byte check so we skip non-PDF .bin/.eml files fast.
function isLikelyPdf(diskPath) {
    try {
        const fd = fs.openSync(diskPath, 'r');
        const buf = Buffer.alloc(5);
        fs.readSync(fd, buf, 0, 5, 0);
        fs.closeSync(fd);
        return buf.slice(0, 5).toString('latin1') === '%PDF-';
    } catch {
        return false;
    }
}

// Insert statement (matches insertRecurseChild in pst-worker.js Phase 1.9)
const insertChild = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, parent_id, thread_id,
        doc_author, doc_title, doc_created_at, doc_modified_at, doc_creator_tool, doc_keywords,
        content_hash, is_duplicate, investigation_id, custodian, doc_identifier
    ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?,
              NULL, NULL, NULL, NULL, NULL, NULL,
              ?, ?, ?, ?, ?)
`);

// Build global content_hash set so we match existing attachment dedup semantics
const seenHashes = new Map();
for (const row of db.prepare(`SELECT content_hash, filename FROM documents WHERE content_hash IS NOT NULL`).all()) {
    if (!seenHashes.has(row.content_hash)) seenHashes.set(row.content_hash, row.filename);
}

const t0 = Date.now();
let portfoliosFound = 0;
let portfoliosEmpty = 0;
let parsesFailed = 0;
let childrenInserted = 0;

let nonPdfSkipped = 0;

for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const pdfPath = path.join(UPLOADS_DIR, c.filename);
    if (!fs.existsSync(pdfPath)) continue;

    // For mislabeled candidates (.bin / .eml / rfc822 mime), verify it's a PDF
    // via magic bytes before bothering to invoke pdfdetach.
    const extSuggestsPdf = (c.original_name || '').toLowerCase().endsWith('.pdf') ||
                           c.mime_type === 'application/pdf';
    if (!extSuggestsPdf) {
        if (!isLikelyPdf(pdfPath)) { nonPdfSkipped++; continue; }
    }

    let names = [];
    try {
        names = await detectPdfEmbeddedFiles(pdfPath);
    } catch {
        parsesFailed++;
        continue;
    }
    if (names.length === 0) { portfoliosEmpty++; continue; }
    portfoliosFound++;

    // Thread id for children = parent chain
    const parentThread = db.prepare('SELECT thread_id FROM documents WHERE id = ?').get(c.parent_id);
    const threadId = parentThread?.thread_id || null;

    let result;
    try {
        result = await extractPdfEmbeddedFiles(pdfPath);
    } catch {
        parsesFailed++;
        continue;
    }

    try {
        let childIdx = 0;
        const tx = db.transaction(() => {
            for (const file of result.files) {
                const fileExt = path.extname(file.name).toLowerCase();
                if (SKIP_EXTS.has(fileExt)) continue;

                const buf = fs.readFileSync(file.path);
                const hash = crypto.createHash('md5').update(buf).digest('hex');
                const isDupe = seenHashes.has(hash) ? 1 : 0;

                const fileId = uuidv4();
                let diskFilename;
                if (!isDupe) {
                    diskFilename = `${investigationId}/${fileId}${fileExt || '.bin'}`;
                    seenHashes.set(hash, diskFilename);
                    fs.writeFileSync(path.join(UPLOADS_DIR, diskFilename), buf);
                } else {
                    diskFilename = seenHashes.get(hash);
                }

                childIdx++;
                const di = c.doc_identifier ? `${c.doc_identifier}_${String(childIdx).padStart(3, '0')}` : null;

                insertChild.run(
                    fileId, diskFilename, file.name,
                    mimeFromExt(fileExt), buf.length,
                    c.id, threadId,
                    hash, isDupe, investigationId,
                    c.custodian || null, di
                );
                childrenInserted++;
            }
        });
        tx();
    } finally {
        if (result.tmpDir) { try { await cleanupTmpDir(result.tmpDir); } catch {} }
    }

    if ((i + 1) % 100 === 0 || i === candidates.length - 1) {
        console.log(`  ${i + 1}/${candidates.length}  — portfolios=${portfoliosFound}  inserted=${childrenInserted}`);
    }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ Done in ${elapsed}s`);
console.log(`  non-PDF candidates skipped: ${nonPdfSkipped}`);
console.log(`  portfolios detected:  ${portfoliosFound}`);
console.log(`  empty (no embedded):  ${portfoliosEmpty}`);
console.log(`  parse errors:         ${parsesFailed}`);
console.log(`  children inserted:    ${childrenInserted}`);

db.close();
