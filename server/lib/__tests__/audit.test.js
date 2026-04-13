import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../test-utils/test-db.js';
import { makeUser, insertRecord } from '../../test-utils/fixtures.js';
import { logAudit, ACTIONS } from '../audit.js';

describe('logAudit', () => {
  let db;
  let user;

  beforeEach(() => {
    db = createTestDb();
    user = makeUser({ id: 'user-1', role: 'admin' });
    insertRecord(db, 'users', user);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts an audit log row with all fields', () => {
    const id = logAudit(db, {
      userId: user.id,
      action: ACTIONS.DOC_UPLOAD,
      resourceType: 'document',
      resourceId: 'doc-1',
      details: { filename: 'test.pdf' },
      ipAddress: '127.0.0.1',
    });

    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
    expect(row).toBeDefined();
    expect(row.user_id).toBe('user-1');
    expect(row.action).toBe('document.upload');
    expect(row.resource_type).toBe('document');
    expect(row.resource_id).toBe('doc-1');
    expect(JSON.parse(row.details)).toEqual({ filename: 'test.pdf' });
    expect(row.ip_address).toBe('127.0.0.1');
  });

  it('handles null optional fields', () => {
    const id = logAudit(db, {
      userId: user.id,
      action: ACTIONS.AUTH_LOGIN,
    });

    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
    expect(row.resource_type).toBeNull();
    expect(row.resource_id).toBeNull();
    expect(row.details).toBeNull();
    expect(row.ip_address).toBeNull();
  });

  it('returns the generated ID', () => {
    const id = logAudit(db, {
      userId: user.id,
      action: ACTIONS.AUTH_LOGIN,
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('ACTIONS constants', () => {
  it('has expected action keys', () => {
    expect(ACTIONS.AUTH_LOGIN).toBe('auth.login');
    expect(ACTIONS.DOC_UPLOAD).toBe('document.upload');
    expect(ACTIONS.REVIEW_UPDATE).toBe('review.update');
    expect(ACTIONS.INVESTIGATION_CREATE).toBe('investigation.create');
    expect(ACTIONS.TAG_CREATE).toBe('tag.create');
    expect(ACTIONS.BATCH_CREATE).toBe('batch.create');
  });
});
