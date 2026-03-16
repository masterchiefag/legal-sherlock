import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'ediscovery.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
];

for (const { col, type } of emailMigrations) {
  if (!columnExists('documents', col)) {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
    console.log(`✦ Migration: added column documents.${col}`);
  }
}

// Create index on message_id for fast threading lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_message_id ON documents(message_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_thread_id ON documents(thread_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id)`);

// ═══════════════════════════════════════════════════
// Migration: Add elapsed_seconds to classifications
// ═══════════════════════════════════════════════════
if (!columnExists('classifications', 'elapsed_seconds')) {
  db.exec(`ALTER TABLE classifications ADD COLUMN elapsed_seconds REAL`);
  console.log(`✦ Migration: added column classifications.elapsed_seconds`);
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

export default db;
