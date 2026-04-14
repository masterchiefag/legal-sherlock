/**
 * Test database factory — creates in-memory SQLite databases with production schema.
 * Used by all test files to get an isolated, fresh database for each test.
 */
import Database from 'better-sqlite3';

/**
 * Create an in-memory SQLite database with the full production schema.
 * All columns are defined inline (no migrations needed).
 */
export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      text_content TEXT,
      page_count INTEGER DEFAULT 0,
      uploaded_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','error')),
      -- Email columns
      doc_type TEXT DEFAULT 'file',
      parent_id TEXT,
      thread_id TEXT,
      message_id TEXT,
      in_reply_to TEXT,
      email_references TEXT,
      email_from TEXT,
      email_to TEXT,
      email_cc TEXT,
      email_subject TEXT,
      email_date TEXT,
      email_bcc TEXT,
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
      -- Deduplication
      content_hash TEXT,
      is_duplicate INTEGER DEFAULT 0,
      -- Custodian
      custodian TEXT,
      -- Investigation
      investigation_id TEXT,
      -- Folder & text size
      folder_path TEXT,
      text_content_size INTEGER,
      -- Doc identifier
      doc_identifier TEXT,
      doc_last_modified_by TEXT,
      doc_printed_at TEXT,
      doc_last_accessed_at TEXT,
      recipient_count INTEGER,
      -- User attribution
      uploaded_by TEXT,
      -- OCR
      ocr_applied INTEGER DEFAULT 0,
      ocr_time_ms INTEGER,
      -- Forensic source
      source_path TEXT,
      source_created_at TEXT,
      source_modified_at TEXT,
      source_accessed_at TEXT,
      source_job_id TEXT,
      is_cloud_only INTEGER DEFAULT 0
    );

    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE document_tags (
      document_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      assigned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (document_id, tag_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE document_reviews (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','relevant','not_relevant','privileged','technical_issue')),
      notes TEXT,
      reviewed_at TEXT DEFAULT (datetime('now')),
      reviewer_id TEXT,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE classifications (
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

    CREATE TABLE import_jobs (
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
      ocr_count INTEGER DEFAULT 0,
      ocr_success INTEGER DEFAULT 0,
      ocr_failed INTEGER DEFAULT 0,
      ocr_time_ms INTEGER DEFAULT 0,
      job_type TEXT DEFAULT 'pst'
    );

    CREATE TABLE investigations (
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
      updated_at TEXT DEFAULT (datetime('now')),
      short_code TEXT,
      document_count INTEGER DEFAULT 0,
      email_count INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0,
      chat_count INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0
    );

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
      completed_at TEXT,
      investigation_id TEXT,
      custodian TEXT
    );

    CREATE TABLE summarization_jobs (
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
    );

    CREATE TABLE summaries (
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

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'reviewer', 'viewer')),
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE investigation_members (
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

    CREATE TABLE audit_logs (
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

    CREATE TABLE review_batches (
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

    CREATE TABLE review_batch_documents (
      batch_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (batch_id, document_id),
      FOREIGN KEY (batch_id) REFERENCES review_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    -- FTS5 virtual table
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      original_name,
      text_content,
      email_subject,
      email_from,
      email_to,
      content='documents',
      content_rowid='rowid'
    );

    -- FTS sync triggers
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
      VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
    END;

    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
      VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
    END;

    CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
      VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
      INSERT INTO documents_fts(rowid, original_name, text_content, email_subject, email_from, email_to)
      VALUES (new.rowid, new.original_name, COALESCE(new.text_content,''), COALESCE(new.email_subject,''), COALESCE(new.email_from,''), COALESCE(new.email_to,''));
    END;
  `);

  // Register file_ext() custom function
  db.function('file_ext', (name) => {
    if (!name) return 'unknown';
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0 ? name.substring(lastDot).toLowerCase() : 'unknown';
  });

  return db;
}
