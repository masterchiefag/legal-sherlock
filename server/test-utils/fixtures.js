/**
 * Test data factories — generate valid records with sensible defaults.
 * Override any field by passing it in the options object.
 */
import crypto from 'crypto';

let counter = 0;
function nextId() {
  return crypto.randomUUID();
}

export function makeUser(overrides = {}) {
  counter++;
  return {
    id: nextId(),
    email: `user${counter}@test.com`,
    password_hash: '$2a$04$fake_hash_for_testing_only',
    name: `Test User ${counter}`,
    role: 'reviewer',
    is_active: 1,
    ...overrides,
  };
}

export function makeInvestigation(overrides = {}) {
  counter++;
  return {
    id: nextId(),
    name: `Test Investigation ${counter}`,
    status: 'open',
    short_code: `T${counter.toString().padStart(2, '0')}`,
    ...overrides,
  };
}

export function makeDocument(overrides = {}) {
  counter++;
  return {
    id: nextId(),
    filename: `file_${counter}.pdf`,
    original_name: `document_${counter}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1024 * counter,
    status: 'ready',
    doc_type: 'file',
    is_duplicate: 0,
    ...overrides,
  };
}

export function makeMembership(overrides = {}) {
  return {
    id: nextId(),
    ...overrides,
  };
}

/**
 * Insert records into the test database.
 * @param {Database} db - better-sqlite3 instance
 * @param {string} table - table name
 * @param {Object} record - column-value pairs
 */
export function insertRecord(db, table, record) {
  const cols = Object.keys(record);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  db.prepare(sql).run(...Object.values(record));
}

/**
 * Seed common test data: admin user, reviewer user, investigation, and membership.
 * Returns the created records for use in assertions.
 */
export function seedBasicData(db) {
  const admin = makeUser({ role: 'admin', email: 'admin@test.com', name: 'Admin' });
  const reviewer = makeUser({ role: 'reviewer', email: 'reviewer@test.com', name: 'Reviewer' });
  const investigation = makeInvestigation({ name: 'Test Case' });
  const membership = makeMembership({
    investigation_id: investigation.id,
    user_id: reviewer.id,
  });

  insertRecord(db, 'users', admin);
  insertRecord(db, 'users', reviewer);
  insertRecord(db, 'investigations', investigation);
  insertRecord(db, 'investigation_members', membership);

  return { admin, reviewer, investigation, membership };
}
