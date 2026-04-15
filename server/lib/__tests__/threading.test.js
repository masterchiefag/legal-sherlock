import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/test-db.js';
import { makeDocument, makeInvestigation, insertRecord } from '../../test-utils/fixtures.js';

let testDb;

const { resolveThreadId, backfillThread } = await import('../threading.js');

describe('resolveThreadId', () => {
  let investigation;

  beforeEach(() => {
    testDb = createTestDb();
    investigation = makeInvestigation();
    insertRecord(testDb, 'investigations', investigation);
  });

  it('returns new UUID when no references exist', () => {
    const threadId = resolveThreadId(testDb, null, null, null);
    expect(threadId).toBeDefined();
    expect(typeof threadId).toBe('string');
    expect(threadId.length).toBe(36); // UUID format
  });

  it('finds thread via inReplyTo', () => {
    const parent = makeDocument({
      doc_type: 'email',
      message_id: 'parent@example.com',
      thread_id: 'thread-1',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', parent);

    const threadId = resolveThreadId(testDb, 'child@example.com', 'parent@example.com', null);
    expect(threadId).toBe('thread-1');
  });

  it('finds thread via references header (walks backwards)', () => {
    const ancestor = makeDocument({
      doc_type: 'email',
      message_id: 'ancestor@example.com',
      thread_id: 'thread-A',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', ancestor);

    // References has multiple IDs, ancestor is last (most recent in reverse walk)
    const threadId = resolveThreadId(
      testDb,
      'new@example.com',
      null,
      'unknown@example.com ancestor@example.com'
    );
    expect(threadId).toBe('thread-A');
  });

  it('handles late arrival — existing email references our message_id', () => {
    // A child email arrived first
    const child = makeDocument({
      doc_type: 'email',
      message_id: 'child@example.com',
      in_reply_to: 'late-parent@example.com',
      thread_id: 'thread-child',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', child);

    // Now the parent arrives late
    const threadId = resolveThreadId(testDb, 'late-parent@example.com', null, null);
    expect(threadId).toBe('thread-child');
  });

  it('prefers inReplyTo over references', () => {
    const parent = makeDocument({
      doc_type: 'email',
      message_id: 'direct-parent@example.com',
      thread_id: 'thread-direct',
      investigation_id: investigation.id,
    });
    const ancestor = makeDocument({
      doc_type: 'email',
      message_id: 'ancestor@example.com',
      thread_id: 'thread-ancestor',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', parent);
    insertRecord(testDb, 'documents', ancestor);

    const threadId = resolveThreadId(
      testDb,
      'new@example.com',
      'direct-parent@example.com',
      'ancestor@example.com'
    );
    expect(threadId).toBe('thread-direct');
  });
});

describe('backfillThread', () => {
  let investigation;

  beforeEach(() => {
    testDb = createTestDb();
    investigation = makeInvestigation();
    insertRecord(testDb, 'investigations', investigation);
  });

  it('does nothing when no messageId or references', () => {
    backfillThread(testDb, 'thread-1', null, null);
    // Just shouldn't throw
  });

  it('unifies orphan emails that reference the same message_id', () => {
    // Orphan 1: references our message-id but has a different thread
    const orphan = makeDocument({
      doc_type: 'email',
      message_id: 'orphan@example.com',
      in_reply_to: 'parent@example.com',
      thread_id: 'orphan-thread',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', orphan);

    // Backfill should unify orphan under our thread
    backfillThread(testDb, 'correct-thread', 'parent@example.com', null);

    const updated = testDb.prepare('SELECT thread_id FROM documents WHERE id = ?').get(orphan.id);
    expect(updated.thread_id).toBe('correct-thread');
  });

  it('unifies all emails in an orphan thread', () => {
    // Two emails in the same orphan thread
    const orphan1 = makeDocument({
      doc_type: 'email',
      message_id: 'o1@example.com',
      in_reply_to: 'parent@example.com',
      thread_id: 'orphan-thread',
      investigation_id: investigation.id,
    });
    const orphan2 = makeDocument({
      doc_type: 'email',
      message_id: 'o2@example.com',
      in_reply_to: 'o1@example.com',
      thread_id: 'orphan-thread',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', orphan1);
    insertRecord(testDb, 'documents', orphan2);

    backfillThread(testDb, 'correct-thread', 'parent@example.com', null);

    const all = testDb.prepare('SELECT thread_id FROM documents').all();
    expect(all.every(d => d.thread_id === 'correct-thread')).toBe(true);
  });

  it('handles references in backfill', () => {
    const orphan = makeDocument({
      doc_type: 'email',
      message_id: 'orphan@example.com',
      email_references: 'ref-id@example.com',
      thread_id: 'old-thread',
      investigation_id: investigation.id,
    });
    insertRecord(testDb, 'documents', orphan);

    backfillThread(testDb, 'new-thread', null, 'ref-id@example.com other@example.com');

    const updated = testDb.prepare('SELECT thread_id FROM documents WHERE id = ?').get(orphan.id);
    expect(updated.thread_id).toBe('new-thread');
  });
});
