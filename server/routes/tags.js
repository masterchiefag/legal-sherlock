import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';

const router = express.Router();

// List all tags
router.get('/', (req, res) => {
    try {
        const tags = db.prepare(`
      SELECT t.*, COUNT(dt.document_id) as doc_count
      FROM tags t
      LEFT JOIN document_tags dt ON dt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name
    `).all();
        res.json(tags);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a tag — reviewer+
router.post('/', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { name, color = '#3b82f6' } = req.body;
        if (!name) return res.status(400).json({ error: 'Tag name is required' });

        const id = uuidv4();
        db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, name, color);

        const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
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
router.put('/:id', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { name, color } = req.body;
        const updates = [];
        const params = [];

        if (name) { updates.push('name = ?'); params.push(name); }
        if (color) { updates.push('color = ?'); params.push(color); }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        params.push(req.params.id);
        db.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
        if (!tag) return res.status(404).json({ error: 'Tag not found' });
        res.json(tag);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete a tag — admin only
router.delete('/:id', requireRole('admin'), (req, res) => {
    try {
        const result = db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Tag not found' });
        res.json({ deleted: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Assign tag to document — reviewer+
router.post('/documents/:docId/tags', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

        db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(req.params.docId, tag_id);
        res.status(201).json({ assigned: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Remove tag from document — reviewer+
router.delete('/documents/:docId/tags/:tagId', requireRole('admin', 'reviewer'), (req, res) => {
    try {
        db.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run(req.params.docId, req.params.tagId);
        res.json({ removed: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
