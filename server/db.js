import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'ediscovery.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -64000');    // 64MB page cache (default ~2MB)
db.pragma('mmap_size = 268435456');  // memory-map 256MB for faster reads

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    text_content TEXT,
    page_count INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','error'))
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#3b82f6',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_tags (
    document_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    assigned_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, tag_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS document_reviews (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','relevant','not_relevant','privileged')),
    notes TEXT,
    reviewed_at TEXT DEFAULT (datetime('now')),
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
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'archived')),
    allegation TEXT,
    key_parties TEXT,
    remarks TEXT,
    date_range_start TEXT,
    date_range_end TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ═══════════════════════════════════════════════════
// Migration: Add email-specific columns
// ═══════════════════════════════════════════════════
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

const emailMigrations = [
  { col: 'doc_type', type: "TEXT DEFAULT 'file'" },
  { col: 'parent_id', type: 'TEXT' },
  { col: 'thread_id', type: 'TEXT' },
  { col: 'message_id', type: 'TEXT' },
  { col: 'in_reply_to', type: 'TEXT' },
  { col: 'email_references', type: 'TEXT' },
  { col: 'email_from', type: 'TEXT' },
  { col: 'email_to', type: 'TEXT' },
  { col: 'email_cc', type: 'TEXT' },
  { col: 'email_subject', type: 'TEXT' },
  { col: 'email_date', type: 'TEXT' },
  // Email transport / server metadata
  { col: 'email_bcc', type: 'TEXT' },
  { col: 'email_headers_raw', type: 'TEXT' },
  { col: 'email_received_chain', type: 'TEXT' },    // JSON array of hops
  { col: 'email_originating_ip', type: 'TEXT' },
  { col: 'email_auth_results', type: 'TEXT' },
  { col: 'email_server_info', type: 'TEXT' },
  { col: 'email_delivery_date', type: 'TEXT' },
  // Document metadata (PDF, DOCX, etc.)
  { col: 'doc_author', type: 'TEXT' },
  { col: 'doc_title', type: 'TEXT' },
  { col: 'doc_created_at', type: 'TEXT' },
  { col: 'doc_modified_at', type: 'TEXT' },
  { col: 'doc_creator_tool', type: 'TEXT' },
  { col: 'doc_keywords', type: 'TEXT' },
  // Deduplication
  { col: 'content_hash', type: 'TEXT' },
  { col: 'is_duplicate', type: 'INTEGER DEFAULT 0' },
  // Custodian
  { col: 'custodian', type: 'TEXT' },
];

for (const { col, type } of emailMigrations) {
  if (!columnExists('documents', col)) {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
    console.log(`✦ Migration: added column documents.${col}`);
  }
}

// Create indexes for fast lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_message_id ON documents(message_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_thread_id ON documents(thread_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_document_reviews_document_id ON document_reviews(document_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_document_tags_document_id ON document_tags(document_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_classifications_document_id ON classifications(document_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_classifications_classified_at ON classifications(classified_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_status_doctype ON documents(status, doc_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_thread_doctype ON documents(thread_id, doc_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_is_duplicate ON documents(is_duplicate)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_custodian ON documents(custodian)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_email_date ON documents(email_date)`);

// ═══════════════════════════════════════════════════
// Migration: Add investigation_id to documents and import_jobs
// ═══════════════════════════════════════════════════
if (!columnExists('documents', 'investigation_id')) {
  db.exec(`ALTER TABLE documents ADD COLUMN investigation_id TEXT`);
  console.log(`✦ Migration: added column documents.investigation_id`);
}
if (!columnExists('import_jobs', 'investigation_id')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN investigation_id TEXT`);
  console.log(`✦ Migration: added column import_jobs.investigation_id`);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_investigation_id ON documents(investigation_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_import_jobs_investigation_id ON import_jobs(investigation_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_thread_inv_date ON documents(thread_id, investigation_id, doc_type, email_date)`);

// Composite indexes for dashboard stats and search queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_inv_doctype ON documents(investigation_id, doc_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_inv_custodian ON documents(investigation_id, custodian)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_inv_emaildate ON documents(investigation_id, email_date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_inv_doctype_dup ON documents(investigation_id, doc_type, is_duplicate)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_docreviews_status_docid ON document_reviews(status, document_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_classifications_docid_id ON classifications(document_id, id)`);

// ═══════════════════════════════════════════════════
// Migration: Add elapsed_seconds to classifications
// ═══════════════════════════════════════════════════
if (!columnExists('classifications', 'elapsed_seconds')) {
  db.exec(`ALTER TABLE classifications ADD COLUMN elapsed_seconds REAL`);
  console.log(`✦ Migration: added column classifications.elapsed_seconds`);
}

// ═══════════════════════════════════════════════════
// Migration: Add phase tracking to import_jobs
// ═══════════════════════════════════════════════════
if (!columnExists('import_jobs', 'phase')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN phase TEXT DEFAULT 'importing'`);
  console.log(`✦ Migration: added column import_jobs.phase`);
}

if (!columnExists('import_jobs', 'filepath')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN filepath TEXT`);
  console.log(`✦ Migration: added column import_jobs.filepath`);
}

if (!columnExists('import_jobs', 'total_eml_files')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN total_eml_files INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.total_eml_files`);
}

if (!columnExists('import_jobs', 'phase1_completed_at')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN phase1_completed_at TEXT`);
  console.log(`✦ Migration: added column import_jobs.phase1_completed_at`);
}

if (!columnExists('import_jobs', 'elapsed_seconds')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN elapsed_seconds INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.elapsed_seconds`);
}

if (!columnExists('import_jobs', 'custodian')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN custodian TEXT`);
  console.log(`✦ Migration: added column import_jobs.custodian`);
}

// ═══════════════════════════════════════════════════
// Migration: folder_path and text_content_size on documents
// ═══════════════════════════════════════════════════
if (!columnExists('documents', 'folder_path')) {
  db.exec(`ALTER TABLE documents ADD COLUMN folder_path TEXT`);
  console.log(`✦ Migration: added column documents.folder_path`);
}
if (!columnExists('documents', 'text_content_size')) {
  db.exec(`ALTER TABLE documents ADD COLUMN text_content_size INTEGER`);
  console.log(`✦ Migration: added column documents.text_content_size`);
  // Backfill from existing text_content
  const updated = db.prepare(`UPDATE documents SET text_content_size = LENGTH(text_content) WHERE text_content IS NOT NULL AND text_content_size IS NULL`).run();
  console.log(`✦ Migration: backfilled text_content_size for ${updated.changes} documents`);
}

// ═══════════════════════════════════════════════════
// Migration: doc_identifier on documents, short_code on investigations
// ═══════════════════════════════════════════════════
if (!columnExists('documents', 'doc_identifier')) {
  db.exec(`ALTER TABLE documents ADD COLUMN doc_identifier TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_doc_identifier ON documents(doc_identifier)`);
  console.log(`✦ Migration: added column documents.doc_identifier`);
}
if (!columnExists('documents', 'doc_last_modified_by')) {
  db.exec(`ALTER TABLE documents ADD COLUMN doc_last_modified_by TEXT`);
  console.log(`✦ Migration: added column documents.doc_last_modified_by`);
}
if (!columnExists('documents', 'doc_printed_at')) {
  db.exec(`ALTER TABLE documents ADD COLUMN doc_printed_at TEXT`);
  console.log(`✦ Migration: added column documents.doc_printed_at`);
}
if (!columnExists('documents', 'doc_last_accessed_at')) {
  db.exec(`ALTER TABLE documents ADD COLUMN doc_last_accessed_at TEXT`);
  console.log(`✦ Migration: added column documents.doc_last_accessed_at`);
}
if (!columnExists('documents', 'recipient_count')) {
  db.exec(`ALTER TABLE documents ADD COLUMN recipient_count INTEGER`);
  console.log(`✦ Migration: added column documents.recipient_count`);
}
if (!columnExists('investigations', 'short_code')) {
  db.exec(`ALTER TABLE investigations ADD COLUMN short_code TEXT`);
  console.log(`✦ Migration: added column investigations.short_code`);
}

// ═══════════════════════════════════════════════════
// Image extraction jobs (E01 forensic disk images)
// ═══════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS image_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('scan', 'extract')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    image_path TEXT NOT NULL,
    output_dir TEXT,
    phase TEXT,
    progress_percent INTEGER DEFAULT 0,
    result_data TEXT,
    error_log TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )
`);

// Migration: widen image_jobs.type CHECK to include 'whatsapp_zip'
try {
    const checkInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='image_jobs'").get();
    if (checkInfo?.sql && !checkInfo.sql.includes('whatsapp_zip')) {
        db.exec(`
            ALTER TABLE image_jobs RENAME TO image_jobs_old;
            CREATE TABLE image_jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('scan', 'extract', 'whatsapp_zip')),
                status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
                image_path TEXT NOT NULL,
                output_dir TEXT,
                phase TEXT,
                progress_percent INTEGER DEFAULT 0,
                result_data TEXT,
                error_log TEXT,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );
            INSERT INTO image_jobs SELECT * FROM image_jobs_old;
            DROP TABLE image_jobs_old;
        `);
    }
} catch (_) { /* table already migrated or fresh */ }

// Migration: widen image_jobs.type CHECK to include 'ingest'
try {
    const checkInfo2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='image_jobs'").get();
    if (checkInfo2?.sql && !checkInfo2.sql.includes('ingest')) {
        db.exec(`
            ALTER TABLE image_jobs RENAME TO image_jobs_old2;
            CREATE TABLE image_jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('scan', 'extract', 'whatsapp_zip', 'ingest')),
                status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
                image_path TEXT NOT NULL,
                output_dir TEXT,
                phase TEXT,
                progress_percent INTEGER DEFAULT 0,
                result_data TEXT,
                error_log TEXT,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );
            INSERT INTO image_jobs SELECT * FROM image_jobs_old2;
            DROP TABLE image_jobs_old2;
        `);
    }
} catch (_) { /* table already migrated or fresh */ }

// Migration: widen image_jobs.type CHECK to include 'metadata'
try {
    const checkInfo3 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='image_jobs'").get();
    if (checkInfo3?.sql && !checkInfo3.sql.includes('metadata')) {
        db.exec(`
            ALTER TABLE image_jobs RENAME TO image_jobs_old3;
            CREATE TABLE image_jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('scan', 'extract', 'whatsapp_zip', 'ingest', 'metadata')),
                status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
                image_path TEXT NOT NULL,
                output_dir TEXT,
                phase TEXT,
                progress_percent INTEGER DEFAULT 0,
                result_data TEXT,
                error_log TEXT,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );
            INSERT INTO image_jobs SELECT * FROM image_jobs_old3;
            DROP TABLE image_jobs_old3;
        `);
    }
} catch (_) { /* table already migrated or fresh */ }

// Migration: Add investigation_id and custodian to image_jobs
if (!columnExists('image_jobs', 'investigation_id')) {
    db.exec(`ALTER TABLE image_jobs ADD COLUMN investigation_id TEXT`);
    console.log(`✦ Migration: added column image_jobs.investigation_id`);
}
if (!columnExists('image_jobs', 'custodian')) {
    db.exec(`ALTER TABLE image_jobs ADD COLUMN custodian TEXT`);
    console.log(`✦ Migration: added column image_jobs.custodian`);
}

// Migration: Add forensic source metadata columns to documents
const sourceColumns = [
    { col: 'source_path', type: 'TEXT' },
    { col: 'source_created_at', type: 'TEXT' },
    { col: 'source_modified_at', type: 'TEXT' },
    { col: 'source_accessed_at', type: 'TEXT' },
    { col: 'source_job_id', type: 'TEXT' },
    { col: 'is_cloud_only', type: 'INTEGER DEFAULT 0' },
];
for (const { col, type } of sourceColumns) {
    if (!columnExists('documents', col)) {
        db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
        console.log(`✦ Migration: added column documents.${col}`);
    }
}

db.exec(`
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
    completed_at TEXT,
    FOREIGN KEY (investigation_id) REFERENCES investigations(id)
  )
`);

db.exec(`
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
  )
`);

// ═══════════════════════════════════════════════════
// Auth & access control tables
// ═══════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'reviewer', 'viewer')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investigation_members (
    id TEXT PRIMARY KEY,
    investigation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_override TEXT CHECK(role_override IN ('admin', 'reviewer', 'viewer')),
    added_by TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(investigation_id, user_id),
    FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_investigation_members_user ON investigation_members(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_investigation_members_inv ON investigation_members(investigation_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)`);

// Migration: Add user attribution columns to existing tables
if (!columnExists('documents', 'uploaded_by')) {
  db.exec(`ALTER TABLE documents ADD COLUMN uploaded_by TEXT`);
  console.log(`✦ Migration: added column documents.uploaded_by`);
}
if (!columnExists('document_reviews', 'reviewer_id')) {
  db.exec(`ALTER TABLE document_reviews ADD COLUMN reviewer_id TEXT`);
  console.log(`✦ Migration: added column document_reviews.reviewer_id`);
}
if (!columnExists('classifications', 'requested_by')) {
  db.exec(`ALTER TABLE classifications ADD COLUMN requested_by TEXT`);
  console.log(`✦ Migration: added column classifications.requested_by`);
}
if (!columnExists('import_jobs', 'started_by')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN started_by TEXT`);
  console.log(`✦ Migration: added column import_jobs.started_by`);
}

// ═══════════════════════════════════════════════════
// Rebuild FTS to include email fields
// ═══════════════════════════════════════════════════

// Drop old FTS table and triggers, recreate with email fields
const ftsColumns = db.prepare("PRAGMA table_info(documents_fts)").all().map(c => c.name);
const needsFtsRebuild = !ftsColumns.includes('email_subject');

if (needsFtsRebuild) {
  console.log('✦ Rebuilding FTS index to include email fields...');
  db.exec(`
    DROP TRIGGER IF EXISTS documents_ai;
    DROP TRIGGER IF EXISTS documents_ad;
    DROP TRIGGER IF EXISTS documents_au;
    DROP TABLE IF EXISTS documents_fts;

    CREATE VIRTUAL TABLE documents_fts USING fts5(
      original_name,
      text_content,
      email_subject,
      email_from,
      email_to,
      content='documents',
      content_rowid='rowid'
    );

    -- Populate FTS from existing data
    INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
    SELECT rowid, original_name, COALESCE(text_content,''), COALESCE(email_subject,''), COALESCE(email_from,''), COALESCE(email_to,'')
    FROM documents;
  `);
  console.log('✦ FTS index rebuilt.');
}

// Always ensure triggers exist (idempotent)
db.exec(`
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

// Verify FTS integrity on startup — rebuild if corrupt (e.g. worker crash left triggers disabled)
try {
  db.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
} catch (err) {
  console.warn('✦ FTS index corrupt, rebuilding...', err.message);
  try {
    db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
    console.log('✦ FTS index rebuilt successfully after corruption.');
  } catch (rebuildErr) {
    console.error('✦ FTS rebuild failed — dropping and recreating FTS table...');
    db.exec('DROP TABLE IF EXISTS documents_fts');
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        original_name, text_content, email_subject, email_from, email_to,
        content='documents', content_rowid='rowid'
      );
      INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
      SELECT rowid, original_name, COALESCE(text_content,''), COALESCE(email_subject,''), COALESCE(email_from,''), COALESCE(email_to,'')
      FROM documents;
    `);
    console.log('✦ FTS table recreated from scratch.');
  }
}

// ═══════════════════════════════════════════════════
// Migration: OCR tracking on documents and import_jobs
// ═══════════════════════════════════════════════════
if (!columnExists('documents', 'ocr_applied')) {
  db.exec(`ALTER TABLE documents ADD COLUMN ocr_applied INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column documents.ocr_applied`);
}
if (!columnExists('documents', 'ocr_time_ms')) {
  db.exec(`ALTER TABLE documents ADD COLUMN ocr_time_ms INTEGER`);
  console.log(`✦ Migration: added column documents.ocr_time_ms`);
}
if (!columnExists('import_jobs', 'ocr_count')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN ocr_count INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.ocr_count`);
}
if (!columnExists('import_jobs', 'ocr_success')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN ocr_success INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.ocr_success`);
}
if (!columnExists('import_jobs', 'ocr_failed')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN ocr_failed INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.ocr_failed`);
}
if (!columnExists('import_jobs', 'ocr_time_ms')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN ocr_time_ms INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.ocr_time_ms`);
}
if (!columnExists('import_jobs', 'job_type')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN job_type TEXT DEFAULT 'pst'`);
  console.log(`✦ Migration: added column import_jobs.job_type`);
}
if (!columnExists('import_jobs', 'extraction_done_at')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN extraction_done_at TEXT`);
  console.log(`✦ Migration: added column import_jobs.extraction_done_at`);
}
if (!columnExists('import_jobs', 'preserve_source')) {
  db.exec(`ALTER TABLE import_jobs ADD COLUMN preserve_source INTEGER DEFAULT 0`);
  console.log(`✦ Migration: added column import_jobs.preserve_source`);
}

// ═══════════════════════════════════════════════════
// Review Batches tables
// ═══════════════════════════════════════════════════
db.exec(`
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
    UNIQUE(investigation_id, batch_number),
    FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS review_batch_documents (
    batch_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (batch_id, document_id),
    FOREIGN KEY (batch_id) REFERENCES review_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_review_batches_investigation ON review_batches(investigation_id);
  CREATE INDEX IF NOT EXISTS idx_review_batches_assignee ON review_batches(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_review_batch_documents_doc ON review_batch_documents(document_id);
`);

// ═══════════════════════════════════════════════════
// Precomputed investigation counts
// ═══════════════════════════════════════════════════
for (const col of ['document_count', 'email_count', 'attachment_count', 'chat_count', 'file_count']) {
    if (!columnExists('investigations', col)) {
        db.exec(`ALTER TABLE investigations ADD COLUMN ${col} INTEGER DEFAULT 0`);
        console.log(`✦ Migration: added column investigations.${col}`);
    }
}

// Reusable helper to refresh counts for a single investigation
const refreshInvestigationCountsStmt = db.prepare(`
    UPDATE investigations SET
        document_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id),
        email_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'email'),
        attachment_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'attachment'),
        chat_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'chat'),
        file_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'file')
    WHERE id = @id
`);

function refreshInvestigationCounts(investigationId) {
    refreshInvestigationCountsStmt.run({ id: investigationId });
}

// Backfill existing investigations
const existingInvs = db.prepare('SELECT id FROM investigations').all();
for (const inv of existingInvs) {
    refreshInvestigationCounts(inv.id);
}
if (existingInvs.length > 0) {
    console.log(`✦ Backfilled counts for ${existingInvs.length} investigations`);
}

export { refreshInvestigationCounts };

// ═══════════════════════════════════════════════════
// Migrate review status: privileged → technical_issue
// ═══════════════════════════════════════════════════
const reviewTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='document_reviews'").get();
if (reviewTableSql && !reviewTableSql.sql.includes('technical_issue')) {
    console.log('✦ Migration: widening document_reviews CHECK constraint to include technical_issue');
    db.exec(`
        ALTER TABLE document_reviews RENAME TO document_reviews_old;

        CREATE TABLE document_reviews (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','relevant','not_relevant','privileged','technical_issue')),
            notes TEXT,
            reviewed_at TEXT DEFAULT (datetime('now')),
            reviewer_id TEXT,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        INSERT INTO document_reviews SELECT * FROM document_reviews_old;
        DROP TABLE document_reviews_old;

        CREATE INDEX IF NOT EXISTS idx_document_reviews_document_id ON document_reviews(document_id);
        CREATE INDEX IF NOT EXISTS idx_docreviews_status_docid ON document_reviews(status, document_id);
    `);

    // Seed "Privileged" tag if it doesn't exist
    const existingTag = db.prepare("SELECT id FROM tags WHERE name = 'Privileged'").get();
    let privilegedTagId;
    if (existingTag) {
        privilegedTagId = existingTag.id;
    } else {
        privilegedTagId = crypto.randomUUID();
        db.prepare("INSERT INTO tags (id, name, color) VALUES (?, 'Privileged', '#f59e0b')").run(privilegedTagId);
        console.log('✦ Migration: seeded "Privileged" default tag');
    }

    // Migrate existing privileged reviews: assign tag + reset status to pending
    const privilegedReviews = db.prepare("SELECT id, document_id FROM document_reviews WHERE status = 'privileged'").all();
    if (privilegedReviews.length > 0) {
        const assignTag = db.prepare("INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)");
        const updateStatus = db.prepare("UPDATE document_reviews SET status = 'pending' WHERE id = ?");
        for (const review of privilegedReviews) {
            assignTag.run(review.document_id, privilegedTagId);
            updateStatus.run(review.id);
        }
        console.log(`✦ Migration: converted ${privilegedReviews.length} privileged reviews → Privileged tag + pending status`);
    }
} else {
    // Ensure Privileged tag exists even if CHECK migration already ran
    const existingTag = db.prepare("SELECT id FROM tags WHERE name = 'Privileged'").get();
    if (!existingTag) {
        db.prepare("INSERT INTO tags (id, name, color) VALUES (?, 'Privileged', '#f59e0b')").run(crypto.randomUUID());
        console.log('✦ Migration: seeded "Privileged" default tag');
    }
}

// ═══════════════════════════════════════════════════
// System settings (admin-configurable, DB-backed)
// ═══════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'number',
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    unit TEXT,
    default_value TEXT NOT NULL,
    updated_at TEXT,
    updated_by TEXT REFERENCES users(id)
  )
`);

// Seed defaults (INSERT OR IGNORE so existing values are preserved)
const seedSetting = db.prepare(`
  INSERT OR IGNORE INTO system_settings (key, value, type, category, label, description, unit, default_value)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const seedSettings = db.transaction((settings) => {
  for (const s of settings) seedSetting.run(s.key, s.default_value, s.type, s.category, s.label, s.description, s.unit, s.default_value);
});
try {
  seedSettings([
    { key: 'ocr_dpi', type: 'number', category: 'ocr', label: 'OCR DPI', description: 'PDF-to-image resolution for OCR pipeline. Lower = faster, higher = more accurate.', unit: 'dpi', default_value: '100' },
    { key: 'ocr_pdftoppm_timeout', type: 'number', category: 'ocr', label: 'pdftoppm Timeout', description: 'Max time for PDF-to-image conversion per document.', unit: 'seconds', default_value: '60' },
    { key: 'ocr_tesseract_timeout', type: 'number', category: 'ocr', label: 'Tesseract Timeout', description: 'Max time for OCR per page.', unit: 'seconds', default_value: '60' },
    { key: 'ocr_min_text_length', type: 'number', category: 'ocr', label: 'OCR Text Threshold', description: 'If pdf-parse extracts fewer chars than this, trigger OCR fallback.', unit: 'chars', default_value: '100' },
    { key: 'extract_timeout', type: 'number', category: 'extraction', label: 'Extraction Timeout', description: 'Max time for text extraction subprocess (non-OCR).', unit: 'seconds', default_value: '15' },
    { key: 'extract_ocr_timeout', type: 'number', category: 'extraction', label: 'OCR Extraction Timeout', description: 'Max time for OCR extraction subprocess (pdftoppm + tesseract).', unit: 'seconds', default_value: '120' },
    { key: 'extract_max_file_size_mb', type: 'number', category: 'extraction', label: 'Max File Size', description: 'Files larger than this are skipped during extraction.', unit: 'MB', default_value: '50' },
    { key: 'import_parse_concurrency', type: 'number', category: 'import', label: 'Parse Concurrency', description: 'Parallel email parsing threads during PST import Phase 1.', unit: 'threads', default_value: String(Math.max(2, Math.min(os.cpus().length - 1, 6))) },
    { key: 'import_phase2_concurrency', type: 'number', category: 'import', label: 'Phase 2 Concurrency', description: 'Parallel text extraction threads during PST import Phase 2.', unit: 'threads', default_value: '4' },
    { key: 'import_db_batch_size', type: 'number', category: 'import', label: 'DB Batch Size', description: 'Documents per database transaction flush during import.', unit: 'docs', default_value: '500' },
    { key: 'import_max_attachment_size_mb', type: 'number', category: 'import', label: 'Max Attachment Size', description: 'Attachments larger than this are skipped during import.', unit: 'MB', default_value: '100' },
    { key: 'llm_max_body_chars', type: 'number', category: 'llm', label: 'Max Body Chars', description: 'Max characters per document body sent to LLM.', unit: 'chars', default_value: '100000' },
    { key: 'llm_max_thread_chars', type: 'number', category: 'llm', label: 'Max Thread Chars', description: 'Max characters for email thread context sent to LLM.', unit: 'chars', default_value: '1500' },
    { key: 'llm_max_attachment_chars', type: 'number', category: 'llm', label: 'Max Attachment Chars', description: 'Max characters per attachment context sent to LLM.', unit: 'chars', default_value: '1500' },
  ]);
  console.log('✦ System settings table ready');
} catch (err) {
  // Subprocess workers (extract-worker) import db.js but may hit SQLITE_BUSY
  // if the main worker holds a write lock. Settings are already seeded by the
  // main server process, so this is safe to skip.
  if (err.code === 'SQLITE_BUSY') {
    console.warn('[db] Settings seed skipped (database busy — likely subprocess)');
  } else {
    throw err;
  }
}

// Checkpoint WAL on startup (PASSIVE never blocks writers/readers)
try {
    const result = db.pragma('wal_checkpoint(PASSIVE)');
    console.log(`[db] WAL checkpoint on startup: ${JSON.stringify(result)}`);
} catch (err) {
    console.warn('[db] WAL checkpoint failed:', err.message);
}

// Read-only connection for queries — doesn't block on write locks during imports
const readDb = new Database(DB_PATH, { readonly: true });
readDb.pragma('journal_mode = WAL');
readDb.pragma('busy_timeout = 1000');
readDb.pragma('cache_size = -64000');
readDb.pragma('mmap_size = 268435456');

// Register file_ext() custom function for SQL-side extension extraction
function fileExtImpl(name) {
    if (!name) return 'unknown';
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
}
db.function('file_ext', fileExtImpl);
readDb.function('file_ext', fileExtImpl);

export { readDb };
export default db;
