import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock investigation-db module
let mockGetResult = null;
let mockGetError = null;
vi.mock('../../lib/investigation-db.js', () => ({
    getInvestigationDb: vi.fn((id) => {
        if (mockGetError) throw mockGetError;
        return mockGetResult || { db: {}, readDb: {} };
    }),
}));

const { withInvestigationDb } = await import('../investigation-db.js');

function mockReq(overrides = {}) {
    return {
        headers: {},
        params: {},
        query: {},
        body: {},
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

describe('withInvestigationDb middleware', () => {
    beforeEach(() => {
        mockGetResult = { db: { fake: 'writeDb' }, readDb: { fake: 'readDb' } };
        mockGetError = null;
    });

    it('returns 400 when no investigation_id is provided', () => {
        const req = mockReq();
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/investigation_id/i);
        expect(next).not.toHaveBeenCalled();
    });

    it('resolves investigation_id from query params', () => {
        const req = mockReq({ query: { investigation_id: 'inv-123' } });
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(req.invDb).toEqual({ fake: 'writeDb' });
        expect(req.invReadDb).toEqual({ fake: 'readDb' });
        expect(req.investigationId).toBe('inv-123');
        expect(next).toHaveBeenCalled();
    });

    it('resolves investigation_id from route params :id', () => {
        const req = mockReq({ params: { id: 'inv-456' } });
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(req.investigationId).toBe('inv-456');
        expect(next).toHaveBeenCalled();
    });

    it('resolves investigation_id from request body', () => {
        const req = mockReq({ body: { investigation_id: 'inv-789' } });
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(req.investigationId).toBe('inv-789');
        expect(next).toHaveBeenCalled();
    });

    it('returns 500 when getInvestigationDb throws', () => {
        mockGetError = new Error('DB file corrupted');
        const req = mockReq({ query: { investigation_id: 'inv-bad' } });
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toMatch(/Failed to open/);
        expect(next).not.toHaveBeenCalled();
    });

    it('prefers query param over body', () => {
        const req = mockReq({
            query: { investigation_id: 'from-query' },
            body: { investigation_id: 'from-body' },
        });
        const res = mockRes();
        const next = vi.fn();

        withInvestigationDb(req, res, next);

        expect(req.investigationId).toBe('from-query');
    });
});
