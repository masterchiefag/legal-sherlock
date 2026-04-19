/**
 * investigation-db.js — Per-investigation database connection manager.
 *
 * Each investigation gets its own SQLite file at data/investigations/{id}.db
 * containing documents, FTS, reviews, classifications, import jobs, etc.
 *
 * Connections are kept in an LRU pool (default 5 slots) to avoid open/close
 * overhead on every request.  Each connection pair (write + read-only) is
 * created on first access with full schema + idempotent migrations applied.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const INVESTIGATIONS_DIR = path.join(DATA_DIR, 'investigations');

// Ensure directory exists
fs.mkdirSync(INVESTIGATIONS_DIR, { recursive: true });

// ─── LRU connection pool ────────────────────────────────────────────────────

const MAX_POOL_SIZE = 5;
const pool = new Map();          // investigation_id → { db, readDb, lastAccess }

function evictOldest() {
    if (pool.size < MAX_POOL_SIZE) return;
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of pool) {
        if (entry.lastAccess < oldestTime) {
            oldestTime = entry.lastAccess;
            oldestKey = key;
        }
    }
    if (oldestKey) {
        console.log(`[inv-db] pool evicting ${oldestKey.substring(0, 8)}... (pool full at ${MAX_POOL_SIZE})`);
        const entry = pool.get(oldestKey);
        try { entry.db.close(); } catch (_) {}
        try { entry.readDb.close(); } catch (_) {}
        pool.delete(oldestKey);
    }
}

/**
 * Get or create a connection pair for the given investigation.
 * @param {string} investigationId
 * @returns {{ db: import('better-sqlite3').Database, readDb: import('better-sqlite3').Database }}
 */
export function getInvestigationDb(investigationId) {
    const existing = pool.get(investigationId);
    if (existing) {
        existing.lastAccess = Date.now();
        return { db: existing.db, readDb: existing.readDb };
    }

    evictOldest();

    const dbPath = getInvestigationDbPath(investigationId);
    const isNew = !fs.existsSync(dbPath);

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 15000');
    db.pragma('cache_size = -64000');
    db.pragma('mmap_size = 268435456');

    // Register file_ext() for SQL-side extension extraction
    db.function('file_ext', (name) => {
        if (!name) return 'unknown';
        const lastDot = name.lastIndexOf('.');
        return lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
    });

    if (isNew) {
        console.log(`[inv-db] creating NEW investigation DB: ${investigationId.substring(0, 8)}... at ${dbPath}`);
        initSchema(db);
    } else {
        runMigrations(db);
    }

    console.log(`[inv-db] pool open: ${investigationId.substring(0, 8)}... (${isNew ? 'new' : 'existing'}, pool size: ${pool.size + 1}/${MAX_POOL_SIZE})`);
    const readDb = new Database(dbPath, { readonly: true });
    readDb.pragma('journal_mode = WAL');
    readDb.pragma('busy_timeout = 1000');
    readDb.pragma('cache_size = -64000');
    readDb.pragma('mmap_size = 268435456');
    readDb.function('file_ext', (name) => {
        if (!name) return 'unknown';
        const lastDot = name.lastIndexOf('.');
        return lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
    });

    pool.set(investigationId, { db, readDb, lastAccess: Date.now() });
    return { db, readDb };
}

/**
 * Open a standalone write connection for a worker (not pooled).
 * Caller is responsible for closing it.
 * @param {string} investigationId
 * @returns {import('better-sqlite3').Database}
 */
export function openWorkerDb(investigationId) {
    const dbPath = getInvestigationDbPath(investigationId);
    const isNew = !fs.existsSync(dbPath);

    console.log(`[inv-db] worker opening: ${investigationId.substring(0, 8)}... (${isNew ? 'new DB' : 'existing'})`);

    const db = new Database(dbPath, { timeout: 15000 });
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 15000');
    db.pragma('cache_size = -64000');
    db.pragma('mmap_size = 268435456');

    db.function('file_ext', (name) => {
        if (!name) return 'unknown';
        const lastDot = name.lastIndexOf('.');
        return lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
    });

    if (isNew) {
        console.log(`[inv-db] creating NEW investigation DB (worker): ${investigationId.substring(0, 8)}... at ${dbPath}`);
        initSchema(db);
    } else {
        runMigrations(db);
    }

    return db;
}

/**
 * Get the filesystem path for an investigation's DB file.
 */
export function getInvestigationDbPath(investigationId) {
    return path.join(INVESTIGATIONS_DIR, `${investigationId}.db`);
}

/**
 * Close a specific investigation's connections and remove from pool.
 */
export function closeInvestigationDb(investigationId) {
    const entry = pool.get(investigationId);
    if (entry) {
        console.log(`[inv-db] pool closing: ${investigationId.substring(0, 8)}...`);
        try { entry.db.close(); } catch (_) {}
        try { entry.readDb.close(); } catch (_) {}
        pool.delete(investigationId);
    }
}

/**
 * Close all pooled connections (for graceful shutdown).
 */
export function closeAll() {
    console.log(`[inv-db] closing all pooled connections (${pool.size} open)`);
    for (const [id, entry] of pool) {
        try { entry.db.close(); } catch (_) {}
        try { entry.readDb.close(); } catch (_) {}
    }
    pool.clear();
}

/**
 * Delete an investigation's DB file (after closing connections).
 */
export function deleteInvestigationDb(investigationId) {
    closeInvestigationDb(investigationId);
    const dbPath = getInvestigationDbPath(investigationId);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(dbPath).size; } catch (_) {}
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(walPath); } catch (_) {}
    try { fs.unlinkSync(shmPath); } catch (_) {}
    const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
    console.log(`[inv-db] deleted investigation DB: ${investigationId.substring(0, 8)}... (${sizeMb} MB freed)`);
}

/**
 * List all investigation DB files.
 * @returns {string[]} Array of investigation IDs
 */
export function listInvestigationDbs() {
    try {
        return fs.readdirSync(INVESTIGATIONS_DIR)
            .filter(f => f.endsWith('.db'))
            .map(f => f.replace('.db', ''));
    } catch (_) {
        return [];
    }
}

/**
 * Run periodic WAL checkpoints on all pooled connections.
 */
export function checkpointAll() {
    if (pool.size === 0) return;
    console.log(`[inv-db] WAL checkpoint (PASSIVE) on ${pool.size} pooled connections`);
    for (const [id, entry] of pool) {
        try { entry.db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
    }
}

// ─── Schema ─────────────────────────────────────────────────────────────────

function initSchema(db) {
    db.exec(`
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
            -- Email fields
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
            -- Document metadata
            doc_author TEXT,
            doc_title TEXT,
            doc_created_at TEXT,
            doc_modified_at TEXT,
            doc_creator_tool TEXT,
            doc_keywords TEXT,
            doc_last_modified_by TEXT,
            doc_printed_at TEXT,
            doc_last_accessed_at TEXT,
            -- Deduplication
            content_hash TEXT,
            is_duplicate INTEGER DEFAULT 0,
            -- Email-level content fingerprint (MD5 of canonical form incl. sorted attachment MD5s).
            -- See server/lib/eml-parser.js computeDedupMd5() for the exact input. Used to detect
            -- the same email materialized into multiple PST folders (labels, Sent+Inbox for A->A, ...)
            -- without being fooled by Gmail's draft/sent Message-ID collision (see GitHub issue #61).
            dedup_md5 TEXT,
            -- JSON array of additional folder paths where the same content hash appeared.
            -- Populated on the primary row when a dedup-skip fires.
            duplicate_folders TEXT,
            -- MAPI non-email classes (GitHub issue #65 Phase 2): calendar / task / note / contact.
            -- Only populated when doc_type is one of 'calendar' / 'task' / 'note' / 'contact'.
            event_start_at TEXT,     -- ISO: appointment start / task start
            event_end_at TEXT,       -- ISO: appointment end / task due
            event_location TEXT,     -- appointment location
            mapi_class TEXT,         -- raw PR_MESSAGE_CLASS for forensic fidelity
            -- Custodian / investigation
            custodian TEXT,
            investigation_id TEXT,
            -- Doc identifier
            doc_identifier TEXT,
            recipient_count INTEGER,
            -- User attribution
            uploaded_by TEXT,
            -- Folder and source
            folder_path TEXT,
            -- Forensic source
            source_path TEXT,
            source_created_at TEXT,
            source_modified_at TEXT,
            source_accessed_at TEXT,
            source_job_id TEXT,
            is_cloud_only INTEGER DEFAULT 0,
            -- OCR
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
    createIndexes(db);

    // FTS
    createFts(db);
}

function createIndexes(db) {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_documents_message_id ON documents(message_id);
        CREATE INDEX IF NOT EXISTS idx_documents_thread_id ON documents(thread_id);
        CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
        CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
        CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate);
        CREATE INDEX IF NOT EXISTS idx_documents_dedup_md5 ON documents(dedup_md5);
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
}

function createFts(db) {
    db.exec(`
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

    // Verify FTS integrity — rebuild if corrupt
    try {
        db.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
    } catch (err) {
        console.warn('✦ Investigation DB: FTS corrupt, rebuilding...', err.message);
        try {
            db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
        } catch (rebuildErr) {
            console.error('✦ Investigation DB: FTS rebuild failed, recreating...');
            db.exec('DROP TABLE IF EXISTS documents_fts');
            createFts(db);
            db.exec(`
                INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
                SELECT rowid, original_name, COALESCE(text_content,''), COALESCE(email_subject,''),
                       COALESCE(email_from,''), COALESCE(email_to,'')
                FROM documents;
            `);
        }
    }
}

// ─── Migrations (idempotent) ────────────────────────────────────────────────

function columnExists(db, table, column) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
}

function runMigrations(db) {
    // Add denormalized tag columns to document_tags if missing
    if (!columnExists(db, 'document_tags', 'tag_name')) {
        db.exec(`ALTER TABLE document_tags ADD COLUMN tag_name TEXT NOT NULL DEFAULT ''`);
    }
    if (!columnExists(db, 'document_tags', 'tag_color')) {
        db.exec(`ALTER TABLE document_tags ADD COLUMN tag_color TEXT DEFAULT '#3b82f6'`);
    }

    // Email-level content dedup (GitHub issue #61 — Gmail draft/sent Message-ID collision fix).
    // Populated by pst-worker during fresh ingest; older rows keep NULL.
    if (!columnExists(db, 'documents', 'dedup_md5')) {
        db.exec(`ALTER TABLE documents ADD COLUMN dedup_md5 TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_dedup_md5 ON documents(dedup_md5)`);
    }
    if (!columnExists(db, 'documents', 'duplicate_folders')) {
        db.exec(`ALTER TABLE documents ADD COLUMN duplicate_folders TEXT`);
    }

    // MAPI calendar / task / note / contact support (GitHub issue #65 Phase 2).
    // readpst does not emit non-IPM.Note MAPI items (calendar appointments,
    // tasks, sticky notes, contacts) as .eml files — they're silently dropped.
    // We read them directly from MAPI via pst-extractor and store them as
    // documents with doc_type 'calendar' / 'task' / 'note' / 'contact' plus
    // the four columns below. All nullable; emails keep them NULL.
    if (!columnExists(db, 'documents', 'event_start_at')) {
        db.exec(`ALTER TABLE documents ADD COLUMN event_start_at TEXT`);  // ISO
    }
    if (!columnExists(db, 'documents', 'event_end_at')) {
        db.exec(`ALTER TABLE documents ADD COLUMN event_end_at TEXT`);    // ISO
    }
    if (!columnExists(db, 'documents', 'event_location')) {
        db.exec(`ALTER TABLE documents ADD COLUMN event_location TEXT`);
    }
    if (!columnExists(db, 'documents', 'mapi_class')) {
        // Raw PR_MESSAGE_CLASS for forensic fidelity — e.g. 'IPM.Appointment',
        // 'IPM.Task', 'IPM.StickyNote', 'IPM.Schedule.Meeting.Request'
        db.exec(`ALTER TABLE documents ADD COLUMN mapi_class TEXT`);
    }

    // Ensure FTS exists and is healthy
    const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'").get();
    if (!hasFts) {
        createFts(db);
        // Populate FTS from existing documents
        db.exec(`
            INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
            SELECT rowid, original_name, COALESCE(text_content,''), COALESCE(email_subject,''),
                   COALESCE(email_from,''), COALESCE(email_to,'')
            FROM documents;
        `);
    }

    // Ensure all indexes exist
    createIndexes(db);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Refresh investigation counts in the main DB by reading from the investigation DB.
 * @param {import('better-sqlite3').Database} mainDb  Main (global) DB connection
 * @param {import('better-sqlite3').Database} invDb   Investigation DB connection
 * @param {string} investigationId
 */
export function refreshInvestigationCounts(mainDb, invDb, investigationId) {
    const counts = invDb.prepare(`
        SELECT
            COUNT(*) as document_count,
            SUM(CASE WHEN doc_type = 'email' THEN 1 ELSE 0 END) as email_count,
            SUM(CASE WHEN doc_type = 'attachment' THEN 1 ELSE 0 END) as attachment_count,
            SUM(CASE WHEN doc_type = 'chat' THEN 1 ELSE 0 END) as chat_count,
            SUM(CASE WHEN doc_type = 'file' THEN 1 ELSE 0 END) as file_count
        FROM documents
    `).get();

    console.log(`[inv-db] refreshing counts for ${investigationId.substring(0, 8)}...: ${counts.document_count || 0} docs (${counts.email_count || 0} email, ${counts.attachment_count || 0} attach, ${counts.chat_count || 0} chat, ${counts.file_count || 0} file)`);

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
}
