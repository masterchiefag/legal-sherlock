import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { hashPassword, verifyPassword, generateToken } from '../lib/auth.js';
import { logAudit, ACTIONS } from '../lib/audit.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/register
// First user becomes admin. After that, only admins can register new users.
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const isFirstUser = userCount === 0;

    // After the first user, only admins can create new users
    if (!isFirstUser) {
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can register new users' });
      }
    }

    // Check for duplicate email
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const id = crypto.randomUUID();
    const role = isFirstUser ? 'admin' : (req.body.role || 'viewer');
    const passwordHash = await hashPassword(password);

    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(id, email, passwordHash, name, role);

    const user = { id, email, name, role };
    const token = generateToken(user);

    logAudit(db, {
      userId: isFirstUser ? id : req.user.id,
      action: ACTIONS.AUTH_REGISTER,
      resourceType: 'user',
      resourceId: id,
      details: { email, role, isFirstUser },
      ipAddress: req.ip,
    });

    // If first user, auto-add them to all existing investigations
    if (isFirstUser) {
      const investigations = db.prepare('SELECT id FROM investigations').all();
      const insertMember = db.prepare(
        'INSERT OR IGNORE INTO investigation_members (id, investigation_id, user_id, added_by) VALUES (?, ?, ?, ?)'
      );
      for (const inv of investigations) {
        insertMember.run(crypto.randomUUID(), inv.id, id, id);
      }
    }

    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = db.prepare('SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);

    logAudit(db, {
      userId: user.id,
      action: ACTIONS.AUTH_LOGIN,
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip,
    });

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — validate token and return current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/setup-status — check if any users exist (public)
router.get('/setup-status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  res.json({ needsSetup: count === 0 });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newHash, req.user.id);

    logAudit(db, {
      userId: req.user.id,
      action: ACTIONS.AUTH_CHANGE_PASSWORD,
      resourceType: 'user',
      resourceId: req.user.id,
      ipAddress: req.ip,
    });

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
