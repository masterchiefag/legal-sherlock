import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

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
        res.status(500).json({ error: err.message });
    }
});

// Create a tag
router.post('/', (req, res) => {
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
        res.status(500).json({ error: err.message });
    }
});

// Update a tag
router.put('/:id', (req, res) => {
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
        res.status(500).json({ error: err.message });
    }
});

// Delete a tag
router.delete('/:id', (req, res) => {
    try {
        const result = db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Tag not found' });
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Assign tag to document
router.post('/documents/:docId/tags', (req, res) => {
    try {
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

        db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(req.params.docId, tag_id);
        res.status(201).json({ assigned: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove tag from document
router.delete('/documents/:docId/tags/:tagId', (req, res) => {
    try {
        db.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run(req.params.docId, req.params.tagId);
        res.json({ removed: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
