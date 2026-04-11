import { useState, useEffect } from 'react';
import { apiFetch, apiPost, apiPut, apiDelete } from '../utils/api';

export default function UserManagement({ addToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'reviewer' });
  const [formError, setFormError] = useState('');

  const fetchUsers = async () => {
    const res = await apiFetch('/api/users');
    if (res.ok) setUsers(await res.json());
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setFormError('');
    const res = await apiPost('/api/users', form);
    if (res.ok) {
      setShowForm(false);
      setForm({ name: '', email: '', password: '', role: 'reviewer' });
      addToast('User created', 'success');
      fetchUsers();
    } else {
      const data = await res.json();
      setFormError(data.error || 'Failed to create user');
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    const res = await apiPut(`/api/users/${userId}`, { role: newRole });
    if (res.ok) {
      addToast('Role updated', 'success');
      fetchUsers();
    } else {
      const data = await res.json();
      addToast(data.error || 'Failed to update role', 'error');
    }
  };

  const handleToggleActive = async (userId, currentlyActive) => {
    if (currentlyActive) {
      const res = await apiDelete(`/api/users/${userId}`);
      if (res.ok) {
        addToast('User deactivated', 'success');
        fetchUsers();
      } else {
        const data = await res.json();
        addToast(data.error || 'Failed to deactivate', 'error');
      }
    } else {
      const res = await apiPut(`/api/users/${userId}`, { is_active: true });
      if (res.ok) {
        addToast('User reactivated', 'success');
        fetchUsers();
      }
    }
  };

  if (loading) return <div className="empty-state"><p>Loading users...</p></div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {users.length} user{users.length !== 1 ? 's' : ''}
        </p>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Add User'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <input placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required className="filter-input" />
            <input placeholder="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required className="filter-input" />
            <input placeholder="Password (min 8 chars)" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={8} className="filter-input" />
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="filter-input">
              <option value="admin">Admin</option>
              <option value="reviewer">Reviewer</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          {formError && <div style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '0.5rem' }}>{formError}</div>}
          <button type="submit" className="btn btn-primary" style={{ marginTop: '0.75rem' }}>Create User</button>
        </form>
      )}

      <div className="card" style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                <td style={tdStyle}>{u.name}</td>
                <td style={tdStyle}>{u.email}</td>
                <td style={tdStyle}>
                  <select
                    value={u.role}
                    onChange={e => handleRoleChange(u.id, e.target.value)}
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 6px', fontSize: '0.8rem' }}
                  >
                    <option value="admin">Admin</option>
                    <option value="reviewer">Reviewer</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </td>
                <td style={tdStyle}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600,
                    background: u.is_active ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                    color: u.is_active ? '#22c55e' : '#ef4444',
                  }}>
                    {u.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={tdStyle}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td style={tdStyle}>
                  <button
                    onClick={() => handleToggleActive(u.id, u.is_active)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem',
                      color: u.is_active ? 'var(--danger)' : 'var(--success)',
                    }}
                  >
                    {u.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.8rem' };
const tdStyle = { padding: '8px 12px', color: 'var(--text-primary)' };
