import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { extractText } from '../lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const id = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${id}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.docx', '.txt', '.csv', '.md'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}`));
        }
    },
});

const router = express.Router();

// Upload documents (supports multiple files)
router.post('/upload', upload.array('files', 50), async (req, res) => {
    try {
        const results = [];

        for (const file of req.files) {
            const id = path.basename(file.filename, path.extname(file.filename));

            // Insert document with processing status
            db.prepare(`
        INSERT INTO documents (id, filename, original_name, mime_type, size_bytes, status)
        VALUES (?, ?, ?, ?, ?, 'processing')
      `).run(id, file.filename, file.originalname, file.mimetype, file.size);

            // Extract text
            try {
                const text = await extractText(file.path, file.mimetype);
                db.prepare(`
          UPDATE documents SET text_content = ?, status = 'ready' WHERE id = ?
        `).run(text, id);

                results.push({ id, name: file.originalname, status: 'ready', size: file.size });
            } catch (err) {
                db.prepare(`
          UPDATE documents SET status = 'error' WHERE id = ?
        `).run(id);
                results.push({ id, name: file.originalname, status: 'error', error: err.message });
            }
        }

        res.json({ uploaded: results.length, documents: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List documents with pagination and filters
router.get('/', (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            sort = 'uploaded_at',
            order = 'desc',
            status,
            tag,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const allowedSorts = ['uploaded_at', 'original_name', 'size_bytes'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'uploaded_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

        let where = 'WHERE 1=1';
        const params = [];

        if (status) {
            where += ' AND d.status = ?';
            params.push(status);
        }

        if (tag) {
            where += ' AND d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)';
            params.push(tag);
        }

        const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM documents d ${where}
    `).get(...params);

        const documents = db.prepare(`
      SELECT d.*,
        (SELECT GROUP_CONCAT(t.name, ', ')
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id) as tag_names,
        (SELECT dr.status FROM document_reviews dr
         WHERE dr.document_id = d.id
         ORDER BY dr.reviewed_at DESC LIMIT 1) as review_status
      FROM documents d
      ${where}
      ORDER BY d.${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

        res.json({
            documents,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countRow.total,
                pages: Math.ceil(countRow.total / parseInt(limit)),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single document
router.get('/:id', (req, res) => {
    try {
        const doc = db.prepare(`
      SELECT d.*,
        (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id) as tags,
        (SELECT json_group_array(json_object('id', dr.id, 'status', dr.status, 'notes', dr.notes, 'reviewed_at', dr.reviewed_at))
         FROM document_reviews dr
         WHERE dr.document_id = d.id
         ORDER BY dr.reviewed_at DESC) as reviews
      FROM documents d
      WHERE d.id = ?
    `).get(req.params.id);

        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Parse JSON arrays
        doc.tags = JSON.parse(doc.tags || '[]');
        doc.reviews = JSON.parse(doc.reviews || '[]');

        // Filter out null entries
        doc.tags = doc.tags.filter(t => t.id !== null);
        doc.reviews = doc.reviews.filter(r => r.id !== null);

        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete document
router.delete('/:id', (req, res) => {
    try {
        const doc = db.prepare('SELECT filename FROM documents WHERE id = ?').get(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Delete file
        const filePath = path.join(UPLOADS_DIR, doc.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        // Delete from db (cascades to tags and reviews)
        db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);

        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
