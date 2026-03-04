import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useState, useCallback } from 'react';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import Search from './pages/Search';
import DocumentReview from './pages/DocumentReview';

function App() {
    const location = useLocation();
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    const pageTitle = {
        '/': 'Dashboard',
        '/upload': 'Upload Documents',
        '/search': 'Search & Browse',
    }[location.pathname] || (location.pathname.startsWith('/documents/') ? 'Document Review' : '');

    return (
        <div className="app-layout">
            {/* Sidebar */}
            <aside className="sidebar">
                <div className="sidebar-brand">
                    <h1>Disco</h1>
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
                    <NavLink to="/upload" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        Upload
                    </NavLink>
                    <NavLink to="/search" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        Search
                    </NavLink>
                </nav>
                <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border-secondary)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                        v1.0 — Sparse Shuttle
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="main-area">
                <header className="header">
                    <h2 className="header-title">{pageTitle}</h2>
                </header>
                <div className="page-content">
                    <div className="page-enter" key={location.pathname}>
                        <Routes>
                            <Route path="/" element={<Dashboard addToast={addToast} />} />
                            <Route path="/upload" element={<Upload addToast={addToast} />} />
                            <Route path="/search" element={<Search addToast={addToast} />} />
                            <Route path="/documents/:id" element={<DocumentReview addToast={addToast} />} />
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
