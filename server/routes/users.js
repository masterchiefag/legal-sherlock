import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { hashPassword } from '../lib/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// All user management routes require admin
router.use(requireAuth, requireRole('admin'));

// GET /api/users — list all users
router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, email, name, role, is_active, created_at, updated_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json(users);
});

// GET /api/users/:id — get single user with investigation memberships
router.get('/:id', (req, res) => {
  const user = db.prepare(
    'SELECT id, email, name, role, is_active, created_at, updated_at FROM users WHERE id = ?'
  ).get(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const memberships = db.prepare(`
    SELECT im.investigation_id, im.role_override, im.added_at, i.name as investigation_name
    FROM investigation_members im
    JOIN investigations i ON i.id = im.investigation_id
    WHERE im.user_id = ?
    ORDER BY im.added_at DESC
  `).all(req.params.id);

  res.json({ ...user, memberships });
});

// POST /api/users — create a new user (admin creating users directly)
router.post('/', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role && !['admin', 'reviewer', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const userRole = role || 'viewer';

    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(id, email, passwordHash, name, userRole);

    logAudit(db, {
      userId: req.user.id,
      action: ACTIONS.USER_CREATE,
      resourceType: 'user',
      resourceId: id,
      details: { email, role: userRole },
      ipAddress: req.ip,
    });

    res.status(201).json({ id, email, name, role: userRole, is_active: 1 });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id — update user (name, role, is_active)
router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { name, role, is_active } = req.body;

  // Prevent demoting the last admin
  if (role && role !== 'admin' && user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
  }

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  logAudit(db, {
    userId: req.user.id,
    action: ACTIONS.USER_UPDATE,
    resourceType: 'user',
    resourceId: req.params.id,
    details: { name, role, is_active },
    ipAddress: req.ip,
  });

  const updated = db.prepare(
    'SELECT id, email, name, role, is_active, created_at, updated_at FROM users WHERE id = ?'
  ).get(req.params.id);

  res.json(updated);
});

// DELETE /api/users/:id — soft delete (deactivate)
router.delete('/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Prevent deactivating last admin
  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot deactivate the last admin' });
    }
  }

  db.prepare("UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);

  logAudit(db, {
    userId: req.user.id,
    action: ACTIONS.USER_DEACTIVATE,
    resourceType: 'user',
    resourceId: req.params.id,
    ipAddress: req.ip,
  });

  res.json({ message: 'User deactivated' });
});

export default router;
