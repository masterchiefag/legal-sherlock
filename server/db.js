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

// ─── Global tables (shared across all investigations) ───────────────────────
// Per-investigation tables (documents, reviews, classifications, etc.) live in
// separate per-investigation DB files managed by server/lib/investigation-db.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#3b82f6',
    created_at TEXT DEFAULT (datetime('now'))
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
// Utility
// ═══════════════════════════════════════════════════
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

// ═══════════════════════════════════════════════════
// Migration: short_code on investigations
// ═══════════════════════════════════════════════════
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


// ═══════════════════════════════════════════════════
// FTS, documents, reviews, classifications, import_jobs, summarization, and
// review batches are now in per-investigation DB files. See
// server/lib/investigation-db.js for schema and migrations.
// ═══════════════════════════════════════════════════


// ═══════════════════════════════════════════════════
// Precomputed investigation counts (columns on investigations table)
// ═══════════════════════════════════════════════════
for (const col of ['document_count', 'email_count', 'attachment_count', 'chat_count', 'file_count']) {
    if (!columnExists('investigations', col)) {
        db.exec(`ALTER TABLE investigations ADD COLUMN ${col} INTEGER DEFAULT 0`);
        console.log(`✦ Migration: added column investigations.${col}`);
    }
}

// Seed "Privileged" tag if it doesn't exist
{
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
    { key: 'ocr_enabled', type: 'boolean', category: 'ocr', label: 'OCR Enabled', description: 'Enable OCR fallback for scanned/image-based PDFs. Disable for faster imports.', unit: '', default_value: 'true' },
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
