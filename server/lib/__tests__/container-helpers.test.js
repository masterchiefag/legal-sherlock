import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
    mimeFromExt,
    SKIP_EXTS,
    EXTRACTABLE_EXTS,
    CONTAINER_EXTS,
    listZipContents,
    extractFileFromZip,
    detectPdfEmbeddedFiles,
} from '../container-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const ZIP_FIXTURE = path.join(FIXTURE_DIR, 'test-container.zip');

// ═══════════════════════════════════════════════════
// mimeFromExt
// ═══════════════════════════════════════════════════
describe('mimeFromExt', () => {
    it('returns correct MIME for common document types', () => {
        expect(mimeFromExt('.pdf')).toBe('application/pdf');
        expect(mimeFromExt('.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        expect(mimeFromExt('.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(mimeFromExt('.txt')).toBe('text/plain');
        expect(mimeFromExt('.html')).toBe('text/html');
        expect(mimeFromExt('.zip')).toBe('application/zip');
        expect(mimeFromExt('.msg')).toBe('application/vnd.ms-outlook');
        expect(mimeFromExt('.eml')).toBe('message/rfc822');
    });

    it('returns octet-stream for unknown extensions', () => {
        expect(mimeFromExt('.xyz')).toBe('application/octet-stream');
        expect(mimeFromExt('.foo')).toBe('application/octet-stream');
        expect(mimeFromExt('')).toBe('application/octet-stream');
    });
});

// ═══════════════════════════════════════════════════
// Extension sets
// ═══════════════════════════════════════════════════
describe('extension sets', () => {
    it('SKIP_EXTS includes common image/media/executable types', () => {
        expect(SKIP_EXTS.has('.png')).toBe(true);
        expect(SKIP_EXTS.has('.jpg')).toBe(true);
        expect(SKIP_EXTS.has('.mp4')).toBe(true);
        expect(SKIP_EXTS.has('.exe')).toBe(true);
    });

    it('SKIP_EXTS does not include document types', () => {
        expect(SKIP_EXTS.has('.pdf')).toBe(false);
        expect(SKIP_EXTS.has('.docx')).toBe(false);
        expect(SKIP_EXTS.has('.zip')).toBe(false);
    });

    it('EXTRACTABLE_EXTS includes text-extractable formats', () => {
        expect(EXTRACTABLE_EXTS.has('.pdf')).toBe(true);
        expect(EXTRACTABLE_EXTS.has('.docx')).toBe(true);
        expect(EXTRACTABLE_EXTS.has('.xlsx')).toBe(true);
        expect(EXTRACTABLE_EXTS.has('.txt')).toBe(true);
    });

    it('CONTAINER_EXTS includes container formats', () => {
        expect(CONTAINER_EXTS.has('.zip')).toBe(true);
        expect(CONTAINER_EXTS.has('.msg')).toBe(true);
        expect(CONTAINER_EXTS.has('.eml')).toBe(true);
        expect(CONTAINER_EXTS.has('.rar')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════
// ZIP helpers
// ═══════════════════════════════════════════════════
describe('listZipContents', () => {
    it('lists files inside a ZIP archive', async () => {
        const files = await listZipContents(ZIP_FIXTURE);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('test-inside.txt');
        expect(files[0].size).toBeGreaterThan(0);
    });

    it('throws on non-existent ZIP', async () => {
        await expect(listZipContents('/tmp/nonexistent.zip')).rejects.toThrow();
    });

    it('throws on invalid ZIP (random bytes)', async () => {
        const tmpPath = '/tmp/sherlock-test-invalid.zip';
        fs.writeFileSync(tmpPath, Buffer.alloc(100, 0xFF));
        await expect(listZipContents(tmpPath)).rejects.toThrow();
        fs.unlinkSync(tmpPath);
    });
});

describe('extractFileFromZip', () => {
    it('extracts a file as Buffer', async () => {
        const buf = await extractFileFromZip(ZIP_FIXTURE, 'test-inside.txt');
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.toString()).toContain('Hello from test PDF');
    });

    it('rejects on non-existent internal path', async () => {
        await expect(extractFileFromZip(ZIP_FIXTURE, 'no-such-file.txt')).rejects.toThrow();
    });
});

// ═══════════════════════════════════════════════════
// PDF portfolio detection
// ═══════════════════════════════════════════════════
describe('detectPdfEmbeddedFiles', () => {
    it('returns empty array for a normal PDF (no embedded files)', async () => {
        // Use any PDF from test_files if available, otherwise create a minimal one
        const testPdfPath = '/tmp/sherlock-test-normal.pdf';
        // Minimal valid PDF (no embedded files)
        fs.writeFileSync(testPdfPath, '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF');
        const result = await detectPdfEmbeddedFiles(testPdfPath);
        expect(result).toEqual([]);
        fs.unlinkSync(testPdfPath);
    });

    it('returns empty array for non-PDF file', async () => {
        const result = await detectPdfEmbeddedFiles('/tmp/nonexistent.pdf');
        expect(result).toEqual([]);
    });
});
