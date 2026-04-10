import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'ediscovery.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

// Backfill: create default investigation and assign orphan documents
{
  let defaultId;
  const defaultInv = db.prepare(`SELECT id FROM investigations WHERE name = 'General Investigation'`).get();
  if (!defaultInv) {
    defaultId = crypto.randomUUID();
    db.prepare(`INSERT INTO investigations (id, name, description) VALUES (?, 'General Investigation', 'Default investigation for pre-existing documents')`).run(defaultId);
  } else {
    defaultId = defaultInv.id;
  }

  const orphanCount = db.prepare(`SELECT COUNT(*) as c FROM documents WHERE investigation_id IS NULL`).get().c;
  if (orphanCount > 0) {
    db.prepare(`UPDATE documents SET investigation_id = ? WHERE investigation_id IS NULL`).run(defaultId);
    db.prepare(`UPDATE import_jobs SET investigation_id = ? WHERE investigation_id IS NULL`).run(defaultId);
    console.log(`✦ Migration: assigned ${orphanCount} orphan documents to 'General Investigation'`);
  }
}
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

// Note: don't checkpoint WAL here — TRUNCATE requires exclusive lock and
// blocks worker threads from opening DB connections, causing deadlocks.

// Read-only connection for queries — doesn't block on write locks during imports
const readDb = new Database(DB_PATH, { readonly: true });
readDb.pragma('journal_mode = WAL');
readDb.pragma('busy_timeout = 1000');

export { readDb };
export default db;
