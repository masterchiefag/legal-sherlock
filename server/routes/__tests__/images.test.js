import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(__dirname, '..', 'images.js');

describe('images route module', () => {
  it('should exist as a file', () => {
    expect(fs.existsSync(routeFile)).toBe(true);
  });

  it('should export a default router', async () => {
    // Dynamic import will trigger db.js side-effects (creates SQLite DB)
    // but that is acceptable in a test environment
    const mod = await import('../images.js');
    expect(typeof mod.default).toBe('function');
    // Express routers have a .stack property
    expect(Array.isArray(mod.default.stack)).toBe(true);
  });
});
