import { useState, useEffect } from 'react';
import { apiFetch, apiPut, apiPost } from '../utils/api';

const CATEGORY_LABELS = {
  ocr: 'OCR',
  extraction: 'Extraction',
  import: 'Import',
  llm: 'LLM Context',
};

const CATEGORY_ORDER = ['ocr', 'extraction', 'import', 'llm'];

export default function SystemSettings({ addToast }) {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // key being edited
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(null);

  const fetchSettings = async () => {
    const res = await apiFetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
    }
    setLoading(false);
  };

  useEffect(() => { fetchSettings(); }, []);

  const handleSave = async (key) => {
    setSaving(key);
    const res = await apiPut(`/api/settings/${key}`, { value: editValue });
    if (res.ok) {
      addToast('Setting updated', 'success');
      setEditing(null);
      fetchSettings();
    } else {
      const data = await res.json();
      addToast(data.error || 'Failed to update', 'error');
    }
    setSaving(null);
  };

  const handleReset = async (category) => {
    const res = await apiPost('/api/settings/reset', { category });
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
      addToast(`${CATEGORY_LABELS[category] || category} settings reset to defaults`, 'success');
    } else {
      addToast('Failed to reset settings', 'error');
    }
  };

  const handleKeyDown = (e, key) => {
    if (e.key === 'Enter') handleSave(key);
    if (e.key === 'Escape') setEditing(null);
  };

  if (loading) return <div className="empty-state"><p>Loading settings...</p></div>;

  return (
    <div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
        Configure system-wide operational parameters. Changes take effect on the next operation (no restart needed).
      </p>

      {CATEGORY_ORDER.filter(cat => settings[cat]).map(category => (
        <div key={category} className="card" style={{ marginBottom: '1rem', padding: 0, overflow: 'hidden' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px', borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-tertiary)',
          }}>
            <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600 }}>
              {CATEGORY_LABELS[category] || category}
            </h3>
            <button
              onClick={() => handleReset(category)}
              style={{
                background: 'none', border: '1px solid var(--border-color)', borderRadius: 4,
                color: 'var(--text-secondary)', fontSize: '0.75rem', padding: '3px 10px',
                cursor: 'pointer',
              }}
            >
              Reset to defaults
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={thStyle}>Setting</th>
                <th style={{ ...thStyle, width: 140 }}>Value</th>
                <th style={{ ...thStyle, width: 80 }}>Default</th>
                <th style={thStyle}>Description</th>
              </tr>
            </thead>
            <tbody>
              {settings[category].map(s => {
                const isEditing = editing === s.key;
                const isModified = s.value !== s.default_value;
                return (
                  <tr key={s.key} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                    <td style={tdStyle}>
                      <span style={{ fontWeight: 500 }}>{s.label}</span>
                    </td>
                    <td style={tdStyle}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type={s.type === 'number' ? 'number' : 'text'}
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => handleKeyDown(e, s.key)}
                            onBlur={() => setEditing(null)}
                            autoFocus
                            style={{
                              width: 80, padding: '2px 6px', fontSize: '0.85rem',
                              background: 'var(--bg-primary)', color: 'var(--text-primary)',
                              border: '1px solid var(--accent)', borderRadius: 4,
                            }}
                          />
                          <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>{s.unit}</span>
                          <button
                            onMouseDown={(e) => { e.preventDefault(); handleSave(s.key); }}
                            disabled={saving === s.key}
                            style={{
                              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
                              padding: '2px 8px', fontSize: '0.75rem', cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <span
                          onClick={() => { setEditing(s.key); setEditValue(s.value); }}
                          style={{
                            cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
                            border: '1px solid transparent',
                            background: isModified ? 'rgba(59,130,246,0.1)' : 'transparent',
                            fontWeight: isModified ? 600 : 400,
                            color: isModified ? 'var(--accent)' : 'var(--text-primary)',
                          }}
                          title="Click to edit"
                        >
                          {s.value} <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>{s.unit}</span>
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                      {s.default_value} {s.unit}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {s.description}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.8rem' };
const tdStyle = { padding: '8px 12px', color: 'var(--text-primary)' };
