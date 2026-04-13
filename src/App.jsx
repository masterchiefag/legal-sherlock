import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useState, useCallback, useEffect } from 'react';
import { useAuth } from './contexts/AuthContext';
import { apiFetch } from './utils/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import Search from './pages/Search';
import DocumentReview from './pages/DocumentReview';
import ClassificationLogs from './pages/ClassificationLogs';
import Investigations from './pages/Investigations';
import Playground from './pages/Playground';
import ImageExtraction from './pages/ImageExtraction';
import SummarizationJobs from './pages/SummarizationJobs';
import UserManagement from './pages/UserManagement';
import AuditLog from './pages/AuditLog';
import Batches from './pages/Batches';

function App() {
    const location = useLocation();
    const { user, isLoading, logout } = useAuth();
    const [toasts, setToasts] = useState([]);

    // Global investigation state
    const [activeInvestigationId, setActiveInvestigationId] = useState(
        localStorage.getItem('sherlock_investigation_id') || null
    );
    const [activeInvestigation, setActiveInvestigation] = useState(null);

    // Fetch details for the active investigation
    useEffect(() => {
        if (!activeInvestigationId || !user) {
            setActiveInvestigation(null);
            return;
        }
        apiFetch(`/api/investigations/${activeInvestigationId}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data && !data.error) setActiveInvestigation(data);
                else setActiveInvestigation(null);
            })
            .catch(() => setActiveInvestigation(null));
    }, [activeInvestigationId, user]);

    const handleInvestigationChange = (id) => {
        if (id) {
            localStorage.setItem('sherlock_investigation_id', id);
            setActiveInvestigationId(id);
        } else {
            localStorage.removeItem('sherlock_investigation_id');
            setActiveInvestigationId(null);
        }
    };

    const addToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    // Show loading spinner while checking auth
    if (isLoading) {
        return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading...</div>
            </div>
        );
    }

    // Show login if not authenticated
    if (!user) {
        return <Login />;
    }

    const isAdmin = user.role === 'admin';
    const isViewer = user.role === 'viewer';

    const pageTitle = {
        '/': 'Dashboard',
        '/investigations': 'Manage Cases',
        '/upload': 'Upload Documents',
        '/search': 'Analyze',
        '/ai-logs': 'AI Activity Logs',
        '/batches': 'Review Batches',
        '/summaries': 'Summarization Jobs',
        '/playground': 'LLM Playground',
        '/image-extraction': 'Image Extraction',
        '/admin/users': 'User Management',
        '/admin/audit': 'Audit Log',
    }[location.pathname] || (location.pathname.startsWith('/documents/') ? 'Document Review' : '');

    return (
        <div className="app-layout">
            {/* Sidebar */}
            <aside className="sidebar">
                <div className="sidebar-brand">
                    <h1>Sherlock</h1>
                    <div className="brand-sub">eDiscovery Platform</div>
                </div>

                <nav className="sidebar-nav">
                    <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="3" width="7" height="7" rx="1" />
                            <rect x="3" y="14" width="7" height="7" rx="1" />
                            <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                        Dashboard
                    </NavLink>
                    {!isViewer && (
                        <NavLink to="/upload" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            Upload
                        </NavLink>
                    )}
                    <NavLink to="/search" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        Analyze
                    </NavLink>
                    {!isViewer && (
                    <NavLink to="/batches" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="20" height="5" rx="1" />
                            <rect x="2" y="10" width="20" height="5" rx="1" />
                            <rect x="2" y="17" width="20" height="5" rx="1" />
                        </svg>
                        Batches
                    </NavLink>
                    )}
                    <NavLink to="/ai-logs" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                            <polyline points="10 9 9 9 8 9"></polyline>
                        </svg>
                        AI Logs
                    </NavLink>
                    <NavLink to="/summaries" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" />
                            <line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
                        </svg>
                        Summaries
                    </NavLink>
                    {!isViewer && (
                        <NavLink to="/playground" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="4 17 10 11 4 5"></polyline>
                                <line x1="12" y1="19" x2="20" y2="19"></line>
                            </svg>
                            Playground
                        </NavLink>
                    )}
                    {isAdmin && (
                        <NavLink to="/image-extraction" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                                <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
                            </svg>
                            Image Extraction
                        </NavLink>
                    )}

                    {isAdmin && (
                        <>
                            <div style={{ padding: '12px 12px 4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-tertiary)' }}>
                                Admin
                            </div>
                            <NavLink to="/admin/users" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                                <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="9" cy="7" r="4"></circle>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                                </svg>
                                Users
                            </NavLink>
                            <NavLink to="/admin/audit" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                                <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                </svg>
                                Audit Log
                            </NavLink>
                        </>
                    )}
                </nav>

                {/* User info + logout */}
                <div style={{ padding: '12px', borderTop: '1px solid var(--border-secondary)', marginTop: 'auto' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <div style={{
                            width: 28, height: 28, borderRadius: '50%',
                            background: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '11px', fontWeight: 700, color: '#fff', flexShrink: 0,
                        }}>
                            {user.name?.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {user.name}
                            </div>
                            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', textTransform: 'capitalize' }}>
                                {user.role}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={logout}
                        style={{
                            width: '100%', padding: '4px 8px', border: '1px solid var(--border-secondary)',
                            borderRadius: 4, background: 'transparent', color: 'var(--text-secondary)',
                            fontSize: '11px', cursor: 'pointer',
                        }}
                    >
                        Sign Out
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="main-area">
                <header className="header">
                    <h2 className="header-title">{pageTitle}</h2>
                    <div className="header-actions">
                        {activeInvestigation ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'var(--bg-tertiary)', borderRadius: '6px', border: '1px solid var(--border-secondary)', fontSize: '13px' }}>
                                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }}></span>
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeInvestigation.name}</span>
                                </div>
                                <NavLink to="/investigations" style={{ fontSize: '12px', color: 'var(--text-accent)', textDecoration: 'none' }}>
                                    Switch Case
                                </NavLink>
                            </div>
                        ) : (
                            <NavLink to="/investigations" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', background: 'var(--bg-tertiary)', borderRadius: '6px', border: '1px dashed var(--danger)', fontSize: '12px', color: 'var(--danger)', textDecoration: 'none' }}>
                                No case selected — Select Case
                            </NavLink>
                        )}
                    </div>
                </header>
                <div className="page-content">
                    <div className="page-enter" key={location.pathname}>
                        <Routes>
                            <Route path="/" element={<Dashboard activeInvestigationId={activeInvestigationId} activeInvestigation={activeInvestigation} addToast={addToast} />} />
                            <Route path="/investigations" element={<Investigations activeInvestigationId={activeInvestigationId} onInvestigationChange={handleInvestigationChange} addToast={addToast} user={user} />} />
                            <Route path="/upload" element={<Upload activeInvestigationId={activeInvestigationId} activeInvestigation={activeInvestigation} addToast={addToast} />} />
                            <Route path="/search" element={<Search activeInvestigationId={activeInvestigationId} activeInvestigation={activeInvestigation} addToast={addToast} user={user} />} />
                            <Route path="/batches" element={<Batches activeInvestigationId={activeInvestigationId} activeInvestigation={activeInvestigation} addToast={addToast} user={user} />} />
                            <Route path="/ai-logs" element={<ClassificationLogs activeInvestigationId={activeInvestigationId} />} />
                            <Route path="/summaries" element={<SummarizationJobs activeInvestigationId={activeInvestigationId} addToast={addToast} />} />
                            <Route path="/playground" element={<Playground addToast={addToast} />} />
                            <Route path="/image-extraction" element={<ImageExtraction addToast={addToast} activeInvestigationId={activeInvestigationId} activeInvestigation={activeInvestigation} />} />
                            <Route path="/documents/:id" element={<DocumentReview activeInvestigationId={activeInvestigationId} addToast={addToast} user={user} />} />
                            {isAdmin && <Route path="/admin/users" element={<UserManagement addToast={addToast} />} />}
                            {isAdmin && <Route path="/admin/audit" element={<AuditLog />} />}
                            <Route path="*" element={
                                <div className="empty-state">
                                    <h3 className="empty-state-title">Page not found</h3>
                                    <p className="empty-state-text">The page you're looking for doesn't exist.</p>
                                </div>
                            } />
                        </Routes>
                    </div>
                </div>
            </main>

            {/* Toasts */}
            {toasts.length > 0 && (
                <div className="toast-container">
                    {toasts.map(t => (
                        <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default App;
