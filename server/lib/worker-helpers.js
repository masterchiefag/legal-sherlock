/**
 * worker-helpers.js — Shared utilities for worker threads that perform bulk
 * document ingestion.  Extracts repeated patterns (FTS trigger management,
 * index drop/recreate, WAL checkpoint, investigation count refresh) so every
 * worker uses identical SQL and consistent logging.
 *
 * Every public function accepts a better-sqlite3 `db` instance as its first
 * argument, logs with a `✦ Worker:` prefix, and never throws (returns a
 * boolean indicating success).
 */

// ─── FTS trigger management ──────────────────────────────────────────────────

/**
 * Drop the FTS insert and update triggers so bulk inserts skip the virtual
 * table (much faster).  The index should be rebuilt afterwards via
 * `rebuildFtsIndex` and triggers re-enabled with `enableFtsTriggers`.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function disableFtsTriggers(db) {
    try {
        db.exec('DROP TRIGGER IF EXISTS documents_ai');
        db.exec('DROP TRIGGER IF EXISTS documents_au');
        console.log('✦ Worker: disabled FTS triggers (documents_ai, documents_au)');
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to disable FTS triggers —', err.message);
        return false;
    }
}

/**
 * Recreate the FTS insert and update triggers.  The SQL here must stay in sync
 * with the canonical definitions in `server/db.js`.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function enableFtsTriggers(db) {
    try {
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
            END;
        `);
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
            END;
        `);
        console.log('✦ Worker: re-enabled FTS triggers (documents_ai, documents_au)');
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to enable FTS triggers —', err.message);
        return false;
    }
}

/**
 * Rebuild the FTS5 virtual table index from scratch.  Call this after a bulk
 * insert with triggers disabled.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function rebuildFtsIndex(db) {
    try {
        const t0 = Date.now();
        db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`✦ Worker: FTS index rebuilt in ${elapsed}s`);
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to rebuild FTS index —', err.message);
        return false;
    }
}

// ─── Bulk index management ───────────────────────────────────────────────────

/**
 * Index names that are safe to drop during bulk imports and must be recreated
 * afterwards.  Keep in sync with the CREATE INDEX statements in
 * `recreateBulkIndexes`.
 *
 * @type {string[]}
 */
export const BULK_DROP_INDEXES = [
    'idx_documents_status',
    'idx_documents_doc_type',
    'idx_documents_status_doctype',
    'idx_documents_thread_doctype',
    'idx_documents_content_hash',
    'idx_documents_is_duplicate',
    'idx_documents_inv_doctype',
];

/**
 * Drop the indexes listed in `BULK_DROP_INDEXES`.  Speeds up bulk inserts
 * significantly; call `recreateBulkIndexes` when done.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function dropBulkIndexes(db) {
    try {
        for (const idx of BULK_DROP_INDEXES) {
            db.exec(`DROP INDEX IF EXISTS ${idx}`);
        }
        console.log(`✦ Worker: dropped ${BULK_DROP_INDEXES.length} indexes for bulk import`);
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to drop bulk indexes —', err.message);
        return false;
    }
}

/**
 * Recreate the indexes previously dropped by `dropBulkIndexes`.  The CREATE
 * INDEX statements here must stay in sync with the canonical schema.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function recreateBulkIndexes(db) {
    try {
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
            CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
            CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type);
            CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type);
            CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
            CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate);
            CREATE INDEX IF NOT EXISTS idx_documents_inv_doctype ON documents(investigation_id, doc_type);
        `);
        console.log('✦ Worker: recreated bulk indexes');
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to recreate bulk indexes —', err.message);
        return false;
    }
}

// ─── Investigation counts ────────────────────────────────────────────────────

/**
 * Refresh the precomputed document-type counts on an investigation row.
 * Reads from the per-investigation DB and writes to the main DB.
 *
 * @param {import('better-sqlite3').Database} mainDb  Main (global) DB connection
 * @param {import('better-sqlite3').Database} invDb   Per-investigation DB connection
 * @param {string} investigationId  UUID of the investigation to refresh
 * @returns {boolean} true on success
 */
export function refreshInvestigationCounts(mainDb, invDb, investigationId) {
    try {
        const counts = invDb.prepare(`
            SELECT
                COUNT(*) as document_count,
                SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as email_count,
                SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachment_count,
                SUM(CASE WHEN doc_type = 'chat' THEN 1 ELSE 0 END) as chat_count,
                SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as file_count
            FROM documents
        `).get();
        mainDb.prepare(`
            UPDATE investigations SET
                document_count = ?,
                email_count = ?,
                attachment_count = ?,
                chat_count = ?,
                file_count = ?
            WHERE id = ?
        `).run(
            counts.document_count || 0,
            counts.email_count || 0,
            counts.attachment_count || 0,
            counts.chat_count || 0,
            counts.file_count || 0,
            investigationId
        );
        console.log('✦ Worker: investigation counts refreshed');
        return true;
    } catch (err) {
        console.error('✦ Worker: failed to refresh investigation counts —', err.message);
        return false;
    }
}

// ─── Duplicate text backfill ─────────────────────────────────────────────────

/**
 * Backfill text_content from original documents into their duplicates.
 * Uses a hash-map lookup (one SELECT for originals, batched UPDATEs by ID)
 * instead of correlated subqueries for speed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} investigationId  UUID of the investigation
 * @param {object} [options]
 * @param {boolean} [options.includeOcr=false]  Also backfill ocr_applied/ocr_time_ms columns
 * @param {number} [options.batchSize=500]  Number of rows per transaction batch
 * @returns {{ backfilled: number, elapsed: number }} count and time in seconds
 */
export function backfillDuplicateText(db, investigationId, options = {}) {
    const { includeOcr = false, batchSize = 500 } = options;

    // Build lookup: content_hash -> original's text (+ optionally OCR fields)
    const selectCols = includeOcr
        ? 'content_hash, text_content, text_content_size, ocr_applied, ocr_time_ms'
        : 'content_hash, text_content, text_content_size';
    const originals = db.prepare(`
        SELECT ${selectCols}
        FROM documents
        WHERE is_duplicate = 0 AND text_content IS NOT NULL AND investigation_id = ?
        GROUP BY content_hash
    `).all(investigationId);
    const hashMap = new Map();
    for (const o of originals) hashMap.set(o.content_hash, o);
    console.log(`✦ Worker: backfill hash map built with ${hashMap.size} unique originals`);

    // Fetch duplicate IDs needing text (attachments and files)
    const dupes = db.prepare(`
        SELECT id, content_hash FROM documents
        WHERE is_duplicate = 1 AND doc_type IN ('attachment', 'file')
        AND investigation_id = ? AND text_content IS NULL
    `).all(investigationId);

    if (dupes.length === 0) return { backfilled: 0, elapsed: 0 };

    // Prepare update statement
    const updateSql = includeOcr
        ? 'UPDATE documents SET text_content = ?, text_content_size = ?, ocr_applied = ?, ocr_time_ms = ? WHERE id = ?'
        : 'UPDATE documents SET text_content = ?, text_content_size = ? WHERE id = ?';
    const updateDupe = db.prepare(updateSql);

    // Batch update with progress
    const t0 = Date.now();
    let backfilled = 0;
    for (let i = 0; i < dupes.length; i += batchSize) {
        const batch = dupes.slice(i, i + batchSize);
        db.transaction(() => {
            for (const dupe of batch) {
                const orig = hashMap.get(dupe.content_hash);
                if (orig) {
                    if (includeOcr) {
                        updateDupe.run(orig.text_content, orig.text_content_size, orig.ocr_applied, orig.ocr_time_ms, dupe.id);
                    } else {
                        updateDupe.run(orig.text_content, orig.text_content_size, dupe.id);
                    }
                    backfilled++;
                }
            }
        })();
        if (dupes.length > batchSize) {
            console.log(`✦ Worker: backfilling duplicates: ${Math.min(i + batchSize, dupes.length)}/${dupes.length}`);
        }
    }
    const elapsed = (Date.now() - t0) / 1000;
    console.log(`✦ Worker: backfill done — ${backfilled} duplicates in ${elapsed.toFixed(1)}s`);
    return { backfilled, elapsed };
}

// ─── WAL checkpoint ──────────────────────────────────────────────────────────

/**
 * Run a passive WAL checkpoint.  Safe to call from workers — PASSIVE never
 * blocks writers.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true on success
 */
export function walCheckpoint(db) {
    try {
        db.pragma('wal_checkpoint(PASSIVE)');
        console.log('✦ Worker: WAL checkpoint (PASSIVE) complete');
        return true;
    } catch (err) {
        console.error('✦ Worker: WAL checkpoint failed —', err.message);
        return false;
    }
}
