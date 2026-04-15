/**
 * One-time migration: split monolithic ediscovery.db into per-investigation DB files.
 *
 * For each investigation, this script:
 * 1. Creates data/investigations/{id}.db with full schema + FTS
 * 2. Copies documents, document_tags, document_reviews, classifications,
 *    import_jobs, summarization_jobs, summaries, review_batches,
 *    review_batch_documents from the monolithic DB
 * 3. Backfills denormalized tag_name/tag_color on document_tags
 * 4. Rebuilds FTS index
 * 5. Verifies row counts match
 *
 * Idempotent: skips investigations that already have a DB file.
 *
 * Usage: node server/scripts/migrate-to-per-investigation-db.js
 *        node server/scripts/migrate-to-per-investigation-db.js --force  (re-migrate existing DBs)
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const MAIN_DB_PATH = path.join(DATA_DIR, 'ediscovery.db');
const INVESTIGATIONS_DIR = path.join(DATA_DIR, 'investigations');

const force = process.argv.includes('--force');

console.log('══════════════════════════════════════════════════════════');
console.log('  Migration: split monolithic DB into per-investigation DBs');
console.log('══════════════════════════════════════════════════════════');

if (!fs.existsSync(MAIN_DB_PATH)) {
    console.log('No monolithic database found at', MAIN_DB_PATH);
    console.log('Nothing to migrate — fresh install will use per-investigation DBs automatically.');
    process.exit(0);
}

fs.mkdirSync(INVESTIGATIONS_DIR, { recursive: true });

// Open monolithic DB (read-only to be safe)
const mainDb = new Database(MAIN_DB_PATH, { readonly: true });
mainDb.pragma('journal_mode = WAL');
mainDb.pragma('cache_size = -64000');
mainDb.pragma('mmap_size = 268435456');

// Check if per-investigation tables exist in the monolithic DB
const hasDocuments = mainDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get();
if (!hasDocuments) {
    console.log('No documents table in monolithic DB — migration may have already been completed.');
    console.log('If the server is already running with per-investigation DBs, this is expected.');
    mainDb.close();
    process.exit(0);
}

// Load tag metadata for denormalization
const tags = mainDb.prepare('SELECT id, name, color FROM tags').all();
const tagMap = new Map(tags.map(t => [t.id, { name: t.name, color: t.color }]));
console.log(`Loaded ${tagMap.size} tags for denormalization`);

// Get all investigations
const investigations = mainDb.prepare('SELECT id, name FROM investigations').all();
console.log(`Found ${investigations.length} investigations to migrate\n`);

if (investigations.length === 0) {
    console.log('No investigations found. Nothing to migrate.');
    mainDb.close();
    process.exit(0);
}

// ─── Schema for per-investigation DBs ──────────────────────────────────────
// Mirrors server/lib/investigation-db.js initSchema()

function initInvestigationDb(invDb) {
    invDb.exec(`
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            original_name TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER,
            text_content TEXT,
            text_content_size INTEGER,
            page_count INTEGER DEFAULT 0,
            uploaded_at TEXT DEFAULT (datetime('now')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','error')),
            doc_type TEXT DEFAULT 'file',
            parent_id TEXT,
            thread_id TEXT,
            message_id TEXT,
            in_reply_to TEXT,
            email_references TEXT,
            email_from TEXT,
            email_to TEXT,
            email_cc TEXT,
            email_bcc TEXT,
            email_subject TEXT,
            email_date TEXT,
            email_headers_raw TEXT,
            email_received_chain TEXT,
            email_originating_ip TEXT,
            email_auth_results TEXT,
            email_server_info TEXT,
            email_delivery_date TEXT,
            doc_author TEXT,
            doc_title TEXT,
            doc_created_at TEXT,
            doc_modified_at TEXT,
            doc_creator_tool TEXT,
            doc_keywords TEXT,
            doc_last_modified_by TEXT,
            doc_printed_at TEXT,
            doc_last_accessed_at TEXT,
            content_hash TEXT,
            is_duplicate INTEGER DEFAULT 0,
            custodian TEXT,
            investigation_id TEXT,
            doc_identifier TEXT,
            recipient_count INTEGER,
            uploaded_by TEXT,
            folder_path TEXT,
            source_path TEXT,
            source_created_at TEXT,
            source_modified_at TEXT,
            source_accessed_at TEXT,
            source_job_id TEXT,
            is_cloud_only INTEGER DEFAULT 0,
            ocr_applied INTEGER DEFAULT 0,
            ocr_time_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS document_tags (
            document_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            tag_name TEXT NOT NULL DEFAULT '',
            tag_color TEXT DEFAULT '#3b82f6',
            assigned_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (document_id, tag_id),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_reviews (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','relevant','not_relevant','privileged','technical_issue')),
            notes TEXT,
            reviewed_at TEXT DEFAULT (datetime('now')),
            reviewer_id TEXT,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS classifications (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            investigation_prompt TEXT NOT NULL,
            score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
            reasoning TEXT,
            provider TEXT,
            model TEXT,
            elapsed_seconds REAL,
            classified_at TEXT DEFAULT (datetime('now')),
            requested_by TEXT,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS import_jobs (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
            total_emails INTEGER DEFAULT 0,
            total_attachments INTEGER DEFAULT 0,
            progress_percent INTEGER DEFAULT 0,
            error_log TEXT,
            started_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT,
            investigation_id TEXT,
            phase TEXT DEFAULT 'importing',
            filepath TEXT,
            total_eml_files INTEGER DEFAULT 0,
            phase1_completed_at TEXT,
            elapsed_seconds INTEGER DEFAULT 0,
            custodian TEXT,
            started_by TEXT,
            job_type TEXT DEFAULT 'pst',
            extraction_done_at TEXT,
            preserve_source INTEGER DEFAULT 0,
            ocr_count INTEGER DEFAULT 0,
            ocr_success INTEGER DEFAULT 0,
            ocr_failed INTEGER DEFAULT 0,
            ocr_time_ms INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS summarization_jobs (
            id TEXT PRIMARY KEY,
            investigation_id TEXT,
            prompt TEXT NOT NULL,
            model TEXT,
            provider TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            total_docs INTEGER DEFAULT 0,
            processed_docs INTEGER DEFAULT 0,
            elapsed_seconds REAL DEFAULT 0,
            started_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS summaries (
            id TEXT PRIMARY KEY,
            job_id TEXT,
            document_id TEXT NOT NULL,
            summary TEXT,
            provider TEXT,
            model TEXT,
            elapsed_seconds REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (document_id) REFERENCES documents(id)
        );

        CREATE TABLE IF NOT EXISTS review_batches (
            id TEXT PRIMARY KEY,
            investigation_id TEXT NOT NULL,
            batch_number INTEGER NOT NULL,
            batch_size INTEGER NOT NULL,
            total_docs INTEGER NOT NULL,
            search_criteria TEXT NOT NULL,
            assignee_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(investigation_id, batch_number)
        );

        CREATE TABLE IF NOT EXISTS review_batch_documents (
            batch_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (batch_id, document_id),
            FOREIGN KEY (batch_id) REFERENCES review_batches(id) ON DELETE CASCADE,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
    `);

    // Indexes
    invDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_documents_message_id ON documents(message_id);
        CREATE INDEX IF NOT EXISTS idx_documents_thread_id ON documents(thread_id);
        CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
        CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
        CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate);
        CREATE INDEX IF NOT EXISTS idx_documents_custodian ON documents(custodian);
        CREATE INDEX IF NOT EXISTS idx_documents_email_date ON documents(email_date);
        CREATE INDEX IF NOT EXISTS idx_documents_investigation_id ON documents(investigation_id);
        CREATE INDEX IF NOT EXISTS idx_documents_inv_doctype ON documents(investigation_id, doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_thread_inv_date ON documents(thread_id, investigation_id, doc_type, email_date);
        CREATE INDEX IF NOT EXISTS idx_docs_inv_doctype ON documents(investigation_id, doc_type);
        CREATE INDEX IF NOT EXISTS idx_docs_inv_custodian ON documents(investigation_id, custodian);
        CREATE INDEX IF NOT EXISTS idx_docs_inv_emaildate ON documents(investigation_id, email_date);
        CREATE INDEX IF NOT EXISTS idx_docs_inv_doctype_dup ON documents(investigation_id, doc_type, is_duplicate);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_doc_identifier ON documents(doc_identifier);
        CREATE INDEX IF NOT EXISTS idx_document_reviews_document_id ON document_reviews(document_id);
        CREATE INDEX IF NOT EXISTS idx_docreviews_status_docid ON document_reviews(status, document_id);
        CREATE INDEX IF NOT EXISTS idx_document_tags_document_id ON document_tags(document_id);
        CREATE INDEX IF NOT EXISTS idx_classifications_document_id ON classifications(document_id);
        CREATE INDEX IF NOT EXISTS idx_classifications_classified_at ON classifications(classified_at DESC);
        CREATE INDEX IF NOT EXISTS idx_classifications_docid_id ON classifications(document_id, id);
        CREATE INDEX IF NOT EXISTS idx_import_jobs_investigation_id ON import_jobs(investigation_id);
        CREATE INDEX IF NOT EXISTS idx_review_batches_investigation ON review_batches(investigation_id);
        CREATE INDEX IF NOT EXISTS idx_review_batches_assignee ON review_batches(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_review_batch_documents_doc ON review_batch_documents(document_id);
    `);

    // FTS
    invDb.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
            original_name,
            text_content,
            email_subject,
            email_from,
            email_to,
            content='documents',
            content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
            VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
        END;

        CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
            VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
        END;

        CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
            VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
            INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
            VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
        END;
    `);
}

// ─── Get column names from monolithic DB ───────────────────────────────────
// Use PRAGMA to discover actual columns so we handle schemas with or without
// recent migrations gracefully.

function getColumnNames(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function tableExists(db, table) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

// ─── Migration ─────────────────────────────────────────────────────────────

let totalDocs = 0;
let totalMigrated = 0;
let skipped = 0;
let failed = 0;

for (const inv of investigations) {
    const dbPath = path.join(INVESTIGATIONS_DIR, `${inv.id}.db`);

    if (fs.existsSync(dbPath) && !force) {
        console.log(`⊘ Skipping "${inv.name}" (${inv.id}) — DB already exists. Use --force to re-migrate.`);
        skipped++;
        continue;
    }

    // If --force, remove old file first
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
        try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
    }

    console.log(`▸ Migrating "${inv.name}" (${inv.id})...`);
    const start = Date.now();

    try {
        // Create per-investigation DB
        const invDb = new Database(dbPath);
        invDb.pragma('journal_mode = WAL');
        invDb.pragma('foreign_keys = OFF');  // OFF during bulk insert for speed
        invDb.pragma('synchronous = OFF');   // Faster writes during migration
        invDb.pragma('cache_size = -128000');

        initInvestigationDb(invDb);

        // Disable FTS triggers during bulk insert (we'll rebuild at the end)
        invDb.exec(`DROP TRIGGER IF EXISTS documents_ai`);
        invDb.exec(`DROP TRIGGER IF EXISTS documents_ad`);
        invDb.exec(`DROP TRIGGER IF EXISTS documents_au`);

        // --- Copy documents ---
        const docCols = getColumnNames(mainDb, 'documents');
        // Filter to only cols that exist in the target schema
        const targetDocCols = getColumnNames(invDb, 'documents');
        const commonDocCols = docCols.filter(c => targetDocCols.includes(c));

        const colList = commonDocCols.join(', ');
        const placeholders = commonDocCols.map(() => '?').join(', ');

        const docs = mainDb.prepare(`SELECT ${colList} FROM documents WHERE investigation_id = ?`).all(inv.id);
        const docCount = docs.length;
        totalDocs += docCount;

        if (docCount > 0) {
            const insertDoc = invDb.prepare(`INSERT INTO documents (${colList}) VALUES (${placeholders})`);
            const insertBatch = invDb.transaction((rows) => {
                for (const row of rows) {
                    insertDoc.run(...commonDocCols.map(c => row[c]));
                }
            });

            // Insert in batches of 500
            for (let i = 0; i < docs.length; i += 500) {
                insertBatch(docs.slice(i, i + 500));
            }
        }
        console.log(`  documents: ${docCount}`);

        // --- Copy document_tags (with denormalized tag_name/tag_color) ---
        let tagCount = 0;
        if (tableExists(mainDb, 'document_tags')) {
            const dtRows = mainDb.prepare(`
                SELECT dt.document_id, dt.tag_id, dt.assigned_at
                FROM document_tags dt
                WHERE dt.document_id IN (SELECT id FROM documents WHERE investigation_id = ?)
            `).all(inv.id);
            tagCount = dtRows.length;

            if (tagCount > 0) {
                const insertTag = invDb.prepare(`
                    INSERT INTO document_tags (document_id, tag_id, tag_name, tag_color, assigned_at)
                    VALUES (?, ?, ?, ?, ?)
                `);
                const insertTagBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        const tag = tagMap.get(row.tag_id);
                        insertTag.run(
                            row.document_id,
                            row.tag_id,
                            tag?.name || '',
                            tag?.color || '#3b82f6',
                            row.assigned_at
                        );
                    }
                });
                for (let i = 0; i < dtRows.length; i += 500) {
                    insertTagBatch(dtRows.slice(i, i + 500));
                }
            }
        }
        console.log(`  document_tags: ${tagCount}`);

        // --- Copy document_reviews ---
        let reviewCount = 0;
        if (tableExists(mainDb, 'document_reviews')) {
            const reviewCols = getColumnNames(mainDb, 'document_reviews');
            const targetReviewCols = getColumnNames(invDb, 'document_reviews');
            const commonReviewCols = reviewCols.filter(c => targetReviewCols.includes(c));
            const rColList = commonReviewCols.join(', ');
            const rPlaceholders = commonReviewCols.map(() => '?').join(', ');

            const reviews = mainDb.prepare(`
                SELECT ${rColList} FROM document_reviews
                WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)
            `).all(inv.id);
            reviewCount = reviews.length;

            if (reviewCount > 0) {
                const insertReview = invDb.prepare(`INSERT INTO document_reviews (${rColList}) VALUES (${rPlaceholders})`);
                const insertReviewBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertReview.run(...commonReviewCols.map(c => row[c]));
                    }
                });
                for (let i = 0; i < reviews.length; i += 500) {
                    insertReviewBatch(reviews.slice(i, i + 500));
                }
            }
        }
        console.log(`  document_reviews: ${reviewCount}`);

        // --- Copy classifications ---
        let classCount = 0;
        if (tableExists(mainDb, 'classifications')) {
            const classCols = getColumnNames(mainDb, 'classifications');
            const targetClassCols = getColumnNames(invDb, 'classifications');
            const commonClassCols = classCols.filter(c => targetClassCols.includes(c));
            const cColList = commonClassCols.join(', ');
            const cPlaceholders = commonClassCols.map(() => '?').join(', ');

            const classifications = mainDb.prepare(`
                SELECT ${cColList} FROM classifications
                WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)
            `).all(inv.id);
            classCount = classifications.length;

            if (classCount > 0) {
                const insertClass = invDb.prepare(`INSERT INTO classifications (${cColList}) VALUES (${cPlaceholders})`);
                const insertClassBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertClass.run(...commonClassCols.map(c => row[c]));
                    }
                });
                for (let i = 0; i < classifications.length; i += 500) {
                    insertClassBatch(classifications.slice(i, i + 500));
                }
            }
        }
        console.log(`  classifications: ${classCount}`);

        // --- Copy import_jobs ---
        let jobCount = 0;
        if (tableExists(mainDb, 'import_jobs')) {
            const jobCols = getColumnNames(mainDb, 'import_jobs');
            const targetJobCols = getColumnNames(invDb, 'import_jobs');
            const commonJobCols = jobCols.filter(c => targetJobCols.includes(c));
            const jColList = commonJobCols.join(', ');
            const jPlaceholders = commonJobCols.map(() => '?').join(', ');

            const jobs = mainDb.prepare(`SELECT ${jColList} FROM import_jobs WHERE investigation_id = ?`).all(inv.id);
            jobCount = jobs.length;

            if (jobCount > 0) {
                const insertJob = invDb.prepare(`INSERT INTO import_jobs (${jColList}) VALUES (${jPlaceholders})`);
                const insertJobBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertJob.run(...commonJobCols.map(c => row[c]));
                    }
                });
                for (let i = 0; i < jobs.length; i += 500) {
                    insertJobBatch(jobs.slice(i, i + 500));
                }
            }
        }
        console.log(`  import_jobs: ${jobCount}`);

        // --- Copy summarization_jobs ---
        let sumJobCount = 0;
        if (tableExists(mainDb, 'summarization_jobs')) {
            const sumJobCols = getColumnNames(mainDb, 'summarization_jobs');
            const targetSumJobCols = getColumnNames(invDb, 'summarization_jobs');
            const commonSumJobCols = sumJobCols.filter(c => targetSumJobCols.includes(c));
            const sjColList = commonSumJobCols.join(', ');
            const sjPlaceholders = commonSumJobCols.map(() => '?').join(', ');

            const sumJobs = mainDb.prepare(`SELECT ${sjColList} FROM summarization_jobs WHERE investigation_id = ?`).all(inv.id);
            sumJobCount = sumJobs.length;

            if (sumJobCount > 0) {
                const insertSumJob = invDb.prepare(`INSERT INTO summarization_jobs (${sjColList}) VALUES (${sjPlaceholders})`);
                const insertSumJobBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertSumJob.run(...commonSumJobCols.map(c => row[c]));
                    }
                });
                for (let i = 0; i < sumJobs.length; i += 500) {
                    insertSumJobBatch(sumJobs.slice(i, i + 500));
                }
            }
        }
        console.log(`  summarization_jobs: ${sumJobCount}`);

        // --- Copy summaries ---
        let summaryCount = 0;
        if (tableExists(mainDb, 'summaries')) {
            const sumCols = getColumnNames(mainDb, 'summaries');
            const targetSumCols = getColumnNames(invDb, 'summaries');
            const commonSumCols = sumCols.filter(c => targetSumCols.includes(c));
            const sColList = commonSumCols.join(', ');
            const sPlaceholders = commonSumCols.map(() => '?').join(', ');

            const summaries = mainDb.prepare(`
                SELECT ${sColList} FROM summaries
                WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)
            `).all(inv.id);
            summaryCount = summaries.length;

            if (summaryCount > 0) {
                const insertSummary = invDb.prepare(`INSERT INTO summaries (${sColList}) VALUES (${sPlaceholders})`);
                const insertSummaryBatch = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertSummary.run(...commonSumCols.map(c => row[c]));
                    }
                });
                for (let i = 0; i < summaries.length; i += 500) {
                    insertSummaryBatch(summaries.slice(i, i + 500));
                }
            }
        }
        console.log(`  summaries: ${summaryCount}`);

        // --- Copy review_batches ---
        let batchCount = 0;
        if (tableExists(mainDb, 'review_batches')) {
            const batchCols = getColumnNames(mainDb, 'review_batches');
            const targetBatchCols = getColumnNames(invDb, 'review_batches');
            const commonBatchCols = batchCols.filter(c => targetBatchCols.includes(c));
            const bColList = commonBatchCols.join(', ');
            const bPlaceholders = commonBatchCols.map(() => '?').join(', ');

            const batches = mainDb.prepare(`SELECT ${bColList} FROM review_batches WHERE investigation_id = ?`).all(inv.id);
            batchCount = batches.length;

            if (batchCount > 0) {
                const insertBatch = invDb.prepare(`INSERT INTO review_batches (${bColList}) VALUES (${bPlaceholders})`);
                const insertBatchTx = invDb.transaction((rows) => {
                    for (const row of rows) {
                        insertBatch.run(...commonBatchCols.map(c => row[c]));
                    }
                });
                insertBatchTx(batches);

                // Copy review_batch_documents for these batches
                if (tableExists(mainDb, 'review_batch_documents')) {
                    const batchIds = batches.map(b => b.id);
                    const bdCols = getColumnNames(mainDb, 'review_batch_documents');
                    const targetBdCols = getColumnNames(invDb, 'review_batch_documents');
                    const commonBdCols = bdCols.filter(c => targetBdCols.includes(c));
                    const bdColList = commonBdCols.join(', ');
                    const bdPlaceholders = commonBdCols.map(() => '?').join(', ');

                    const insertBatchDoc = invDb.prepare(`INSERT INTO review_batch_documents (${bdColList}) VALUES (${bdPlaceholders})`);
                    const insertBatchDocTx = invDb.transaction((ids) => {
                        for (const batchId of ids) {
                            const batchDocs = mainDb.prepare(`
                                SELECT ${bdColList} FROM review_batch_documents WHERE batch_id = ?
                            `).all(batchId);
                            for (const row of batchDocs) {
                                insertBatchDoc.run(...commonBdCols.map(c => row[c]));
                            }
                        }
                    });
                    insertBatchDocTx(batchIds);
                }
            }
        }
        console.log(`  review_batches: ${batchCount}`);

        // --- Rebuild FTS index ---
        // Re-create triggers first
        invDb.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
            END;

            CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
            END;

            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
            END;
        `);

        // Populate FTS from inserted documents
        if (docCount > 0) {
            invDb.exec(`
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                SELECT rowid, original_name, COALESCE(text_content,''), COALESCE(email_subject,''),
                       COALESCE(email_from,''), COALESCE(email_to,'')
                FROM documents;
            `);
        }

        // Re-enable foreign keys and normal sync
        invDb.pragma('foreign_keys = ON');
        invDb.pragma('synchronous = FULL');

        // --- Verify counts ---
        const verifyDocCount = invDb.prepare('SELECT COUNT(*) as cnt FROM documents').get().cnt;
        if (verifyDocCount !== docCount) {
            console.error(`  ✗ Document count mismatch: expected ${docCount}, got ${verifyDocCount}`);
            failed++;
        }

        // FTS integrity check
        try {
            invDb.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
        } catch (err) {
            console.error(`  ✗ FTS integrity check failed: ${err.message}`);
        }

        // Checkpoint WAL
        invDb.pragma('wal_checkpoint(TRUNCATE)');
        invDb.close();

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const sizeKb = (fs.statSync(dbPath).size / 1024).toFixed(0);
        console.log(`  ✓ Done in ${elapsed}s (${sizeKb} KB)\n`);
        totalMigrated++;

    } catch (err) {
        console.error(`  ✗ Failed to migrate "${inv.name}": ${err.message}`);
        console.error(err.stack);
        failed++;
        // Clean up partial DB
        try { fs.unlinkSync(dbPath); } catch (_) {}
        try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
        try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
    }
}

mainDb.close();

console.log('══════════════════════════════════════════════════════════');
console.log(`  Migration complete`);
console.log(`  Investigations: ${totalMigrated} migrated, ${skipped} skipped, ${failed} failed`);
console.log(`  Total documents migrated: ${totalDocs}`);
console.log('══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠  Some investigations failed to migrate. Re-run with --force to retry.');
    process.exit(1);
}

if (totalMigrated > 0) {
    console.log('\nNext steps:');
    console.log('  1. Verify by starting the server: npm run dev:server');
    console.log('  2. Once confirmed working, you can optionally drop the old per-investigation');
    console.log('     tables from ediscovery.db to reclaim disk space (documents, document_tags,');
    console.log('     document_reviews, classifications, import_jobs, summarization_jobs,');
    console.log('     summaries, review_batches, review_batch_documents, documents_fts).');
}
