/**
 * Backfill script for GitHub issue #79.
 *
 * Phase 1.4 of pst-worker.js now unwraps IPM.Note.SMIME.MultipartSigned
 * envelopes: it reads attachment 0's fileInputStream via pst-extractor,
 * parses the signed MIME body via postal-mime, and inserts the real
 * attachments (PDFs, DOCX, etc.) as children of the existing email row.
 *
 * This script applies the same logic to EXISTING investigations so you don't
 * have to fully re-ingest the PST. Safe to re-run — each iteration only
 * inserts children that aren't already attached to the email (by content
 * hash), and duplicate hashes are marked is_duplicate=1 against existing
 * disk files.
 *
 * Usage:
 *   node server/scripts/backfill-smime-multipartsigned.mjs <investigation_id> <pst_path>
 *
 * Example:
 *   node server/scripts/backfill-smime-multipartsigned.mjs \
 *     1df96512-6a05-4e72-8361-cfedd40f5eb8 \
 *     /Users/atulgoyal/dev/sherlock_misc/images/PST/Yesha\ Maniar/GMS-....pst
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import PostalMime from 'postal-mime';

import { extractSignedSmimeBlobs } from '../lib/pst-parser.js';
import { resolveFileExtension } from '../lib/file-extension.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const DATA_DIR   = path.join(__dirname, '..', '..', 'data');

const investigationId = process.argv[2];
const pstPath = process.argv[3];
if (!investigationId || !pstPath) {
    console.error('Usage: node backfill-smime-multipartsigned.mjs <investigation_id> <pst_path>');
    process.exit(1);
}
if (!fs.existsSync(pstPath)) {
    console.error(`No PST at ${pstPath}`);
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

// Seed the hash set from the whole investigation so we dedup cross-email too.
const seenHashes = new Map();
for (const row of db.prepare("SELECT content_hash, filename FROM documents WHERE content_hash IS NOT NULL AND investigation_id = ?").all(investigationId)) {
    if (!seenHashes.has(row.content_hash)) seenHashes.set(row.content_hash, row.filename);
}
console.log(`✦ Seeded seenHashes with ${seenHashes.size} existing content hashes`);

// Walk PST for the signed blobs
console.log(`✦ Walking PST via pst-extractor for IPM.Note.SMIME.MultipartSigned messages...`);
const t0 = Date.now();
const records = extractSignedSmimeBlobs(pstPath);
console.log(`  Yielded ${records.length.toLocaleString()} signed-envelope blobs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (records.length === 0) {
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
const findEmailByMsgid = db.prepare(
    "SELECT id, doc_identifier, thread_id, custodian FROM documents WHERE investigation_id = ? AND doc_type = 'email' AND LOWER(message_id) = LOWER(?) LIMIT 1"
);
const existingChildHashes = db.prepare(
    "SELECT content_hash FROM documents WHERE parent_id = ? AND content_hash IS NOT NULL"
);

const tx = db.transaction((ops) => { for (const op of ops) op(); });

let blobsParsed = 0;
let emailsNotFound = 0;
let attsInserted = 0;
let attsDuped = 0;
let attsSkippedSig = 0;
let attsSkippedInline = 0;
let attsSkippedAlreadyThere = 0;
let blobParseErrors = 0;
const attsByExt = {};
const batch = [];

for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec.messageId) { emailsNotFound++; continue; }
    const email = findEmailByMsgid.get(investigationId, rec.messageId);
    if (!email) { emailsNotFound++; continue; }

    // Build set of attachment hashes already on this email so re-runs are idempotent
    const alreadyUnderThisEmail = new Set();
    for (const row of existingChildHashes.all(email.id)) alreadyUnderThisEmail.add(row.content_hash);

    let parsed;
    try {
        parsed = await new PostalMime().parse(rec.blob, { forceRfc822Attachments: true });
    } catch (err) {
        blobParseErrors++;
        if (blobParseErrors <= 10) console.warn(`  postal-mime failed on ${rec.messageId}: ${err.message}`);
        continue;
    }
    blobsParsed++;

    if (blobsParsed <= 5) {
        const names = (parsed.attachments || []).slice(0, 8).map(a => a.filename || '(no name)').join(', ');
        console.log(`  [${blobsParsed}] "${rec.subject.substring(0, 60)}" → ${parsed.attachments.length} atts: ${names}`);
    }

    let childIdx = 0;
    for (const att of (parsed.attachments || [])) {
        if (att.mimeType === 'application/pkcs7-signature') { attsSkippedSig++; continue; }
        if (att.disposition === 'inline' && att.contentId) { attsSkippedInline++; continue; }

        childIdx++;
        const filename = att.filename || `smime_attachment_${childIdx}.bin`;
        const ext = path.extname(filename) || '.bin';
        attsByExt[ext.toLowerCase().slice(1) || 'nobin'] = (attsByExt[ext.toLowerCase().slice(1) || 'nobin'] || 0) + 1;

        const content = Buffer.from(att.content);
        const attHash = crypto.createHash('md5').update(content).digest('hex');

        if (alreadyUnderThisEmail.has(attHash)) {
            attsSkippedAlreadyThere++;
            continue;
        }

        const isDuplicate = seenHashes.has(attHash) ? 1 : 0;
        let finalFilename;
        if (isDuplicate) {
            finalFilename = seenHashes.get(attHash);
            attsDuped++;
        } else {
            const attId = uuidv4();
            finalFilename = `${investigationId}/${attId}${ext}`;
            seenHashes.set(attHash, finalFilename);
            await fsp.mkdir(path.join(UPLOADS_DIR, investigationId), { recursive: true });
            await fsp.writeFile(path.join(UPLOADS_DIR, finalFilename), content);
        }

        const attId = uuidv4();
        const docIdentifier = email.doc_identifier ? `${email.doc_identifier}_${String(childIdx).padStart(3, '0')}` : null;

        batch.push(() => {
            insertChild.run(
                attId, finalFilename, filename,
                att.mimeType || 'application/octet-stream', content.length,
                email.id, email.thread_id || null,
                attHash, isDuplicate, investigationId, email.custodian || null,
                docIdentifier, resolveFileExtension(filename, att.mimeType, finalFilename)
            );
        });
        attsInserted++;
        alreadyUnderThisEmail.add(attHash);
    }

    if (batch.length >= 200) {
        try { tx(batch); } catch (err) { console.error(`FLUSH ERROR: ${err.message}`); }
        batch.length = 0;
    }

    if ((i + 1) % 50 === 0 || i === records.length - 1) {
        console.log(`  ${i + 1}/${records.length} — parsed=${blobsParsed} inserted=${attsInserted} dupes=${attsDuped} already-there=${attsSkippedAlreadyThere} not-found=${emailsNotFound} parse-err=${blobParseErrors}`);
    }
}

if (batch.length > 0) {
    try { tx(batch); } catch (err) { console.error(`Final FLUSH ERROR: ${err.message}`); }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ Done in ${elapsed}s`);
console.log(`  blobs parsed:                ${blobsParsed}`);
console.log(`  emails not found in DB:      ${emailsNotFound}`);
console.log(`  attachments inserted:        ${attsInserted}`);
console.log(`    (of which content-dupes:   ${attsDuped})`);
console.log(`  skipped (.p7s signature):    ${attsSkippedSig}`);
console.log(`  skipped (inline CID image):  ${attsSkippedInline}`);
console.log(`  skipped (already on email):  ${attsSkippedAlreadyThere}`);
console.log(`  blob parse errors:           ${blobParseErrors}`);
if (Object.keys(attsByExt).length) {
    console.log(`\nBy extension:`);
    for (const [e, c] of Object.entries(attsByExt).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`    .${e}: ${c}`);
    }
}

db.close();
