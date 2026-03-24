/**
 * Backfill content hashes for all existing documents.
 * 
 * Computes MD5 hash from the uploaded file on disk, then marks
 * duplicates (any document whose hash already appeared earlier).
 * 
 * Usage: node server/scripts/backfill-hashes.js
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

console.log('══════════════════════════════════════');
console.log('  Backfill: computing content hashes');
console.log('══════════════════════════════════════');

// Get all documents without a hash
const docs = db.prepare(`SELECT id, filename FROM documents WHERE content_hash IS NULL`).all();
console.log(`Found ${docs.length} documents without hashes`);

const updateHash = db.prepare(`UPDATE documents SET content_hash = ? WHERE id = ?`);

let hashed = 0;
let skipped = 0;

// Phase 1: Compute hashes
const hashBatch = db.transaction((batch) => {
    for (const { hash, id } of batch) {
        updateHash.run(hash, id);
    }
});

const batch = [];
for (const doc of docs) {
    const filePath = path.join(UPLOADS_DIR, doc.filename);
    if (!fs.existsSync(filePath)) {
        skipped++;
        continue;
    }

    try {
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        batch.push({ hash, id: doc.id });
        hashed++;
    } catch (err) {
        console.error(`  ⚠ Failed to hash ${doc.filename}: ${err.message}`);
        skipped++;
    }

    // Flush batch every 500
    if (batch.length >= 500) {
        hashBatch(batch.splice(0));
        process.stdout.write(`  ✓ Hashed ${hashed} / ${docs.length}\r`);
    }
}

// Flush remaining
if (batch.length > 0) {
    hashBatch(batch.splice(0));
}

console.log(`\n✓ Hashed ${hashed} documents (${skipped} skipped)`);

// Phase 2: Mark duplicates
console.log('\nMarking duplicates...');

// Reset all is_duplicate flags first
db.prepare(`UPDATE documents SET is_duplicate = 0`).run();

// For each hash that appears more than once, mark all but the earliest as duplicate
const duplicateHashes = db.prepare(`
    SELECT content_hash, COUNT(*) as cnt 
    FROM documents 
    WHERE content_hash IS NOT NULL 
    GROUP BY content_hash 
    HAVING COUNT(*) > 1
`).all();

console.log(`Found ${duplicateHashes.length} groups of duplicates`);

const markDuplicate = db.prepare(`
    UPDATE documents SET is_duplicate = 1 
    WHERE content_hash = ? AND id != ?
`);

const markBatch = db.transaction((groups) => {
    for (const { hash, keepId } of groups) {
        markDuplicate.run(hash, keepId);
    }
});

const dupBatch = [];
let totalMarked = 0;

for (const { content_hash, cnt } of duplicateHashes) {
    // Keep the earliest uploaded document as the original
    const original = db.prepare(`
        SELECT id FROM documents 
        WHERE content_hash = ? 
        ORDER BY uploaded_at ASC 
        LIMIT 1
    `).get(content_hash);

    dupBatch.push({ hash: content_hash, keepId: original.id });
    totalMarked += (cnt - 1);

    if (dupBatch.length >= 500) {
        markBatch(dupBatch.splice(0));
    }
}

if (dupBatch.length > 0) {
    markBatch(dupBatch.splice(0));
}

console.log(`✓ Marked ${totalMarked} documents as duplicates`);

// Summary
const stats = db.prepare(`
    SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_duplicate = 1 THEN 1 ELSE 0 END) as duplicates,
        SUM(CASE WHEN is_duplicate = 0 OR is_duplicate IS NULL THEN 1 ELSE 0 END) as unique_docs
    FROM documents
`).get();

console.log(`\n══════════════════════════════════════`);
console.log(`  Total documents: ${stats.total}`);
console.log(`  Unique:          ${stats.unique_docs}`);
console.log(`  Duplicates:      ${stats.duplicates}`);
console.log(`══════════════════════════════════════`);
