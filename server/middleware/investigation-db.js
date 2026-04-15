/**
 * Express middleware that resolves investigation_id from the request and
 * attaches per-investigation DB connections as req.invDb (write) and
 * req.invReadDb (read-only).
 *
 * Routes that operate on investigation-scoped data should use req.invDb/
 * req.invReadDb instead of the global db/readDb from server/db.js.
 */

import { getInvestigationDb } from '../lib/investigation-db.js';

export function withInvestigationDb(req, res, next) {
    const investigationId =
        req.query.investigation_id ||
        req.params.investigation_id ||
        req.params.id ||
        req.body?.investigation_id;

    if (!investigationId) {
        return next();
    }

    try {
        const { db, readDb } = getInvestigationDb(investigationId);
        req.invDb = db;
        req.invReadDb = readDb;
        req.investigationId = investigationId;
    } catch (err) {
        console.error(`✦ Failed to open investigation DB ${investigationId}:`, err.message);
        return res.status(500).json({ error: 'Failed to open investigation database' });
    }

    next();
}
