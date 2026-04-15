#!/usr/bin/env node
/**
 * fix-bogus-dates.js
 *
 * Finds documents with pre-1970 dates (doc_created_at or doc_modified_at)
 * and re-extracts metadata from the original files to get correct dates.
 *
 * Usage:
 *   node server/scripts/fix-bogus-dates.js [--dry-run]
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { extractMetadata } from '../lib/extract.js';

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = path.resolve('data/investigations');
const UPLOADS_DIR = path.resolve('uploads');

async function main() {
    const dbFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.db'));
    let totalFixed = 0;
    let totalSkipped = 0;
    let totalMissing = 0;

    for (const dbFile of dbFiles) {
        const invId = dbFile.replace('.db', '');
        const dbPath = path.join(DATA_DIR, dbFile);
        const db = new Database(dbPath, { readonly: DRY_RUN });

        const rows = db.prepare(`
            SELECT id, filename, original_name, doc_created_at, doc_modified_at
            FROM documents
            WHERE doc_created_at < '1970-01-01' OR doc_modified_at < '1970-01-01'
        `).all();

        if (rows.length === 0) {
            db.close();
            continue;
        }

        console.log(`\n--- Investigation ${invId}: ${rows.length} documents with bogus dates ---`);

        const updateStmt = DRY_RUN ? null : db.prepare(`
            UPDATE documents
            SET doc_created_at = ?, doc_modified_at = ?
            WHERE id = ?
        `);

        for (const row of rows) {
            const filePath = path.join(UPLOADS_DIR, row.filename);
            if (!fs.existsSync(filePath)) {
                console.log(`  SKIP (file missing): ${row.original_name} -> ${filePath}`);
                totalMissing++;
                continue;
            }

            try {
                const meta = await extractMetadata(filePath);
                let newCreated = meta.createdAt || null;
                let newModified = meta.modifiedAt || null;

                // If re-extraction still returns bogus dates, null them out
                const isBogus = (d) => d && new Date(d).getTime() < 0;
                if (isBogus(newCreated)) newCreated = null;
                if (isBogus(newModified)) newModified = null;

                const oldCreated = row.doc_created_at;
                const oldModified = row.doc_modified_at;

                // Only update if at least one date actually changed
                const createdChanged = newCreated !== oldCreated;
                const modifiedChanged = newModified !== oldModified;

                if (!createdChanged && !modifiedChanged) {
                    console.log(`  SKIP (no change): ${row.original_name}`);
                    totalSkipped++;
                    continue;
                }

                console.log(`  FIX: ${row.original_name}`);
                if (createdChanged) console.log(`    created: ${oldCreated} -> ${newCreated}`);
                if (modifiedChanged) console.log(`    modified: ${oldModified} -> ${newModified}`);

                if (!DRY_RUN) {
                    updateStmt.run(newCreated, newModified, row.id);
                }
                totalFixed++;
            } catch (err) {
                console.error(`  ERROR: ${row.original_name}: ${err.message}`);
                totalSkipped++;
            }
        }

        db.close();
    }

    console.log(`\n=== Done ===`);
    console.log(`Fixed: ${totalFixed}, Skipped: ${totalSkipped}, Missing files: ${totalMissing}`);
    if (DRY_RUN) console.log('(dry run — no changes written)');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
