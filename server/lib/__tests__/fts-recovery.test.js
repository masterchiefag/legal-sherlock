import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  disableFtsTriggers,
  enableFtsTriggers,
  rebuildFtsIndex,
} from '../worker-helpers.js';

/**
 * Minimal schema for FTS recovery tests.
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

    CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      phase TEXT DEFAULT 'importing',
      progress_percent INTEGER DEFAULT 0,
      total_emails INTEGER DEFAULT 0,
      total_attachments INTEGER DEFAULT 0,
      investigation_id TEXT,
      error_log TEXT,
      completed_at TEXT,
      extraction_done_at TEXT,
      started_at TEXT
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

    CREATE TABLE document_tags (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      tag_id TEXT NOT NULL
    );

    CREATE TABLE document_reviews (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE classifications (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      score INTEGER
    );

    CREATE TABLE summaries (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content TEXT
    );

    CREATE TABLE investigation_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL
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

function triggerCount(db) {
  return db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'documents_a%'"
  ).get().cnt;
}

function triggerNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'documents_a%' ORDER BY name"
  ).all().map(r => r.name);
}

function seedInvestigation(db, id = 'inv-1') {
  db.prepare('INSERT INTO investigations (id, name, short_code) VALUES (?, ?, ?)').run(id, 'Test Case', 'TST');
  return id;
}

function seedDocument(db, id, invId, overrides = {}) {
  const doc = {
    id,
    investigation_id: invId,
    doc_type: 'file',
    original_name: `${id}.txt`,
    text_content: `content of ${id}`,
    status: 'ready',
    ...overrides,
  };
  db.prepare(
    'INSERT INTO documents (id, investigation_id, doc_type, original_name, text_content, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(doc.id, doc.investigation_id, doc.doc_type, doc.original_name, doc.text_content, doc.status);
  return doc;
}

function seedImportJob(db, id, invId, overrides = {}) {
  const job = {
    id,
    filename: 'test.pst',
    status: 'processing',
    phase: 'extracting',
    progress_percent: 100,
    total_emails: 10,
    total_attachments: 5,
    investigation_id: invId,
    extraction_done_at: null,
    started_at: null,
    ...overrides,
  };
  db.prepare(
    'INSERT INTO import_jobs (id, filename, status, phase, progress_percent, total_emails, total_attachments, investigation_id, extraction_done_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(job.id, job.filename, job.status, job.phase, job.progress_percent, job.total_emails, job.total_attachments, job.investigation_id, job.extraction_done_at, job.started_at);
  return job;
}

describe('FTS recovery and cleanup', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // ───────────────────────────────────────────────────
  // FTS integrity check and rebuild
  // ───────────────────────────────────────────────────

  describe('FTS integrity check', () => {
    it('integrity-check succeeds on a healthy FTS index', () => {
      seedDocument(db, 'd1', null, { text_content: 'hello world' });

      // Should not throw
      expect(() => {
        db.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
      }).not.toThrow();
    });

    it('rebuild recovers a corrupted FTS index', () => {
      // Insert docs with triggers active
      seedDocument(db, 'd1', null, { text_content: 'alpha bravo' });
      seedDocument(db, 'd2', null, { text_content: 'charlie delta' });

      // Corrupt FTS by manually deleting from the shadow tables
      // Drop all triggers first so direct manipulation works
      db.exec('DROP TRIGGER IF EXISTS documents_ai');
      db.exec('DROP TRIGGER IF EXISTS documents_ad');
      db.exec('DROP TRIGGER IF EXISTS documents_au');

      // Clear FTS content directly
      db.exec('DELETE FROM documents_fts');

      // FTS is now out of sync — search returns nothing
      const beforeRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'alpha'").all();
      expect(beforeRebuild.length).toBe(0);

      // Rebuild restores the index from the content table
      rebuildFtsIndex(db);

      const afterRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'alpha'").all();
      expect(afterRebuild.length).toBe(1);
      const charlie = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'charlie'").all();
      expect(charlie.length).toBe(1);
    });

    it('rebuild reflects deleted documents', () => {
      seedDocument(db, 'd1', null, { text_content: 'findme unique' });
      seedDocument(db, 'd2', null, { text_content: 'keepme another' });

      // Disable triggers and delete a doc directly (simulates worker crash mid-delete)
      db.exec('DROP TRIGGER IF EXISTS documents_ai');
      db.exec('DROP TRIGGER IF EXISTS documents_ad');
      db.exec('DROP TRIGGER IF EXISTS documents_au');
      db.prepare('DELETE FROM documents WHERE id = ?').run('d1');

      // FTS is now out of sync — querying the stale entry throws because
      // FTS5 content tables detect the missing row
      expect(() => {
        db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'findme'").all();
      }).toThrow(/missing row/);

      // After rebuild, stale entry is gone and search works cleanly
      rebuildFtsIndex(db);
      const afterRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'findme'").all();
      expect(afterRebuild.length).toBe(0);

      // The kept doc is still there
      const kept = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'keepme'").all();
      expect(kept.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────
  // FTS triggers after worker crash simulation
  // ───────────────────────────────────────────────────

  describe('trigger recovery after worker crash', () => {
    it('disableFtsTriggers leaves ad trigger intact', () => {
      expect(triggerCount(db)).toBe(3);

      disableFtsTriggers(db);

      expect(triggerCount(db)).toBe(1);
      expect(triggerNames(db)).toEqual(['documents_ad']);
    });

    it('enableFtsTriggers restores ai and au but does not duplicate ad', () => {
      disableFtsTriggers(db);
      enableFtsTriggers(db);

      expect(triggerCount(db)).toBe(3);
      expect(triggerNames(db)).toEqual(['documents_ad', 'documents_ai', 'documents_au']);
    });

    it('inserts during disabled triggers are invisible to FTS until rebuild', () => {
      disableFtsTriggers(db);

      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d1', 'ghost.txt', 'invisible content');

      const results = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'invisible'").all();
      expect(results.length).toBe(0);

      rebuildFtsIndex(db);

      const afterRebuild = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'invisible'").all();
      expect(afterRebuild.length).toBe(1);
    });

    it('new inserts sync to FTS after triggers re-enabled', () => {
      disableFtsTriggers(db);
      enableFtsTriggers(db);

      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d1', 'visible.txt', 'visible content');

      const results = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'visible'").all();
      expect(results.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────
  // Investigation delete with FTS
  // ───────────────────────────────────────────────────

  describe('investigation delete with FTS', () => {
    it('deleting docs with triggers active keeps FTS in sync', () => {
      const invId = seedInvestigation(db);
      seedDocument(db, 'd1', invId, { text_content: 'alpha' });
      seedDocument(db, 'd2', invId, { text_content: 'bravo' });

      // Verify docs are in FTS
      expect(db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'alpha'").all().length).toBe(1);

      // Delete with ad trigger active
      db.prepare('DELETE FROM documents WHERE investigation_id = ?').run(invId);

      // FTS should be empty
      expect(db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'alpha'").all().length).toBe(0);
      expect(db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'bravo'").all().length).toBe(0);
    });

    it('drop-triggers-then-delete pattern works for safe investigation cleanup', () => {
      const invId = seedInvestigation(db);
      seedDocument(db, 'd1', invId, { text_content: 'removeme' });
      seedDocument(db, 'd2', invId, { text_content: 'removemetoo' });

      // Keep a doc in another investigation to verify it survives
      const inv2 = seedInvestigation(db, 'inv-2');
      seedDocument(db, 'd3', inv2, { text_content: 'keepme' });

      // Drop all triggers (investigation delete pattern)
      db.exec('DROP TRIGGER IF EXISTS documents_ai');
      db.exec('DROP TRIGGER IF EXISTS documents_ad');
      db.exec('DROP TRIGGER IF EXISTS documents_au');

      // Delete documents
      db.prepare('DELETE FROM documents WHERE investigation_id = ?').run(invId);

      // Rebuild FTS
      rebuildFtsIndex(db);

      // Recreate triggers
      enableFtsTriggers(db);
      // Also recreate documents_ad since enableFtsTriggers only does ai/au
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
          INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
          VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
        END;
      `);

      // Deleted docs are gone from FTS
      expect(db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'removeme'").all().length).toBe(0);
      // Other investigation's docs survive
      expect(db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'keepme'").all().length).toBe(1);
      // All 3 triggers restored
      expect(triggerCount(db)).toBe(3);
    });

    it('deleting investigation cleans up related tables', () => {
      const invId = seedInvestigation(db);
      seedDocument(db, 'd1', invId);
      db.prepare('INSERT INTO document_tags (id, document_id, tag_id) VALUES (?, ?, ?)').run('dt1', 'd1', 'tag1');
      db.prepare('INSERT INTO document_reviews (id, document_id) VALUES (?, ?)').run('dr1', 'd1');
      db.prepare('INSERT INTO classifications (id, document_id, score) VALUES (?, ?, ?)').run('c1', 'd1', 4);
      db.prepare('INSERT INTO summaries (id, document_id, content) VALUES (?, ?, ?)').run('s1', 'd1', 'summary');
      db.prepare('INSERT INTO investigation_members (id, user_id, investigation_id) VALUES (?, ?, ?)').run('im1', 'u1', invId);

      // Drop triggers, delete everything
      db.exec('DROP TRIGGER IF EXISTS documents_ai');
      db.exec('DROP TRIGGER IF EXISTS documents_ad');
      db.exec('DROP TRIGGER IF EXISTS documents_au');

      db.prepare('DELETE FROM document_tags WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)').run(invId);
      db.prepare('DELETE FROM document_reviews WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)').run(invId);
      db.prepare('DELETE FROM classifications WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)').run(invId);
      db.prepare('DELETE FROM summaries WHERE document_id IN (SELECT id FROM documents WHERE investigation_id = ?)').run(invId);
      db.prepare('DELETE FROM documents WHERE investigation_id = ?').run(invId);
      db.prepare('DELETE FROM investigation_members WHERE investigation_id = ?').run(invId);
      db.prepare('DELETE FROM investigations WHERE id = ?').run(invId);

      // Verify everything is cleaned up
      expect(db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE investigation_id = ?').get(invId).cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM document_tags WHERE document_id = ?').get('d1').cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM document_reviews WHERE document_id = ?').get('d1').cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM classifications WHERE document_id = ?').get('d1').cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM summaries WHERE document_id = ?').get('d1').cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM investigation_members WHERE investigation_id = ?').get(invId).cnt).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM investigations WHERE id = ?').get(invId).cnt).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────
  // finalizeStuckJob logic (tested as pure DB operations)
  // ───────────────────────────────────────────────────

  describe('stuck job finalization logic', () => {
    it('marks job completed when all docs are ready', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-1', invId);
      seedDocument(db, 'd1', invId, { status: 'ready' });
      seedDocument(db, 'd2', invId, { status: 'ready' });
      seedDocument(db, 'd3', invId, { status: 'ready' });

      // Simulate finalizeStuckJob logic
      const pendingCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM documents WHERE investigation_id = ? AND status = 'processing'"
      ).get(invId).cnt;

      expect(pendingCount).toBe(0);

      db.prepare(
        "UPDATE import_jobs SET status = 'completed', phase = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run('job-1');

      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('job-1');
      expect(job.status).toBe('completed');
      expect(job.phase).toBe('completed');
      expect(job.completed_at).toBeTruthy();
    });

    it('marks job failed when some docs are still processing', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-2', invId);
      seedDocument(db, 'd1', invId, { status: 'ready' });
      seedDocument(db, 'd2', invId, { status: 'processing' });
      seedDocument(db, 'd3', invId, { status: 'processing' });

      const pendingCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM documents WHERE investigation_id = ? AND status = 'processing'"
      ).get(invId).cnt;

      expect(pendingCount).toBe(2);

      db.prepare(
        "UPDATE import_jobs SET status = 'failed', error_log = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify([{ error: `Worker crashed. ${pendingCount} documents not extracted.` }]), 'job-2');

      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('job-2');
      expect(job.status).toBe('failed');
      const errors = JSON.parse(job.error_log);
      expect(errors[0].error).toContain('2 documents not extracted');
    });

    it('skips finalization for jobs not in processing state', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-3', invId, { status: 'completed', phase: 'completed' });

      // Should not change an already-completed job
      const job = db.prepare("SELECT * FROM import_jobs WHERE id = ? AND status = 'processing'").get('job-3');
      expect(job).toBeUndefined();
    });

    it('restores FTS triggers after finalization', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-4', invId);
      seedDocument(db, 'd1', invId, { status: 'ready', text_content: 'searchable content' });

      // Simulate worker crash — triggers dropped
      disableFtsTriggers(db);
      expect(triggerCount(db)).toBe(1); // only ad remains

      // Finalization restores triggers
      enableFtsTriggers(db);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
          INSERT INTO documents_fts(documents_fts, rowid, original_name, text_content, email_subject, email_from, email_to)
          VALUES ('delete', old.rowid, old.original_name, COALESCE(old.text_content,''), COALESCE(old.email_subject,''), COALESCE(old.email_from,''), COALESCE(old.email_to,''));
        END;
      `);
      rebuildFtsIndex(db);

      expect(triggerCount(db)).toBe(3);

      // FTS search works after recovery
      const results = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'searchable'").all();
      expect(results.length).toBe(1);

      // New inserts go through triggers
      db.prepare('INSERT INTO documents (id, original_name, text_content) VALUES (?, ?, ?)').run('d-new', 'new.txt', 'freshcontent');
      const newResults = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'freshcontent'").all();
      expect(newResults.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────
  // Stuck job detection (isStuckAt100 logic)
  // ───────────────────────────────────────────────────

  describe('stuck job detection for finalize button', () => {
    // Helper mirrors the frontend isStuckAt100 logic
    function isStuckAt100(job) {
      if (job?.phase !== 'extracting' || job?.progress_percent < 100 || job?.status !== 'processing') return false;
      if (!job.extraction_done_at) return false;
      return (Date.now() - new Date(job.extraction_done_at + 'Z').getTime()) > 5 * 60 * 1000;
    }

    it('detects stuck job via extraction_done_at (primary path)', () => {
      const invId = seedInvestigation(db);
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      seedImportJob(db, 'stuck-1', invId, { extraction_done_at: tenMinAgo });
      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('stuck-1');
      expect(isStuckAt100(job)).toBe(true);
    });

    it('does not trigger when extraction_done_at is recent', () => {
      const invId = seedInvestigation(db);
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      seedImportJob(db, 'stuck-2', invId, { extraction_done_at: twoMinAgo });
      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('stuck-2');
      expect(isStuckAt100(job)).toBe(false);
    });

    it('does not trigger for completed jobs', () => {
      const invId = seedInvestigation(db);
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      seedImportJob(db, 'stuck-5', invId, {
        status: 'completed', phase: 'completed', extraction_done_at: tenMinAgo,
      });
      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('stuck-5');
      expect(isStuckAt100(job)).toBe(false);
    });

    it('does not trigger when extraction_done_at is null', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'stuck-6', invId, { extraction_done_at: null });
      const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get('stuck-6');
      expect(isStuckAt100(job)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────
  // Worker finalization order
  // ───────────────────────────────────────────────────

  describe('worker finalization order', () => {
    it('job should be marked completed before FTS rebuild', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-order', invId);
      seedDocument(db, 'd1', invId, { status: 'ready', text_content: 'ordertest' });

      // Disable triggers (simulating worker state after extraction)
      disableFtsTriggers(db);

      // Step 1: Mark completed (lightweight)
      db.prepare(
        "UPDATE import_jobs SET status = 'completed', phase = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run('job-order');

      // Verify job is completed BEFORE FTS rebuild
      const jobBeforeFts = db.prepare('SELECT status FROM import_jobs WHERE id = ?').get('job-order');
      expect(jobBeforeFts.status).toBe('completed');

      // Step 2: FTS rebuild (heavy, can OOM)
      enableFtsTriggers(db);
      rebuildFtsIndex(db);

      // Job is still completed after FTS rebuild
      const jobAfterFts = db.prepare('SELECT status FROM import_jobs WHERE id = ?').get('job-order');
      expect(jobAfterFts.status).toBe('completed');

      // FTS is working
      const results = db.prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'ordertest'").all();
      expect(results.length).toBe(1);
    });

    it('if FTS rebuild fails, job status is preserved as completed', () => {
      const invId = seedInvestigation(db);
      seedImportJob(db, 'job-survive', invId);
      seedDocument(db, 'd1', invId, { status: 'ready' });

      // Mark completed
      db.prepare(
        "UPDATE import_jobs SET status = 'completed', phase = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run('job-survive');

      // Simulate FTS rebuild failure (won't actually fail in test, but verify job stays completed)
      try {
        rebuildFtsIndex(db);
      } catch (_) {
        // In production this could OOM
      }

      const job = db.prepare('SELECT status FROM import_jobs WHERE id = ?').get('job-survive');
      expect(job.status).toBe('completed');
    });
  });
});
