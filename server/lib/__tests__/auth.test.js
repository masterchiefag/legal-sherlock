import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, generateToken, verifyToken } from '../auth.js';

describe('hashPassword + verifyPassword', () => {
  it('round-trips correctly', async () => {
    const hash = await hashPassword('mysecret');
    expect(hash).not.toBe('mysecret');
    expect(await verifyPassword('mysecret', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('generateToken + verifyToken', () => {
  it('round-trips with correct payload', () => {
    const user = { id: 'u1', email: 'test@test.com', role: 'admin' };
    const token = generateToken(user);
    const decoded = verifyToken(token);
    expect(decoded.id).toBe('u1');
    expect(decoded.email).toBe('test@test.com');
    expect(decoded.role).toBe('admin');
    expect(decoded.exp).toBeDefined();
  });

  it('throws on invalid token', () => {
    expect(() => verifyToken('invalid.token.here')).toThrow();
  });

  it('throws on tampered token', () => {
    const token = generateToken({ id: 'u1', email: 'a@b.com', role: 'admin' });
    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(() => verifyToken(tampered)).toThrow();
  });
});
