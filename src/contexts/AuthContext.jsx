import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiFetch, apiPost, setToken, clearToken, setLogoutCallback } from '../utils/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  // Register the logout callback for global 401 handling
  useEffect(() => {
    setLogoutCallback(logout);
  }, [logout]);

  // Validate token on mount
  useEffect(() => {
    async function validate() {
      try {
        // First check if any users exist
        const setupRes = await fetch('/api/auth/setup-status');
        const setupData = await setupRes.json();
        if (setupData.needsSetup) {
          setNeedsSetup(true);
          setIsLoading(false);
          return;
        }

        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else {
          clearToken();
        }
      } catch {
        clearToken();
      }
      setIsLoading(false);
    }
    validate();
  }, []);

  const login = async (email, password) => {
    const res = await apiPost('/api/auth/login', { email, password });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const register = async (email, password, name) => {
    const res = await apiPost('/api/auth/register', { email, password, name });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    setToken(data.token);
    setUser(data.user);
    setNeedsSetup(false);
    return data.user;
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, needsSetup, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
