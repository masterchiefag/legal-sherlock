import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const limit = 50;

  useEffect(() => {
    async function fetchLogs() {
      setLoading(true);
      const params = new URLSearchParams({ page, limit });
      if (actionFilter) params.set('action', actionFilter);
      const res = await apiFetch(`/api/audit-logs?${params}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
        setTotalPages(data.pagination.pages);
      }
      setLoading(false);
    }
    fetchLogs();
  }, [page, actionFilter]);

  const actionCategories = [
    { label: 'All Actions', value: '' },
    { label: 'Auth', value: 'auth.' },
    { label: 'Documents', value: 'document.' },
    { label: 'Reviews', value: 'review.' },
    { label: 'Classifications', value: 'classify.' },
    { label: 'Investigations', value: 'investigation.' },
    { label: 'Users', value: 'user.' },
    { label: 'Members', value: 'member.' },
    { label: 'Tags', value: 'tag.' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {actionCategories.map(cat => (
          <button
            key={cat.value}
            onClick={() => { setActionFilter(cat.value); setPage(1); }}
            className={`btn ${actionFilter === cat.value ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.75rem', padding: '4px 10px' }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No audit logs found</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Action</th>
                <th style={thStyle}>Resource</th>
                <th style={thStyle}>IP</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <>
                  <tr key={log.id} style={{ borderBottom: '1px solid var(--border-secondary)', cursor: log.details ? 'pointer' : 'default' }}
                      onClick={() => log.details && setExpandedId(expandedId === log.id ? null : log.id)}>
                    <td style={tdStyle}>{new Date(log.created_at).toLocaleString()}</td>
                    <td style={tdStyle}>{log.user_name || log.user_email || '—'}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '2px 6px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600,
                        background: getActionColor(log.action),
                        color: '#fff',
                      }}>
                        {log.action}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {log.resource_type && (
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {log.resource_type}{log.resource_id ? `: ${log.resource_id.substring(0, 8)}...` : ''}
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{log.ip_address || '—'}</td>
                    <td style={tdStyle}>{log.details ? (expandedId === log.id ? '▼' : '▶') : ''}</td>
                  </tr>
                  {expandedId === log.id && log.details && (
                    <tr key={`${log.id}-details`}>
                      <td colSpan={6} style={{ padding: '8px 12px', background: 'var(--bg-tertiary)' }}>
                        <pre style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify(JSON.parse(log.details), null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Page {page} of {totalPages}
          </span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function getActionColor(action) {
  if (action.startsWith('auth.')) return '#6366f1';
  if (action.startsWith('document.')) return '#3b82f6';
  if (action.startsWith('review.')) return '#22c55e';
  if (action.startsWith('classify.') || action.startsWith('summarize.')) return '#f59e0b';
  if (action.startsWith('investigation.')) return '#8b5cf6';
  if (action.startsWith('user.') || action.startsWith('member.')) return '#ec4899';
  if (action.startsWith('tag.')) return '#14b8a6';
  return '#64748b';
}

const thStyle = { textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem' };
const tdStyle = { padding: '8px 12px', color: 'var(--text-primary)' };
