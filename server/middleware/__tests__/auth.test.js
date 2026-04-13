import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/test-db.js';
import { makeUser, makeInvestigation, makeMembership, insertRecord } from '../../test-utils/fixtures.js';
import { generateToken } from '../../lib/auth.js';

// Mock the db module to use our test database
let testDb;
vi.mock('../../db.js', () => {
  return {
    default: {
      prepare: (...args) => testDb.prepare(...args),
    },
  };
});

// Import after mocking
const { authenticate, requireAuth, requireRole, requireInvestigationAccess } = await import('../auth.js');

function mockReq(overrides = {}) {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    user: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
  };
  return res;
}

describe('authenticate', () => {
  let admin;

  beforeEach(() => {
    testDb = createTestDb();
    admin = makeUser({ role: 'admin' });
    insertRecord(testDb, 'users', admin);
  });

  it('sets req.user = null when no auth header', () => {
    const req = mockReq();
    const next = vi.fn();
    authenticate(req, {}, next);
    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('sets req.user = null for invalid Bearer token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer invalid.token' } });
    const next = vi.fn();
    authenticate(req, {}, next);
    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('populates req.user from valid token', () => {
    const token = generateToken(admin);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();
    authenticate(req, {}, next);
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe(admin.id);
    expect(req.user.email).toBe(admin.email);
    expect(req.user.role).toBe('admin');
    expect(next).toHaveBeenCalled();
  });

  it('sets null for deactivated user', () => {
    const inactive = makeUser({ is_active: 0 });
    insertRecord(testDb, 'users', inactive);
    const token = generateToken(inactive);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();
    authenticate(req, {}, next);
    expect(req.user).toBeNull();
  });

  it('sets null for non-Bearer authorization', () => {
    const req = mockReq({ headers: { authorization: 'Basic abc123' } });
    const next = vi.fn();
    authenticate(req, {}, next);
    expect(req.user).toBeNull();
  });
});

describe('requireAuth', () => {
  it('returns 401 when no user', () => {
    const req = mockReq({ user: null });
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when user exists', () => {
    const req = mockReq({ user: { id: 'u1', role: 'admin' } });
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  it('returns 401 when no user', () => {
    const middleware = requireRole('admin');
    const req = mockReq({ user: null });
    const res = mockRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for wrong role', () => {
    const middleware = requireRole('admin');
    const req = mockReq({ user: { id: 'u1', role: 'viewer' } });
    const res = mockRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('passes for correct role', () => {
    const middleware = requireRole('admin', 'reviewer');
    const req = mockReq({ user: { id: 'u1', role: 'reviewer' } });
    const res = mockRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireInvestigationAccess', () => {
  let admin, reviewer, investigation;

  beforeEach(() => {
    testDb = createTestDb();
    admin = makeUser({ role: 'admin' });
    reviewer = makeUser({ role: 'reviewer' });
    investigation = makeInvestigation();
    insertRecord(testDb, 'users', admin);
    insertRecord(testDb, 'users', reviewer);
    insertRecord(testDb, 'investigations', investigation);
  });

  it('returns 401 when no user', () => {
    const req = mockReq({ user: null });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('admin bypasses membership check', () => {
    const req = mockReq({
      user: { id: admin.id, role: 'admin' },
      params: { id: investigation.id },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.investigationRole).toBe('admin');
  });

  it('non-admin without membership gets 403', () => {
    const req = mockReq({
      user: { id: reviewer.id, role: 'reviewer' },
      params: { id: investigation.id },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('non-admin with membership passes', () => {
    const membership = makeMembership({
      investigation_id: investigation.id,
      user_id: reviewer.id,
    });
    insertRecord(testDb, 'investigation_members', membership);

    const req = mockReq({
      user: { id: reviewer.id, role: 'reviewer' },
      params: { id: investigation.id },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.investigationRole).toBe('reviewer');
  });

  it('uses role_override when set', () => {
    const membership = makeMembership({
      investigation_id: investigation.id,
      user_id: reviewer.id,
      role_override: 'admin',
    });
    insertRecord(testDb, 'investigation_members', membership);

    const req = mockReq({
      user: { id: reviewer.id, role: 'reviewer' },
      params: { id: investigation.id },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(req.investigationRole).toBe('admin');
  });

  it('extracts investigation_id from query when not in params', () => {
    const membership = makeMembership({
      investigation_id: investigation.id,
      user_id: reviewer.id,
    });
    insertRecord(testDb, 'investigation_members', membership);

    const req = mockReq({
      user: { id: reviewer.id, role: 'reviewer' },
      query: { investigation_id: investigation.id },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes with default role when no investigation context', () => {
    const req = mockReq({
      user: { id: reviewer.id, role: 'reviewer' },
    });
    const res = mockRes();
    const next = vi.fn();
    requireInvestigationAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.investigationRole).toBe('reviewer');
  });
});
