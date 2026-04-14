import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { getAllSettings, getSettingRaw, setSetting, resetSettings } from '../lib/settings.js';
import { logAudit, ACTIONS } from '../lib/audit.js';
import db from '../db.js';

const router = Router();
router.use(requireRole('admin'));

// GET /api/settings — all settings grouped by category
router.get('/', (req, res) => {
  try {
    const rows = getAllSettings();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    res.json({ settings: grouped });
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings/:key — update a single setting
router.put('/:key', (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const existing = getSettingRaw(key);
    if (!existing) return res.status(404).json({ error: 'Setting not found' });

    if (value === undefined || value === null || value === '') {
      return res.status(400).json({ error: 'Value is required' });
    }

    // Validate number type
    if (existing.type === 'number' && isNaN(Number(value))) {
      return res.status(400).json({ error: 'Value must be a number' });
    }

    const oldValue = existing.value;
    setSetting(key, value, req.user.id);

    logAudit(db, {
      userId: req.user.id,
      action: ACTIONS.SETTINGS_UPDATE,
      resourceType: 'setting',
      resourceId: key,
      details: { key, oldValue, newValue: String(value) },
      ipAddress: req.ip,
    });

    res.json({ success: true, setting: getSettingRaw(key) });
  } catch (err) {
    console.error('[settings] PUT error:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// POST /api/settings/reset — reset to defaults (optionally by category)
router.post('/reset', (req, res) => {
  try {
    const { category } = req.body;
    resetSettings(category || null, req.user.id);

    logAudit(db, {
      userId: req.user.id,
      action: ACTIONS.SETTINGS_RESET,
      resourceType: 'setting',
      resourceId: category || 'all',
      details: { category: category || 'all' },
      ipAddress: req.ip,
    });

    const rows = getAllSettings();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    res.json({ success: true, settings: grouped });
  } catch (err) {
    console.error('[settings] RESET error:', err);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

export default router;
