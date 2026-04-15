import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import mainDb from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const router = express.Router();

// List all tags
// tags table lives in mainDb; document_tags lives in per-investigation DB
router.get('/', (req, res) => {
    try {
        const tags = mainDb.prepare('SELECT * FROM tags ORDER BY name').all();

        // If an investigation DB is available, get per-tag doc counts from it
        if (req.invReadDb) {
            const counts = req.invReadDb.prepare(
                'SELECT tag_id, COUNT(*) as doc_count FROM document_tags GROUP BY tag_id'
            ).all();
            const countMap = new Map(counts.map(r => [r.tag_id, r.doc_count]));
            for (const tag of tags) {
                tag.doc_count = countMap.get(tag.id) || 0;
            }
        } else {
            for (const tag of tags) {
                tag.doc_count = 0;
            }
        }

        res.json(tags);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a tag — reviewer+
// tags table is in mainDb (global across investigations)
router.post('/', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { name, color = '#3b82f6' } = req.body;
        if (!name) return res.status(400).json({ error: 'Tag name is required' });

        const id = uuidv4();
        mainDb.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, name, color);
        console.log(`[tags] created tag "${name}" (${color}) by ${req.user.email}`);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.TAG_CREATE,
            resourceType: 'tag',
            resourceId: id,
            details: { name, color },
            ipAddress: req.ip,
        });

        const tag = mainDb.prepare('SELECT * FROM tags WHERE id = ?').get(id);
        res.status(201).json(tag);
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Tag already exists' });
        }
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update a tag — reviewer+
// Updates tags table in mainDb, then syncs denormalized tag_name/tag_color
// in the current investigation's document_tags.
router.put('/:id', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { name, color } = req.body;
        const updates = [];
        const params = [];

        if (name) { updates.push('name = ?'); params.push(name); }
        if (color) { updates.push('color = ?'); params.push(color); }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        params.push(req.params.id);
        mainDb.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        const tag = mainDb.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
        if (!tag) return res.status(404).json({ error: 'Tag not found' });

        console.log(`[tags] updated tag ${req.params.id.substring(0, 8)}...: name=${name || '(unchanged)'}, color=${color || '(unchanged)'}`);
        // Sync denormalized columns in the current investigation's document_tags
        // TODO: For complete sync, fan out across ALL investigation DBs
        if (req.invDb) {
            const dtUpdates = [];
            const dtParams = [];
            if (name) { dtUpdates.push('tag_name = ?'); dtParams.push(name); }
            if (color) { dtUpdates.push('tag_color = ?'); dtParams.push(color); }
            dtParams.push(req.params.id);
            req.invDb.prepare(`UPDATE document_tags SET ${dtUpdates.join(', ')} WHERE tag_id = ?`).run(...dtParams);
        }

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.TAG_UPDATE,
            resourceType: 'tag',
            resourceId: req.params.id,
            details: { name, color },
            ipAddress: req.ip,
        });

        res.json(tag);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete a tag — admin only
// Deletes from mainDb tags table, and cleans up document_tags in the
// current investigation DB if available.
router.delete('/:id', requireRole('admin'), (req, res) => {
    try {
        const result = mainDb.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Tag not found' });
        console.log(`[tags] deleted tag ${req.params.id.substring(0, 8)}... by ${req.user.email}`);

        // Clean up document_tags in the current investigation DB
        // TODO: For complete cleanup, fan out across ALL investigation DBs
        if (req.invDb) {
            req.invDb.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(req.params.id);
        }

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.TAG_DELETE,
            resourceType: 'tag',
            resourceId: req.params.id,
            ipAddress: req.ip,
        });

        res.json({ deleted: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Assign tag to document — reviewer+
// Verify tag exists in mainDb, then write to document_tags in investigation DB
// with denormalized tag_name and tag_color
router.post('/documents/:docId/tags', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

        // Look up tag in mainDb to verify it exists and get denormalized values
        const tag = mainDb.prepare('SELECT * FROM tags WHERE id = ?').get(tag_id);
        if (!tag) return res.status(404).json({ error: 'Tag not found' });

        if (!req.invDb) return res.status(400).json({ error: 'investigation_id is required' });

        req.invDb.prepare(
            'INSERT OR IGNORE INTO document_tags (document_id, tag_id, tag_name, tag_color) VALUES (?, ?, ?, ?)'
        ).run(req.params.docId, tag_id, tag.name, tag.color);
        console.log(`[tags] assigned "${tag.name}" to doc ${req.params.docId.substring(0, 8)}... by ${req.user.email}`);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.TAG_ASSIGN,
            resourceType: 'document',
            resourceId: req.params.docId,
            details: { tag_id, tag_name: tag.name },
            ipAddress: req.ip,
        });

        res.status(201).json({ assigned: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Remove tag from document — reviewer+
router.delete('/documents/:docId/tags/:tagId', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        if (!req.invDb) return res.status(400).json({ error: 'investigation_id is required' });

        req.invDb.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run(req.params.docId, req.params.tagId);
        console.log(`[tags] unassigned tag ${req.params.tagId.substring(0, 8)}... from doc ${req.params.docId.substring(0, 8)}... by ${req.user.email}`);

        logAudit(mainDb, {
            userId: req.user.id,
            action: ACTIONS.TAG_UNASSIGN,
            resourceType: 'document',
            resourceId: req.params.docId,
            details: { tag_id: req.params.tagId },
            ipAddress: req.ip,
        });

        res.json({ removed: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
