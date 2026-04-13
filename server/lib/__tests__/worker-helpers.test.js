import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  disableFtsTriggers,
  enableFtsTriggers,
  rebuildFtsIndex,
  BULK_DROP_INDEXES,
  dropBulkIndexes,
  recreateBulkIndexes,
  refreshInvestigationCounts,
  walCheckpoint,
} from '../worker-helpers.js';

/**
 * Minimal schema matching production tables needed by worker-helpers.
 */
function createSchema(db) {
  db.exec(`
    CREATE TABLE investigations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_code TEXT,
      document_count INTEGER DEFAULT 0,
      email_count INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0,
      chat_count INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      investigation_id TEXT,
      doc_type TEXT DEFAULT 'file',
      original_name TEXT NOT NULL,
      text_content TEXT,
      email_subject TEXT,
      email_from TEXT,
      email_to TEXT,
      status TEXT DEFAULT 'pending',
      thread_id TEXT,
      content_hash TEXT,
      is_duplicate INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE documents_fts USING fts5(
      original_name,
      text_content,
      email_subject,
      email_from,
      email_to,
      content='documents',
      content_rowid='rowid'
    );

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
}

describe('worker-helpers', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('BULK_DROP_INDEXES', () => {
    it('should be a non-empty array of strings', () => {
      expect(Array.isArray(BULK_DROP_INDEXES)).toBe(true);
      expect(BULK_DROP_INDEXES.length).toBeGreaterThan(0);
      for (const name of BULK_DROP_INDEXES) {
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('refreshInvestigationCounts', () => {
    it('should correctly count documents by type', () => {
      // Create an investigation
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-1', 'Test Case', 'TST');

      // Insert documents of various types
      const insert = db.prepare('INSERT INTO documents (id, investigation_id, doc_type, original_name) VALUES (?, ?, ?, ?)');
      insert.run('d1', 'inv-1', 'email', 'msg1.eml');
      insert.run('d2', 'inv-1', 'email', 'msg2.eml');
      insert.run('d3', 'inv-1', 'attachment', 'report.pdf');
      insert.run('d4', 'inv-1', 'file', 'notes.txt');
      insert.run('d5', 'inv-1', 'chat', 'chat-2024-01-01.txt');
      insert.run('d6', 'inv-1', 'chat', 'chat-2024-01-02.txt');

      // Run the refresh
      refreshInvestigationCounts(db, 'inv-1');

      // Verify counts
      const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-1');
      expect(inv.document_count).toBe(6);
      expect(inv.email_count).toBe(2);
      expect(inv.attachment_count).toBe(1);
      expect(inv.file_count).toBe(1);
      expect(inv.chat_count).toBe(2);
    });

    it('should set all counts to zero for empty investigation', () => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-empty', 'Empty Case', 'EMP');

      refreshInvestigationCounts(db, 'inv-empty');

      const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-empty');
      expect(inv.document_count).toBe(0);
      expect(inv.email_count).toBe(0);
      expect(inv.attachment_count).toBe(0);
      expect(inv.file_count).toBe(0);
      expect(inv.chat_count).toBe(0);
    });

    it('should not count documents from other investigations', () => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-a', 'Case A', 'CAS');
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-b', 'Case B', 'CSB');

      const insert = db.prepare('INSERT INTO documents (id, investigation_id, doc_type, original_name) VALUES (?, ?, ?, ?)');
      insert.run('d1', 'inv-a', 'email', 'msg.eml');
      insert.run('d2', 'inv-b', 'file', 'notes.txt');
      insert.run('d3', 'inv-b', 'file', 'report.pdf');

      refreshInvestigationCounts(db, 'inv-a');
      refreshInvestigationCounts(db, 'inv-b');

      const invA = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-a');
      expect(invA.document_count).toBe(1);
      expect(invA.email_count).toBe(1);

      const invB = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-b');
      expect(invB.document_count).toBe(2);
      expect(invB.file_count).toBe(2);
    });
  });

  describe('FTS trigger disable/enable round-trip', () => {
    it('should disable then re-enable FTS triggers', () => {
      // Verify triggers exist initially (ai = insert, ad = delete, au = update)
      const triggersBefore = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'documents_a%'"
      ).all();
      expect(triggersBefore.length).toBe(3);

      // disableFtsTriggers drops ai and au (keeps ad for delete safety)
      disableFtsTriggers(db);

      const triggersAfterDisable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'documents_a%'"
      ).all();
      // Only documents_ad should remain
      expect(triggersAfterDisable.length).toBe(1);
      expect(triggersAfterDisable[0].name).toBe('documents_ad');

      // Re-enable triggers (recreates ai and au)
      enableFtsTriggers(db);

      const triggersAfterEnable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'documents_a%'"
      ).all();
      expect(triggersAfterEnable.length).toBe(3);
    });

    it('should allow FTS search after re-enabling triggers and rebuilding', () => {
      // Insert a document while triggers are active
      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d1', 'test.txt', 'hello world');

      // Disable, then re-enable
      disableFtsTriggers(db);
      enableFtsTriggers(db);

      // Insert another document after re-enable
      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d2', 'other.txt', 'goodbye world');

      // FTS search should find the second document (first may not be in FTS depending on rebuild)
      const results = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'goodbye'").all();
      expect(results.length).toBe(1);
    });
  });

  describe('rebuildFtsIndex', () => {
    it('should rebuild the FTS index from documents table', () => {
      // Disable triggers so inserts don't auto-populate FTS
      disableFtsTriggers(db);

      // Insert a document directly (no trigger to populate FTS)
      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d1', 'memo.txt', 'important memo content');

      // FTS should be empty since triggers were disabled
      const beforeRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'memo'").all();
      expect(beforeRebuild.length).toBe(0);

      // Rebuild and verify FTS now has the data
      rebuildFtsIndex(db);

      const afterRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'memo'").all();
      expect(afterRebuild.length).toBe(1);

      // Re-enable triggers for cleanup
      enableFtsTriggers(db);
    });
  });

  describe('walCheckpoint', () => {
    it('should not throw on an in-memory database', () => {
      expect(() => walCheckpoint(db)).not.toThrow();
    });
  });

  describe('dropBulkIndexes / recreateBulkIndexes', () => {
    it('should not throw on a database without the indexes', () => {
      // In-memory DB has no indexes to drop, should be a no-op
      expect(() => dropBulkIndexes(db)).not.toThrow();
    });

    it('should not throw when recreating indexes on a database with documents table', () => {
      expect(() => recreateBulkIndexes(db)).not.toThrow();
    });
  });
});
