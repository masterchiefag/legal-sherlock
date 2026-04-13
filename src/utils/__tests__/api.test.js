import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage
const storage = {};
const localStorageMock = {
  getItem: vi.fn((key) => storage[key] ?? null),
  setItem: vi.fn((key, value) => { storage[key] = value; }),
  removeItem: vi.fn((key) => { delete storage[key]; }),
};
vi.stubGlobal('localStorage', localStorageMock);

// Mock fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Import after mocks are set up
const { getToken, setToken, clearToken, apiFetch, apiPost, apiPut, apiPatch, apiDelete, getAuthHeader, setLogoutCallback } = await import('../api.js');

describe('token management', () => {
  beforeEach(() => {
    Object.keys(storage).forEach(k => delete storage[k]);
    vi.clearAllMocks();
  });

  it('getToken reads from localStorage', () => {
    storage['sherlock_token'] = 'abc123';
    expect(getToken()).toBe('abc123');
    expect(localStorageMock.getItem).toHaveBeenCalledWith('sherlock_token');
  });

  it('getToken returns null when no token', () => {
    expect(getToken()).toBeNull();
  });

  it('setToken writes to localStorage', () => {
    setToken('newtoken');
    expect(localStorageMock.setItem).toHaveBeenCalledWith('sherlock_token', 'newtoken');
    expect(storage['sherlock_token']).toBe('newtoken');
  });

  it('clearToken removes from localStorage', () => {
    storage['sherlock_token'] = 'abc';
    clearToken();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('sherlock_token');
    expect(storage['sherlock_token']).toBeUndefined();
  });
});

describe('getAuthHeader', () => {
  beforeEach(() => {
    Object.keys(storage).forEach(k => delete storage[k]);
  });

  it('returns Bearer header when token exists', () => {
    storage['sherlock_token'] = 'mytoken';
    expect(getAuthHeader()).toBe('Bearer mytoken');
  });

  it('returns null when no token', () => {
    expect(getAuthHeader()).toBeNull();
  });
});

describe('apiFetch', () => {
  beforeEach(() => {
    Object.keys(storage).forEach(k => delete storage[k]);
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200, json: () => ({}) });
  });

  it('adds Authorization header when token exists', async () => {
    storage['sherlock_token'] = 'tok123';
    await apiFetch('/api/test');
    expect(fetchMock).toHaveBeenCalledWith('/api/test', {
      headers: { Authorization: 'Bearer tok123' },
    });
  });

  it('omits Authorization header when no token', async () => {
    await apiFetch('/api/test');
    expect(fetchMock).toHaveBeenCalledWith('/api/test', {
      headers: {},
    });
  });

  it('passes through custom options', async () => {
    await apiFetch('/api/test', { method: 'POST', headers: { 'X-Custom': 'val' } });
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers['X-Custom']).toBe('val');
  });

  it('calls logout callback on 401', async () => {
    const logoutCb = vi.fn();
    setLogoutCallback(logoutCb);
    fetchMock.mockResolvedValue({ status: 401 });

    await apiFetch('/api/test');
    expect(logoutCb).toHaveBeenCalled();

    // Clean up
    setLogoutCallback(null);
  });

  it('does not call logout on non-401', async () => {
    const logoutCb = vi.fn();
    setLogoutCallback(logoutCb);
    fetchMock.mockResolvedValue({ status: 403 });

    await apiFetch('/api/test');
    expect(logoutCb).not.toHaveBeenCalled();

    setLogoutCallback(null);
  });
});

describe('apiPost', () => {
  beforeEach(() => {
    Object.keys(storage).forEach(k => delete storage[k]);
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200 });
  });

  it('sends POST with JSON body', async () => {
    await apiPost('/api/data', { name: 'test' });
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers['Content-Type']).toBe('application/json');
    expect(callArgs[1].body).toBe(JSON.stringify({ name: 'test' }));
  });
});

describe('apiPut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200 });
  });

  it('sends PUT with JSON body', async () => {
    await apiPut('/api/data/1', { name: 'updated' });
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].method).toBe('PUT');
    expect(callArgs[1].body).toBe(JSON.stringify({ name: 'updated' }));
  });
});

describe('apiPatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200 });
  });

  it('sends PATCH with JSON body', async () => {
    await apiPatch('/api/data/1', { status: 'active' });
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].method).toBe('PATCH');
  });
});

describe('apiDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200 });
  });

  it('sends DELETE request', async () => {
    await apiDelete('/api/data/1');
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].method).toBe('DELETE');
  });
});
