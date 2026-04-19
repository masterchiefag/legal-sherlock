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
  backfillDuplicateText,
  replicateChildrenToDuplicates,
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
      text_content_size INTEGER DEFAULT 0,
      email_subject TEXT,
      email_from TEXT,
      email_to TEXT,
      status TEXT DEFAULT 'pending',
      thread_id TEXT,
      content_hash TEXT,
      is_duplicate INTEGER DEFAULT 0,
      ocr_applied INTEGER DEFAULT 0,
      ocr_time_ms INTEGER,
      -- Columns added so replicateChildrenToDuplicates INSERT can populate them
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      parent_id TEXT,
      custodian TEXT,
      doc_identifier TEXT,
      file_extension TEXT
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
      refreshInvestigationCounts(db, db, 'inv-1');

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

      refreshInvestigationCounts(db, db, 'inv-empty');

      const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-empty');
      expect(inv.document_count).toBe(0);
      expect(inv.email_count).toBe(0);
      expect(inv.attachment_count).toBe(0);
      expect(inv.file_count).toBe(0);
      expect(inv.chat_count).toBe(0);
    });

    it('should not count documents from other investigations', () => {
      // In the per-investigation DB model, each investigation has its own DB
      // so cross-contamination is impossible. Simulate with separate in-memory DBs.
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-a', 'Case A', 'CAS');
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-b', 'Case B', 'CSB');

      // Inv-A DB: only has inv-a's doc
      const invADb = new Database(':memory:');
      invADb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, investigation_id TEXT, doc_type TEXT DEFAULT 'file', original_name TEXT NOT NULL)`);
      invADb.prepare('INSERT INTO documents (id, investigation_id, doc_type, original_name) VALUES (?, ?, ?, ?)').run('d1', 'inv-a', 'email', 'msg.eml');

      // Inv-B DB: only has inv-b's docs
      const invBDb = new Database(':memory:');
      invBDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, investigation_id TEXT, doc_type TEXT DEFAULT 'file', original_name TEXT NOT NULL)`);
      const insert = invBDb.prepare('INSERT INTO documents (id, investigation_id, doc_type, original_name) VALUES (?, ?, ?, ?)');
      insert.run('d2', 'inv-b', 'file', 'notes.txt');
      insert.run('d3', 'inv-b', 'file', 'report.pdf');

      refreshInvestigationCounts(db, invADb, 'inv-a');
      refreshInvestigationCounts(db, invBDb, 'inv-b');

      const invA = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-a');
      expect(invA.document_count).toBe(1);
      expect(invA.email_count).toBe(1);

      const invB = db.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-b');
      expect(invB.document_count).toBe(2);
      expect(invB.file_count).toBe(2);

      invADb.close();
      invBDb.close();
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

  describe('backfillDuplicateText', () => {
    const INV = 'inv-backfill';
    const insert = (db, id, hash, isDup, text, opts = {}) => {
      db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, content_hash, is_duplicate, text_content, text_content_size, ocr_applied, ocr_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, INV, opts.docType || 'attachment', `${id}.pdf`, hash, isDup ? 1 : 0, text, text ? text.length : 0, opts.ocrApplied || 0, opts.ocrTimeMs || null);
    };

    beforeEach(() => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run(INV, 'Backfill Test', 'BFT');
    });

    it('should copy text from original to duplicates with matching content_hash', () => {
      insert(db, 'orig-1', 'hash-aaa', false, 'original text content');
      insert(db, 'dupe-1', 'hash-aaa', true, null);
      insert(db, 'dupe-2', 'hash-aaa', true, null);

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(2);
      const d1 = db.prepare('SELECT text_content, text_content_size FROM documents WHERE id = ?').get('dupe-1');
      expect(d1.text_content).toBe('original text content');
      expect(d1.text_content_size).toBe('original text content'.length);
      const d2 = db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-2');
      expect(d2.text_content).toBe('original text content');
    });

    it('should not overwrite duplicates that already have text', () => {
      insert(db, 'orig-1', 'hash-bbb', false, 'original text');
      insert(db, 'dupe-1', 'hash-bbb', true, 'already has text');

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(0);
      const d = db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-1');
      expect(d.text_content).toBe('already has text');
    });

    it('should handle multiple content hashes independently', () => {
      insert(db, 'orig-a', 'hash-111', false, 'text for hash 111');
      insert(db, 'orig-b', 'hash-222', false, 'text for hash 222');
      insert(db, 'dupe-a', 'hash-111', true, null);
      insert(db, 'dupe-b', 'hash-222', true, null);

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(2);
      expect(db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-a').text_content).toBe('text for hash 111');
      expect(db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-b').text_content).toBe('text for hash 222');
    });

    it('should not touch documents in other investigations', () => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-other', 'Other Case', 'OTH');
      insert(db, 'orig-1', 'hash-ccc', false, 'my text');
      // Duplicate in another investigation
      db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, content_hash, is_duplicate, text_content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('dupe-other', 'inv-other', 'attachment', 'other.pdf', 'hash-ccc', 1, null);

      backfillDuplicateText(db, INV);

      const d = db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-other');
      expect(d.text_content).toBeNull();
    });

    it('should include OCR fields when includeOcr is true', () => {
      insert(db, 'orig-1', 'hash-ocr', false, 'ocr text', { ocrApplied: 1, ocrTimeMs: 500 });
      insert(db, 'dupe-1', 'hash-ocr', true, null);

      backfillDuplicateText(db, INV, { includeOcr: true });

      const d = db.prepare('SELECT text_content, ocr_applied, ocr_time_ms FROM documents WHERE id = ?').get('dupe-1');
      expect(d.text_content).toBe('ocr text');
      expect(d.ocr_applied).toBe(1);
      expect(d.ocr_time_ms).toBe(500);
    });

    it('should not backfill OCR fields when includeOcr is false', () => {
      insert(db, 'orig-1', 'hash-noocr', false, 'some text', { ocrApplied: 1, ocrTimeMs: 300 });
      insert(db, 'dupe-1', 'hash-noocr', true, null);

      backfillDuplicateText(db, INV, { includeOcr: false });

      const d = db.prepare('SELECT text_content, ocr_applied, ocr_time_ms FROM documents WHERE id = ?').get('dupe-1');
      expect(d.text_content).toBe('some text');
      expect(d.ocr_applied).toBe(0); // unchanged from default
      expect(d.ocr_time_ms).toBeNull();
    });

    it('should backfill duplicates with doc_type file (zip/image-ingest imports)', () => {
      insert(db, 'orig-file', 'hash-file', false, 'file text content', { docType: 'file' });
      insert(db, 'dupe-file', 'hash-file', true, null, { docType: 'file' });

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(1);
      const d = db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-file');
      expect(d.text_content).toBe('file text content');
    });

    it('should return zero when no duplicates need backfill', () => {
      insert(db, 'orig-1', 'hash-ddd', false, 'text');

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(0);
    });

    it('should handle large batches correctly', () => {
      insert(db, 'orig-1', 'hash-bulk', false, 'bulk text');
      // Insert 1200 duplicates to test batching (default batch size 500)
      const stmt = db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, content_hash, is_duplicate, text_content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 1200; i++) {
        stmt.run(`dupe-${i}`, INV, 'attachment', `file-${i}.pdf`, 'hash-bulk', 1, null);
      }

      const result = backfillDuplicateText(db, INV);

      expect(result.backfilled).toBe(1200);
      // Spot-check a few
      expect(db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-0').text_content).toBe('bulk text');
      expect(db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-999').text_content).toBe('bulk text');
      expect(db.prepare('SELECT text_content FROM documents WHERE id = ?').get('dupe-1199').text_content).toBe('bulk text');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GitHub issue #73 — replicate extracted children across duplicate parents
  // ────────────────────────────────────────────────────────────────────────
  describe('replicateChildrenToDuplicates', () => {
    const INV = 'inv-repl';

    beforeEach(() => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run(INV, 'Replication Test', 'RPL');
      // Disable FTS triggers for bulk-insert style scenario
      disableFtsTriggers(db);
    });

    const insertAtt = (id, { hash, isDup = 0, parent_id = null, filename = null, originalName = null, doc_identifier = null, text = null, mime = 'application/pdf' }) => {
      db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, filename, mime_type, size_bytes,
                               content_hash, is_duplicate, parent_id, doc_identifier, text_content, text_content_size, status)
        VALUES (?, ?, 'attachment', ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, 'ready')
      `).run(id, INV, originalName || `${id}.pdf`, filename || `shared/${hash}.pdf`, mime, hash, isDup, parent_id, doc_identifier, text, text ? text.length : 0);
    };

    it('clones children from canonical parent to duplicate twin', () => {
      // canonical A with 2 extracted kids
      insertAtt('canon-A', { hash: 'hash-A', doc_identifier: 'CAS_XXX_00001_001' });
      insertAtt('k1', { hash: 'k1h', parent_id: 'canon-A', originalName: 'Annex1.pdf' });
      insertAtt('k2', { hash: 'k2h', parent_id: 'canon-A', originalName: 'Annex2.pdf' });
      // duplicate of A with same content_hash — no kids yet
      insertAtt('dup-A', { hash: 'hash-A', isDup: 1, doc_identifier: 'CAS_XXX_00002_005' });

      const res = replicateChildrenToDuplicates(db, INV);

      expect(res.totalInserted).toBe(2);
      // Verify dup-A now has 2 kids pointing to the same disk filenames
      const kids = db.prepare('SELECT original_name, filename, is_duplicate FROM documents WHERE parent_id = ?').all('dup-A');
      expect(kids).toHaveLength(2);
      const names = kids.map(k => k.original_name).sort();
      expect(names).toEqual(['Annex1.pdf', 'Annex2.pdf']);
      // All cloned rows reuse the original disk filename
      expect(kids.every(k => k.filename.startsWith('shared/'))).toBe(true);
      // All cloned rows are marked is_duplicate=1
      expect(kids.every(k => k.is_duplicate === 1)).toBe(true);
    });

    it('is idempotent — running twice does not double-insert', () => {
      insertAtt('canon-B', { hash: 'hash-B', doc_identifier: 'CAS_YYY_00001_001' });
      insertAtt('kB', { hash: 'kB-hash', parent_id: 'canon-B', originalName: 'foo.pdf' });
      insertAtt('dup-B', { hash: 'hash-B', isDup: 1, doc_identifier: 'CAS_YYY_00002_001' });

      const r1 = replicateChildrenToDuplicates(db, INV);
      const r2 = replicateChildrenToDuplicates(db, INV);
      expect(r1.totalInserted).toBe(1);
      expect(r2.totalInserted).toBe(0);  // NOT EXISTS clause blocks re-insert
    });

    it('handles multi-level nesting via fixed-point iteration', () => {
      // canonical tree: dup-level parent → canonical attachment → nested child
      // After pass 1: dup gets the canonical attachment cloned as a dup
      // After pass 2: that cloned attachment needs its descendants (nested child) cloned
      insertAtt('canon-L1', { hash: 'L1', doc_identifier: 'CAS_N_00001_001' });
      insertAtt('canon-L2', { hash: 'L2', parent_id: 'canon-L1', originalName: 'Outer.pdf' });
      insertAtt('canon-L3', { hash: 'L3', parent_id: 'canon-L2', originalName: 'Inner.pdf' });
      insertAtt('dup-L1', { hash: 'L1', isDup: 1, doc_identifier: 'CAS_N_00002_001' });

      const res = replicateChildrenToDuplicates(db, INV);

      // Expected: 2 rows — one for Outer.pdf under dup-L1, then Inner.pdf under that clone
      expect(res.totalInserted).toBe(2);
      expect(res.passes).toBeGreaterThanOrEqual(2);

      // Verify the nested structure survived
      const outerClones = db.prepare("SELECT id FROM documents WHERE parent_id = ? AND original_name = 'Outer.pdf'").all('dup-L1');
      expect(outerClones).toHaveLength(1);
      const innerClones = db.prepare("SELECT id FROM documents WHERE parent_id = ? AND original_name = 'Inner.pdf'").all(outerClones[0].id);
      expect(innerClones).toHaveLength(1);
    });

    it('does not clone across investigations', () => {
      db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run('inv-other', 'Other', 'OTH');
      insertAtt('canon-X', { hash: 'hash-X' });
      insertAtt('kX', { hash: 'kX-h', parent_id: 'canon-X', originalName: 'x.pdf' });
      // Insert a duplicate in a DIFFERENT investigation
      db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, filename, mime_type, size_bytes, content_hash, is_duplicate, status)
        VALUES ('dup-other', 'inv-other', 'attachment', 'canon-X.pdf', 'shared/hash-X.pdf', 'application/pdf', 100, 'hash-X', 1, 'ready')
      `).run();

      const res = replicateChildrenToDuplicates(db, INV);
      expect(res.totalInserted).toBe(0);  // no duplicate in INV
      expect(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE parent_id = 'dup-other'").get().n).toBe(0);
    });

    it('handles a canonical with no children gracefully', () => {
      insertAtt('canon-empty', { hash: 'hash-empty' });
      insertAtt('dup-empty', { hash: 'hash-empty', isDup: 1 });

      const res = replicateChildrenToDuplicates(db, INV);
      expect(res.totalInserted).toBe(0);
    });

    it('returns zero when there are no duplicates at all', () => {
      insertAtt('only-canon', { hash: 'hh' });
      insertAtt('only-kid', { hash: 'kk', parent_id: 'only-canon' });

      const res = replicateChildrenToDuplicates(db, INV);
      expect(res.totalInserted).toBe(0);
    });

    it('skips cloning when target already has a child with matching content_hash + original_name (robust against partial prior runs)', () => {
      insertAtt('canon-P', { hash: 'hP' });
      insertAtt('kP', { hash: 'kPh', parent_id: 'canon-P', originalName: 'partial.pdf' });
      insertAtt('dup-P', { hash: 'hP', isDup: 1 });
      // Pre-insert a kid already under dup-P with same identity
      db.prepare(`
        INSERT INTO documents (id, investigation_id, doc_type, original_name, filename, mime_type, size_bytes, content_hash, is_duplicate, parent_id, status)
        VALUES ('pre-k', ?, 'attachment', 'partial.pdf', 'shared/kPh.pdf', 'application/pdf', 100, 'kPh', 1, 'dup-P', 'ready')
      `).run(INV);

      const res = replicateChildrenToDuplicates(db, INV);
      expect(res.totalInserted).toBe(0);
      const kids = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE parent_id = ?').get('dup-P').n;
      expect(kids).toBe(1);  // only the pre-existing one
    });

    it('derives doc_identifier from the duplicate parent', () => {
      insertAtt('canon-D', { hash: 'D', doc_identifier: 'CAS_XXX_00099_001' });
      insertAtt('kD', { hash: 'kDh', parent_id: 'canon-D', originalName: 'doc.pdf' });
      insertAtt('dup-D', { hash: 'D', isDup: 1, doc_identifier: 'CAS_XXX_00100_002' });

      replicateChildrenToDuplicates(db, INV);

      const clone = db.prepare('SELECT doc_identifier FROM documents WHERE parent_id = ?').get('dup-D');
      expect(clone.doc_identifier).toMatch(/^CAS_XXX_00100_002_\d{3}$/);
    });

    it('stops early when a pass inserts zero new rows', () => {
      // Canonical with 3 kids, two dups with no existing clones
      insertAtt('canon-Q', { hash: 'Q' });
      for (let i = 1; i <= 3; i++) insertAtt(`kq${i}`, { hash: `kqh${i}`, parent_id: 'canon-Q', originalName: `q${i}.pdf` });
      insertAtt('dup-Q1', { hash: 'Q', isDup: 1 });
      insertAtt('dup-Q2', { hash: 'Q', isDup: 1 });

      const res = replicateChildrenToDuplicates(db, INV);
      // Pass 1: 3+3 = 6 rows inserted (2 dups × 3 kids)
      // Pass 2: 0 rows (no new nesting) — stops
      expect(res.totalInserted).toBe(6);
      expect(res.passes).toBe(2);
      expect(res.perPass).toEqual([6, 0]);
    });
  });
});
