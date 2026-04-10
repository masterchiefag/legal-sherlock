import { verifyToken } from '../lib/auth.js';
import db from '../db.js';

/**
 * Populates req.user from JWT token. Does NOT reject unauthenticated requests.
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    // Verify user still exists and is active
    const user = db.prepare('SELECT id, email, name, role, is_active FROM users WHERE id = ?').get(decoded.id);
    if (!user || !user.is_active) {
      req.user = null;
      return next();
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch {
    req.user = null;
    next();
  }
}

/**
 * Requires a valid authenticated user. Returns 401 if not.
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

/**
 * Requires user to have one of the specified roles. Returns 403 if not.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Checks that the user has access to the requested investigation.
 * Admins bypass the check. Others must be in investigation_members.
 * Attaches req.investigationRole (effective role for this investigation).
 */
export function requireInvestigationAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Extract investigation_id from various sources
  const investigationId = req.params.investigation_id
    || req.params.id  // for /investigations/:id routes
    || req.body?.investigation_id
    || req.query?.investigation_id;

  if (!investigationId) {
    // No investigation context — let the route handler decide
    req.investigationRole = req.user.role;
    return next();
  }

  // Admins bypass membership check
  if (req.user.role === 'admin') {
    req.investigationRole = 'admin';
    return next();
  }

  const membership = db.prepare(
    'SELECT role_override FROM investigation_members WHERE investigation_id = ? AND user_id = ?'
  ).get(investigationId, req.user.id);

  if (!membership) {
    return res.status(403).json({ error: 'You do not have access to this investigation' });
  }

  req.investigationRole = membership.role_override || req.user.role;
  next();
}
