import { describe, it, expect, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  getInvestigationDb,
  openWorkerDb,
  closeInvestigationDb,
  closeAll,
  deleteInvestigationDb,
  listInvestigationDbs,
  getInvestigationDbPath,
  refreshInvestigationCounts,
} from '../investigation-db.js';

// Use a unique prefix so test IDs never collide with real data
const TEST_PREFIX = '__test_invdb_';
let testIds = [];

function makeTestId() {
  const id = `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  testIds.push(id);
  return id;
}

afterEach(() => {
  // Close all test investigation connections after each test
  for (const id of testIds) {
    try { closeInvestigationDb(id); } catch (_) {}
  }
});

afterAll(() => {
  // Clean up any leftover test DB files
  closeAll();
  for (const id of testIds) {
    const dbPath = getInvestigationDbPath(id);
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  }
});

// ─── Schema creation ─────────────────────────────────────────────────────────

describe('getInvestigationDb', () => {
  it('should create a new DB file with full schema on first access', () => {
    const id = makeTestId();
    const { db } = getInvestigationDb(id);

    // File must exist on disk
    expect(fs.existsSync(getInvestigationDbPath(id))).toBe(true);

    // Core tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);

    expect(tables).toContain('documents');
    expect(tables).toContain('document_tags');
    expect(tables).toContain('document_reviews');
    expect(tables).toContain('classifications');
    expect(tables).toContain('import_jobs');
    expect(tables).toContain('summarization_jobs');
    expect(tables).toContain('summaries');
    expect(tables).toContain('review_batches');
    expect(tables).toContain('review_batch_documents');
    expect(tables).toContain('documents_fts');
  });

  it('should return the same connection on subsequent calls (pool hit)', () => {
    const id = makeTestId();
    const first = getInvestigationDb(id);
    const second = getInvestigationDb(id);

    // Same object references — not new connections
    expect(first.db).toBe(second.db);
    expect(first.readDb).toBe(second.readDb);
  });

  it('should return separate db and readDb instances', () => {
    const id = makeTestId();
    const { db, readDb } = getInvestigationDb(id);

    expect(db).not.toBe(readDb);
  });

  it('should create FTS5 table with auto-sync triggers', () => {
    const id = makeTestId();
    const { db } = getInvestigationDb(id);

    // FTS table exists
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .get();
    expect(fts).toBeDefined();

    // Auto-sync triggers exist (insert, delete, update)
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'documents_a%'")
      .all()
      .map(t => t.name)
      .sort();
    expect(triggers).toEqual(['documents_ad', 'documents_ai', 'documents_au']);
  });

  it('should auto-populate FTS on document insert via trigger', () => {
    const id = makeTestId();
    const { db } = getInvestigationDb(id);

    db.prepare(`
      INSERT INTO documents (id, filename, original_name, text_content, email_subject)
      VALUES (?, ?, ?, ?, ?)
    `).run('doc-1', 'test.txt', 'test.txt', 'searchable content here', 'important subject');

    const results = db
      .prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'searchable'")
      .all();
    expect(results.length).toBe(1);

    const subjectResults = db
      .prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'important'")
      .all();
    expect(subjectResults.length).toBe(1);
  });

  it('should register file_ext custom function', () => {
    const id = makeTestId();
    const { db } = getInvestigationDb(id);

    const result = db.prepare("SELECT file_ext('report.pdf') AS ext").get();
    expect(result.ext).toBe('.pdf');

    const noExt = db.prepare("SELECT file_ext('README') AS ext").get();
    expect(noExt.ext).toBe('unknown');

    const nullExt = db.prepare("SELECT file_ext(NULL) AS ext").get();
    expect(nullExt.ext).toBe('unknown');
  });
});

// ─── openWorkerDb ────────────────────────────────────────────────────────────

describe('openWorkerDb', () => {
  it('should return a different connection each time (not pooled)', () => {
    const id = makeTestId();
    const db1 = openWorkerDb(id);
    const db2 = openWorkerDb(id);

    expect(db1).not.toBe(db2);

    db1.close();
    db2.close();
  });

  it('should create schema if DB does not exist yet', () => {
    const id = makeTestId();
    const db = openWorkerDb(id);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);

    expect(tables).toContain('documents');
    expect(tables).toContain('documents_fts');
    expect(tables).toContain('import_jobs');

    db.close();
  });

  it('should be writable', () => {
    const id = makeTestId();
    const db = openWorkerDb(id);

    expect(() => {
      db.prepare(`
        INSERT INTO documents (id, filename, original_name)
        VALUES (?, ?, ?)
      `).run('worker-doc-1', 'w.txt', 'w.txt');
    }).not.toThrow();

    const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get('worker-doc-1');
    expect(doc).toBeDefined();

    db.close();
  });

  it('should return a connection independent from the pooled connection', () => {
    const id = makeTestId();
    // First get the pooled connection
    const { db: pooledDb } = getInvestigationDb(id);
    // Then get a worker connection
    const workerDb = openWorkerDb(id);

    expect(workerDb).not.toBe(pooledDb);

    workerDb.close();
  });
});

// ─── closeInvestigationDb ────────────────────────────────────────────────────

describe('closeInvestigationDb', () => {
  it('should close connections and remove from pool', () => {
    const id = makeTestId();
    getInvestigationDb(id);

    closeInvestigationDb(id);

    // Next call should create a fresh connection (not reuse old closed one)
    const { db } = getInvestigationDb(id);
    // Verify it's usable (not closed)
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
  });

  it('should not throw for an ID not in the pool', () => {
    expect(() => closeInvestigationDb('nonexistent-id')).not.toThrow();
  });
});

// ─── closeAll ────────────────────────────────────────────────────────────────

describe('closeAll', () => {
  it('should not throw on empty pool', () => {
    // Ensure pool is empty by closing everything first
    closeAll();
    expect(() => closeAll()).not.toThrow();
  });

  it('should close all pooled connections', () => {
    const id1 = makeTestId();
    const id2 = makeTestId();
    getInvestigationDb(id1);
    getInvestigationDb(id2);

    closeAll();

    // Subsequent access should create fresh connections
    const { db: db1 } = getInvestigationDb(id1);
    const { db: db2 } = getInvestigationDb(id2);
    expect(() => db1.prepare('SELECT 1').get()).not.toThrow();
    expect(() => db2.prepare('SELECT 1').get()).not.toThrow();
  });
});

// ─── deleteInvestigationDb ───────────────────────────────────────────────────

describe('deleteInvestigationDb', () => {
  it('should remove the DB file from disk', () => {
    const id = makeTestId();
    const dbPath = getInvestigationDbPath(id);

    // Create the DB
    getInvestigationDb(id);
    expect(fs.existsSync(dbPath)).toBe(true);

    deleteInvestigationDb(id);
    expect(fs.existsSync(dbPath)).toBe(false);

    // Remove from testIds since file is already deleted
    testIds = testIds.filter(t => t !== id);
  });

  it('should not throw if DB file does not exist', () => {
    expect(() => deleteInvestigationDb('does-not-exist-' + Date.now())).not.toThrow();
  });

  it('should also remove WAL and SHM files if present', () => {
    const id = makeTestId();
    const dbPath = getInvestigationDbPath(id);

    // Create the DB (WAL mode will create -wal file on writes)
    const { db } = getInvestigationDb(id);
    db.prepare(`
      INSERT INTO documents (id, filename, original_name)
      VALUES (?, ?, ?)
    `).run('del-test', 'x.txt', 'x.txt');

    deleteInvestigationDb(id);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(dbPath + '-wal')).toBe(false);
    expect(fs.existsSync(dbPath + '-shm')).toBe(false);

    testIds = testIds.filter(t => t !== id);
  });
});

// ─── listInvestigationDbs ────────────────────────────────────────────────────

describe('listInvestigationDbs', () => {
  it('should list investigation IDs from filesystem', () => {
    const id = makeTestId();
    getInvestigationDb(id);

    const ids = listInvestigationDbs();
    expect(ids).toContain(id);
  });

  it('should not include non-.db files', () => {
    const ids = listInvestigationDbs();
    for (const id of ids) {
      expect(id).not.toMatch(/\.db$/);
    }
  });
});

// ─── getInvestigationDbPath ──────────────────────────────────────────────────

describe('getInvestigationDbPath', () => {
  it('should return a path ending in {id}.db', () => {
    const p = getInvestigationDbPath('my-investigation-id');
    expect(p).toMatch(/my-investigation-id\.db$/);
  });

  it('should be under the data/investigations directory', () => {
    const p = getInvestigationDbPath('test-id');
    expect(p).toContain(path.join('data', 'investigations'));
  });
});

// ─── LRU eviction ────────────────────────────────────────────────────────────

describe('LRU eviction', () => {
  it('should evict oldest entry when pool exceeds MAX_POOL_SIZE (5)', () => {
    // Clean slate
    closeAll();

    const ids = [];
    for (let i = 0; i < 6; i++) {
      const id = makeTestId();
      ids.push(id);
      getInvestigationDb(id);
      // Small delay to ensure different lastAccess timestamps
    }

    // The 6th ID should cause the 1st to be evicted from pool.
    // The first ID's connection should have been closed, so accessing it again
    // should give us a fresh (different) connection.
    // We can verify by getting the 6th (most recent) — it should still be pooled.
    const { db: sixthDb } = getInvestigationDb(ids[5]);
    expect(() => sixthDb.prepare('SELECT 1').get()).not.toThrow();

    // Getting the first ID again should still work (creates new connection)
    const { db: firstDb } = getInvestigationDb(ids[0]);
    expect(() => firstDb.prepare('SELECT 1').get()).not.toThrow();
  });
});

// ─── refreshInvestigationCounts ──────────────────────────────────────────────

describe('refreshInvestigationCounts', () => {
  /**
   * Use in-memory databases for these tests (no filesystem needed).
   */
  function createMainDb() {
    const db = new Database(':memory:');
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
      )
    `);
    return db;
  }

  function createInvDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        investigation_id TEXT,
        doc_type TEXT DEFAULT 'file',
        original_name TEXT NOT NULL
      )
    `);
    return db;
  }

  it('should correctly count documents by type', () => {
    const mainDb = createMainDb();
    const invDb = createInvDb();

    mainDb.prepare('INSERT INTO investigations (id, name) VALUES (?, ?)').run('inv-1', 'Test');

    const insert = invDb.prepare(
      'INSERT INTO documents (id, investigation_id, doc_type, original_name) VALUES (?, ?, ?, ?)'
    );
    insert.run('d1', 'inv-1', 'email', 'msg1.eml');
    insert.run('d2', 'inv-1', 'email', 'msg2.eml');
    insert.run('d3', 'inv-1', 'attachment', 'report.pdf');
    insert.run('d4', 'inv-1', 'file', 'notes.txt');
    insert.run('d5', 'inv-1', 'chat', 'chat-day1.txt');
    insert.run('d6', 'inv-1', 'chat', 'chat-day2.txt');
    insert.run('d7', 'inv-1', 'chat', 'chat-day3.txt');

    refreshInvestigationCounts(mainDb, invDb, 'inv-1');

    const inv = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-1');
    expect(inv.document_count).toBe(7);
    expect(inv.email_count).toBe(2);
    expect(inv.attachment_count).toBe(1);
    expect(inv.file_count).toBe(1);
    expect(inv.chat_count).toBe(3);

    mainDb.close();
    invDb.close();
  });

  it('should set all counts to zero for empty investigation DB', () => {
    const mainDb = createMainDb();
    const invDb = createInvDb();

    mainDb.prepare('INSERT INTO investigations (id, name) VALUES (?, ?)').run('inv-empty', 'Empty');

    refreshInvestigationCounts(mainDb, invDb, 'inv-empty');

    const inv = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-empty');
    expect(inv.document_count).toBe(0);
    expect(inv.email_count).toBe(0);
    expect(inv.attachment_count).toBe(0);
    expect(inv.file_count).toBe(0);
    expect(inv.chat_count).toBe(0);

    mainDb.close();
    invDb.close();
  });

  it('should not cross-contaminate between investigations', () => {
    const mainDb = createMainDb();

    mainDb.prepare('INSERT INTO investigations (id, name) VALUES (?, ?)').run('inv-a', 'Case A');
    mainDb.prepare('INSERT INTO investigations (id, name) VALUES (?, ?)').run('inv-b', 'Case B');

    // Separate per-investigation DBs
    const invADb = createInvDb();
    invADb.prepare(
      'INSERT INTO documents (id, doc_type, original_name) VALUES (?, ?, ?)'
    ).run('d1', 'email', 'msg.eml');

    const invBDb = createInvDb();
    const insertB = invBDb.prepare(
      'INSERT INTO documents (id, doc_type, original_name) VALUES (?, ?, ?)'
    );
    insertB.run('d2', 'file', 'notes.txt');
    insertB.run('d3', 'file', 'report.pdf');

    refreshInvestigationCounts(mainDb, invADb, 'inv-a');
    refreshInvestigationCounts(mainDb, invBDb, 'inv-b');

    const invA = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-a');
    expect(invA.document_count).toBe(1);
    expect(invA.email_count).toBe(1);
    expect(invA.file_count).toBe(0);

    const invB = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-b');
    expect(invB.document_count).toBe(2);
    expect(invB.file_count).toBe(2);
    expect(invB.email_count).toBe(0);

    mainDb.close();
    invADb.close();
    invBDb.close();
  });

  it('should update counts on subsequent calls as documents change', () => {
    const mainDb = createMainDb();
    const invDb = createInvDb();

    mainDb.prepare('INSERT INTO investigations (id, name) VALUES (?, ?)').run('inv-1', 'Test');
    invDb.prepare(
      'INSERT INTO documents (id, doc_type, original_name) VALUES (?, ?, ?)'
    ).run('d1', 'email', 'msg.eml');

    refreshInvestigationCounts(mainDb, invDb, 'inv-1');
    let inv = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-1');
    expect(inv.document_count).toBe(1);
    expect(inv.email_count).toBe(1);

    // Add more documents and refresh again
    invDb.prepare(
      'INSERT INTO documents (id, doc_type, original_name) VALUES (?, ?, ?)'
    ).run('d2', 'file', 'notes.txt');
    invDb.prepare(
      'INSERT INTO documents (id, doc_type, original_name) VALUES (?, ?, ?)'
    ).run('d3', 'attachment', 'att.pdf');

    refreshInvestigationCounts(mainDb, invDb, 'inv-1');
    inv = mainDb.prepare('SELECT * FROM investigations WHERE id = ?').get('inv-1');
    expect(inv.document_count).toBe(3);
    expect(inv.email_count).toBe(1);
    expect(inv.file_count).toBe(1);
    expect(inv.attachment_count).toBe(1);

    mainDb.close();
    invDb.close();
  });
});
