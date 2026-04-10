const TOKEN_KEY = 'sherlock_token';

let logoutCallback = null;

export function setLogoutCallback(cb) {
  logoutCallback = cb;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  // Global 401 handling — token expired or invalid
  if (res.status === 401 && logoutCallback) {
    logoutCallback();
    return res;
  }

  return res;
}

export async function apiPost(url, body) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiPut(url, body) {
  return apiFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiPatch(url, body) {
  return apiFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiDelete(url) {
  return apiFetch(url, { method: 'DELETE' });
}

/**
 * Get auth header for XHR requests (file uploads).
 */
export function getAuthHeader() {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}
