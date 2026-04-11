import { Router } from 'express';
import db from '../db.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// All audit log routes require admin
router.use(requireRole('admin'));

// GET /api/audit-logs — paginated audit log with optional filters
router.get('/', (req, res) => {
  try {
    const { page = 1, limit = 50, action, user_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (action) {
      where += ' AND a.action LIKE ?';
      params.push(`${action}%`);
    }
    if (user_id) {
      where += ' AND a.user_id = ?';
      params.push(user_id);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM audit_logs a ${where}`).get(...params);

    const logs = db.prepare(`
      SELECT a.*, u.name as user_name, u.email as user_email
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countRow.total,
        pages: Math.ceil(countRow.total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
