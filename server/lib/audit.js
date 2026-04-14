import crypto from 'crypto';

// Action constants
export const ACTIONS = {
  AUTH_LOGIN: 'auth.login',
  AUTH_REGISTER: 'auth.register',
  AUTH_CHANGE_PASSWORD: 'auth.change_password',

  DOC_UPLOAD: 'document.upload',
  DOC_DELETE: 'document.delete',

  REVIEW_UPDATE: 'review.update',

  CLASSIFY_RUN: 'classify.run',
  CLASSIFY_BATCH: 'classify.batch',

  SUMMARIZE_CREATE: 'summarize.create',

  INVESTIGATION_CREATE: 'investigation.create',
  INVESTIGATION_UPDATE: 'investigation.update',
  INVESTIGATION_DELETE: 'investigation.delete',

  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DEACTIVATE: 'user.deactivate',

  MEMBER_ADD: 'member.add',
  MEMBER_REMOVE: 'member.remove',

  TAG_CREATE: 'tag.create',
  TAG_UPDATE: 'tag.update',
  TAG_DELETE: 'tag.delete',
  TAG_ASSIGN: 'tag.assign',
  TAG_UNASSIGN: 'tag.unassign',

  IMPORT_RESUME: 'import.resume',

  BATCH_CREATE: 'batch.create',
  BATCH_ASSIGN: 'batch.assign',
  BATCH_DELETE: 'batch.delete',

  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RESET: 'settings.reset',
};

export function logAudit(db, { userId, action, resourceType, resourceId, details, ipAddress }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, action, resourceType || null, resourceId || null, details ? JSON.stringify(details) : null, ipAddress || null);
  return id;
}
