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
        console.log(`✦ Worker: investigation counts refreshed — ${counts.document_count || 0} docs (${counts.email_count || 0} email, ${counts.attachment_count || 0} attach, ${counts.chat_count || 0} chat, ${counts.file_count || 0} file)`);
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

// ─── Replicate extracted children across duplicate parents ──────────────────

/**
 * For every `is_duplicate=1` attachment that shares a `content_hash` with a
 * canonical `is_duplicate=0` row, clone the canonical's descendants under the
 * duplicate — reusing the disk `filename` (no new bytes written, just new
 * `documents` rows).  This closes the Rel-parity gap described in GitHub
 * issue #73: Sherlock's extraction phases (1.5 MSG, 1.6 ZIP, 1.7 PDF portfolio,
 * 1.9 recursive) skip duplicates, so a PDF attached to 10 emails only gets its
 * inner children extracted for the first email.  Relativity shows all 10 trees.
 *
 * Walks the tree iteratively via a fixed-point loop — each pass discovers new
 * dup→canonical pairs (children cloned in pass N become canonicals themselves
 * for grand-descendants in pass N+1).  Stops when a pass inserts zero rows.
 *
 * Idempotent: skips cloning when the target parent already has a child with
 * that (content_hash, original_name) pair, so re-running never duplicates.
 *
 * Recommended call order in finalization: AFTER all extraction phases finish
 * and BEFORE `refreshInvestigationCounts` / `enableFtsTriggers` /
 * `rebuildFtsIndex`.  FTS triggers should still be off at call time so the
 * inserts don't incur per-row trigger overhead.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} investigationId
 * @param {{maxPasses?: number}} [options] — safety cap on iteration depth (default 8)
 * @returns {{totalInserted: number, passes: number, perPass: number[], elapsed: number}}
 */
export function replicateChildrenToDuplicates(db, investigationId, options = {}) {
    const { maxPasses = 8 } = options;
    const t0 = Date.now();
    const perPass = [];
    let totalInserted = 0;

    // Performance-critical: on Yesha-scale DBs (~60k duplicate attachments,
    // ~10k canonical grandchildren), the naive "one big JOIN + NOT EXISTS in
    // one statement" plan is O(N²) and never finishes. We break it into three
    // cheap steps:
    //
    //   (1) Build a temp table `repl_pairs (dup_id, canonical_id, …)` using the
    //       indexed content_hash join. Small — bounded by #duplicates.
    //   (2) Pre-compute `existing_keys (parent_id, content_hash, original_name)`
    //       from real documents so the idempotency check is a single
    //       indexed-equality lookup instead of a correlated NOT EXISTS.
    //   (3) INSERT … SELECT joining (1) with child rows, LEFT JOIN-ing (2) and
    //       filtering existing.id IS NULL. Numbers the cloned rows via a
    //       ROW_NUMBER() window so we don't re-count peers per row.
    //
    // Each pass rebuilds (1) and (2) because newly-inserted rows in pass N
    // become canonicals for grandchildren in pass N+1.
    //
    // NOTE: column list deliberately excludes file_extension + has_html_body +
    // inline_images_meta — those are added by the still-open feat/html-email-
    // rendering branch and not present on main's schema yet. If/when that branch
    // merges, add them to this INSERT (they're nullable so omitting won't break
    // DBs that have them — the column just gets NULL for cloned rows).

    // Helper that runs one full pass inside a transaction.
    //
    // Implementation note: we drive the dup→canonical pairing in JS rather than
    // as a single big JOIN.  SQLite's optimizer on a direct JOIN picks
    // idx_docs_inv_doctype_dup (inv + doctype + is_duplicate) over
    // idx_documents_content_hash, which turns the join into O(dups × canonicals)
    // and runs for >15 min on Yesha-scale (60k dups × 30k canonicals).  Two JS
    // queries + a JS Map avoid the optimizer mis-step entirely.
    const runPass = () => {
        db.exec(`
            DROP TABLE IF EXISTS repl_pairs;
            DROP TABLE IF EXISTS repl_existing;
        `);

        // (1a) Pull canonicals into a JS Map keyed by content_hash.  One fast
        //      indexed scan.  Canonicals that have zero children contribute
        //      nothing to the insert, so filter here.
        const canonicalsWithKids = db.prepare(`
            SELECT c.id AS cid, c.content_hash, c.doc_type
            FROM documents c
            WHERE c.is_duplicate = 0
              AND c.investigation_id = ?
              AND c.content_hash IS NOT NULL
              AND EXISTS (SELECT 1 FROM documents k WHERE k.parent_id = c.id)
        `).all(investigationId);
        if (canonicalsWithKids.length === 0) return 0;

        // key is content_hash||doc_type so we never pair an attachment with an
        // email etc.  Value is an array of canonical IDs (same content_hash +
        // doc_type can recur when different investigations share, but we already
        // filtered by investigation above).
        const canonByKey = new Map();
        for (const c of canonicalsWithKids) {
            const key = `${c.content_hash}||${c.doc_type}`;
            if (!canonByKey.has(key)) canonByKey.set(key, []);
            canonByKey.get(key).push(c.cid);
        }

        // (1b) Pull duplicates in the target investigation with their identity
        //      fields.  Also an indexed scan.
        const dups = db.prepare(`
            SELECT d.id AS did, d.content_hash, d.doc_type, d.doc_identifier,
                   d.thread_id, d.custodian, d.investigation_id
            FROM documents d
            WHERE d.is_duplicate = 1
              AND d.investigation_id = ?
              AND d.content_hash IS NOT NULL
        `).all(investigationId);
        if (dups.length === 0) return 0;

        // (1c) Build the pair list in JS and bulk-insert into a temp table.  The
        //      dup_existing_kids count is needed downstream so the doc_identifier
        //      suffix (`_NNN`) starts after whatever children the dup may already
        //      have from a prior partial run.  One indexed lookup per pair — fast.
        const countExistingKids = db.prepare(
            `SELECT COUNT(*) AS n FROM documents WHERE parent_id = ?`
        );
        db.exec(`
            CREATE TEMP TABLE repl_pairs (
                dup_id TEXT,
                canonical_id TEXT,
                dup_identifier TEXT,
                dup_thread_id TEXT,
                dup_custodian TEXT,
                inv_id TEXT,
                dup_existing_kids INTEGER
            )
        `);
        const insertPair = db.prepare(`
            INSERT INTO repl_pairs (dup_id, canonical_id, dup_identifier, dup_thread_id, dup_custodian, inv_id, dup_existing_kids)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        let pairCount = 0;
        const kidCountCache = new Map();  // dup_id → cached count (dup rarely has duplicate pairs)
        for (const d of dups) {
            const key = `${d.content_hash}||${d.doc_type}`;
            const matches = canonByKey.get(key);
            if (!matches) continue;
            let dupKids = kidCountCache.get(d.did);
            if (dupKids === undefined) {
                dupKids = countExistingKids.get(d.did).n;
                kidCountCache.set(d.did, dupKids);
            }
            for (const canonId of matches) {
                if (canonId === d.did) continue;  // skip self-reference
                insertPair.run(d.did, canonId, d.doc_identifier, d.thread_id, d.custodian, d.investigation_id, dupKids);
                pairCount++;
            }
        }
        if (pairCount === 0) return 0;
        db.exec(`CREATE INDEX repl_pairs_dup_idx ON repl_pairs(dup_id)`);
        db.exec(`CREATE INDEX repl_pairs_canonical_idx ON repl_pairs(canonical_id)`);

        // (2) Existing (parent_id, content_hash, original_name) tuples for fast
        //     idempotency LEFT JOIN.  Only covers rows whose parent is one of
        //     the target dup_ids we're about to clone under.
        db.prepare(`
            CREATE TEMP TABLE repl_existing AS
            SELECT parent_id, content_hash, original_name
            FROM documents
            WHERE parent_id IN (SELECT dup_id FROM repl_pairs)
              AND content_hash IS NOT NULL
        `).run();
        db.exec(`CREATE INDEX repl_existing_idx ON repl_existing(parent_id, content_hash, original_name)`);

        // (3) The main INSERT.  ROW_NUMBER() assigns each cloned row a sequential
        //     number within its (dup_id) group, added to dup_existing_kids so
        //     doc_identifier suffixes never collide with pre-existing children.
        const info = db.prepare(`
            INSERT INTO documents (
                id, filename, original_name, mime_type, size_bytes, text_content, status,
                doc_type, parent_id, thread_id,
                content_hash, is_duplicate, investigation_id, custodian,
                doc_identifier, text_content_size
            )
            SELECT
                lower(hex(randomblob(16))),
                child.filename,
                child.original_name,
                child.mime_type,
                child.size_bytes,
                child.text_content,
                child.status,
                child.doc_type,
                p.dup_id,
                COALESCE(p.dup_thread_id, child.thread_id),
                child.content_hash,
                1,
                p.inv_id,
                COALESCE(p.dup_custodian, child.custodian),
                CASE
                  WHEN p.dup_identifier IS NULL THEN NULL
                  ELSE p.dup_identifier || '_' || printf(
                    '%03d',
                    p.dup_existing_kids + ROW_NUMBER() OVER (PARTITION BY p.dup_id ORDER BY child.id)
                  )
                END,
                child.text_content_size
            FROM repl_pairs p
            JOIN documents child
              ON child.parent_id = p.canonical_id
            LEFT JOIN repl_existing e
              ON e.parent_id = p.dup_id
             AND e.content_hash = child.content_hash
             AND e.original_name = child.original_name
            WHERE e.parent_id IS NULL
        `).run();

        // Drop the temp tables so a subsequent pass rebuilds from fresh state.
        db.exec(`
            DROP TABLE IF EXISTS repl_existing;
            DROP TABLE IF EXISTS repl_pairs;
        `);
        return info.changes;
    };

    for (let pass = 1; pass <= maxPasses; pass++) {
        const t = Date.now();
        let inserted;
        try {
            inserted = db.transaction(runPass)();
        } catch (err) {
            console.error(`✦ Worker: replicateChildrenToDuplicates pass ${pass} failed —`, err.message);
            break;
        }
        perPass.push(inserted);
        totalInserted += inserted;
        const elapsed = ((Date.now() - t) / 1000).toFixed(1);
        console.log(`✦ Worker: replication pass ${pass}: inserted ${inserted.toLocaleString()} rows in ${elapsed}s`);
        if (inserted === 0) break;
    }

    const elapsed = (Date.now() - t0) / 1000;
    console.log(`✦ Worker: replication complete — ${totalInserted.toLocaleString()} rows across ${perPass.length} passes in ${elapsed.toFixed(1)}s`);
    return { totalInserted, passes: perPass.length, perPass, elapsed };
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
