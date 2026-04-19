import { describe, it, expect } from 'vitest';
import { collectAuthoritativeDates, parsePst } from '../pst-parser.js';

// These tests cover exported surface and error-handling behavior.
// Full end-to-end behavior against a real PST is exercised by manual re-ingest
// of a known Yesha-style PST — we don't ship a PST fixture (binary, >MB, legal).
describe('pst-parser exports', () => {
    it('exports collectAuthoritativeDates and parsePst', () => {
        expect(typeof collectAuthoritativeDates).toBe('function');
        expect(typeof parsePst).toBe('function');
    });
});

describe('collectAuthoritativeDates error handling', () => {
    it('throws when given a non-existent path', () => {
        expect(() => collectAuthoritativeDates('/tmp/definitely-not-a-real-pst.pst'))
            .toThrow();
    });

    it('throws when given a non-PST file', () => {
        // An empty or tiny file is not a valid PST
        expect(() => collectAuthoritativeDates('/etc/hosts'))
            .toThrow();
    });
});
