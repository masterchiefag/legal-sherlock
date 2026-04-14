import db from '../db.js';

// In-memory cache with TTL — workers share the same db import,
// so cache invalidation on write keeps everything fresh.
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

function loadCache() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) return cache;
  const rows = db.prepare('SELECT key, value, type FROM system_settings').all();
  cache = {};
  for (const row of rows) {
    cache[row.key] = parseValue(row.value, row.type);
  }
  cacheTime = now;
  return cache;
}

function parseValue(value, type) {
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

export function getSetting(key) {
  const map = loadCache();
  return map[key];
}

export function getSettingRaw(key) {
  return db.prepare('SELECT * FROM system_settings WHERE key = ?').get(key);
}

export function getAllSettings() {
  return db.prepare('SELECT * FROM system_settings ORDER BY category, key').all();
}

export function setSetting(key, value, userId) {
  db.prepare(
    `UPDATE system_settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?`
  ).run(String(value), userId, key);
  cache = null; // invalidate cache
}

export function resetSettings(category, userId) {
  if (category) {
    db.prepare(
      `UPDATE system_settings SET value = default_value, updated_at = datetime('now'), updated_by = ? WHERE category = ?`
    ).run(userId, category);
  } else {
    db.prepare(
      `UPDATE system_settings SET value = default_value, updated_at = datetime('now'), updated_by = ?`
    ).run(userId);
  }
  cache = null;
}
