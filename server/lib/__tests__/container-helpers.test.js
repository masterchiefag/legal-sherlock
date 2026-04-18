import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
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
// Unicode filename handling — GitHub issue #66
// Primary: jszip handles UTF-8 filenames natively.
// Fallback: shell `unzip -p` (CP437 default encoding) fails on non-ASCII paths
// when invoked via child_process — measured on Yesha PST: 386/1184 ZIP failures.
// These tests build small UTF-8 ZIPs on the fly and verify round-trip.
// ═══════════════════════════════════════════════════
const UTF8_TMP_DIR = path.join(__dirname, 'fixtures', '_utf8_tmp');

async function buildUtf8Zip(filePath, entries) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries)) {
        zip.file(name, content);
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(filePath, buf);
}

describe('ZIP Unicode filenames (issue #66)', () => {
    const utf8ZipPath = path.join(UTF8_TMP_DIR, 'utf8-names.zip');
    const nestedZipPath = path.join(UTF8_TMP_DIR, 'nested-paths.zip');

    beforeAll(async () => {
        fs.mkdirSync(UTF8_TMP_DIR, { recursive: true });
        // ZIP with accented filenames — exactly the LAURENT ANDRE YVES MARTENS case
        // we saw in production logs (`Laurent André Yves Martens.doc`).
        await buildUtf8Zip(utf8ZipPath, {
            'Laurent André Yves Martens.doc': Buffer.from('DOC content for André'),
            'DIR-8 - Martens.doc': Buffer.from('ASCII sibling'),
            'résumé (final).pdf': Buffer.from('%PDF-1.4 fake resume'),
        });
        // ZIP with nested UTF-8 paths
        await buildUtf8Zip(nestedZipPath, {
            'MARTENS/DIR-8 - Laurent André Yves Martens.doc': Buffer.from('nested UTF-8'),
            'MARTENS/MBP-1.docx': Buffer.from('ASCII sibling'),
        });
    });

    afterAll(() => {
        try { fs.rmSync(UTF8_TMP_DIR, { recursive: true, force: true }); } catch (_) {}
    });

    it('listZipContents surfaces UTF-8 filenames verbatim', async () => {
        const files = await listZipContents(utf8ZipPath);
        const names = files.map(f => f.path);
        expect(names).toContain('Laurent André Yves Martens.doc');
        expect(names).toContain('résumé (final).pdf');
        expect(names).toContain('DIR-8 - Martens.doc');
    });

    it('extractFileFromZip reads UTF-8 named file correctly (Unicode path)', async () => {
        const buf = await extractFileFromZip(utf8ZipPath, 'Laurent André Yves Martens.doc');
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.toString()).toBe('DOC content for André');
    });

    it('extractFileFromZip reads nested UTF-8 paths', async () => {
        const buf = await extractFileFromZip(nestedZipPath, 'MARTENS/DIR-8 - Laurent André Yves Martens.doc');
        expect(buf.toString()).toBe('nested UTF-8');
    });

    it('listZipContents + extract still work on plain ASCII sibling', async () => {
        const files = await listZipContents(utf8ZipPath);
        const ascii = files.find(f => f.path === 'DIR-8 - Martens.doc');
        expect(ascii).toBeDefined();
        const buf = await extractFileFromZip(utf8ZipPath, 'DIR-8 - Martens.doc');
        expect(buf.toString()).toBe('ASCII sibling');
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
