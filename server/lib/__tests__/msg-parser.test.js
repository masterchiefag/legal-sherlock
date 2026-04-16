import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMsg, mimeFromExt } from '../msg-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'test-embedded.msg');

// ═══════════════════════════════════════════════════
// parseMsg — real MSG file integration tests
// ═══════════════════════════════════════════════════
describe('parseMsg', () => {
    const msgBuffer = fs.readFileSync(FIXTURE_PATH);

    it('extracts email subject', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.subject).toBe('Issuer Portal Registration Process');
    });

    it('extracts sender with name and email', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.from).toContain('Shruti Kadam');
        expect(metadata.from).toContain('shruti.kadam@linkintime.co.in');
    });

    it('extracts recipients (to, cc)', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.to).toContain('siddhi.nangare@linkintime.co.in');
        expect(metadata.cc).toContain('raju.mahajan@linkintime.co.in');
    });

    it('extracts email date', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.date).toBeTruthy();
        expect(metadata.date).toContain('2022');
    });

    it('extracts body text', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.textBody).toBeTruthy();
        expect(metadata.textBody.length).toBeGreaterThan(100);
    });

    it('extracts message-id from headers', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.messageId).toBeTruthy();
    });

    it('extracts raw headers', () => {
        const { metadata } = parseMsg(msgBuffer);
        expect(metadata.headersRaw).toBeTruthy();
        expect(metadata.headersRaw).toContain('From:');
    });

    it('extracts document attachments', () => {
        const { attachments } = parseMsg(msgBuffer);
        expect(attachments).toHaveLength(2);
    });

    it('extracts attachment filenames', () => {
        const { attachments } = parseMsg(msgBuffer);
        const filenames = attachments.map(a => a.filename);
        expect(filenames).toContain('User Registration documents.zip');
        expect(filenames).toContain('Information document.docx');
    });

    it('extracts attachment content as Buffer', () => {
        const { attachments } = parseMsg(msgBuffer);
        for (const att of attachments) {
            expect(Buffer.isBuffer(att.content)).toBe(true);
            expect(att.size).toBeGreaterThan(0);
            expect(att.size).toBe(att.content.length);
        }
    });

    it('sets correct MIME types for attachments', () => {
        const { attachments } = parseMsg(msgBuffer);
        const zip = attachments.find(a => a.filename.endsWith('.zip'));
        const docx = attachments.find(a => a.filename.endsWith('.docx'));
        expect(zip.contentType).toBe('application/zip');
        expect(docx.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });
});

// ═══════════════════════════════════════════════════
// parseMsg — skipImages option
// ═══════════════════════════════════════════════════
describe('parseMsg options', () => {
    const msgBuffer = fs.readFileSync(FIXTURE_PATH);

    it('skips images by default, includes them when disabled', () => {
        const withSkip = parseMsg(msgBuffer, { skipImages: true });
        const withoutSkip = parseMsg(msgBuffer, { skipImages: false });
        // With skipImages=false, should include any image attachments that were hidden
        expect(withoutSkip.attachments.length).toBeGreaterThanOrEqual(withSkip.attachments.length);
        // The document attachments (zip, docx) should be present in both
        expect(withSkip.attachments.length).toBe(2);
    });

    it('respects maxAttachmentSize', () => {
        // Set very low limit — should skip all attachments
        const { attachments } = parseMsg(msgBuffer, { maxAttachmentSize: 100 });
        expect(attachments).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════
// parseMsg — error handling
// ═══════════════════════════════════════════════════
describe('parseMsg error handling', () => {
    it('throws on invalid/empty buffer', () => {
        expect(() => parseMsg(Buffer.from([]))).toThrow();
    });

    it('throws on random bytes', () => {
        const randomBuf = Buffer.alloc(1024);
        for (let i = 0; i < 1024; i++) randomBuf[i] = Math.floor(Math.random() * 256);
        expect(() => parseMsg(randomBuf)).toThrow();
    });

    it('throws on text content masquerading as MSG', () => {
        expect(() => parseMsg(Buffer.from('This is not a MSG file'))).toThrow();
    });
});

// ═══════════════════════════════════════════════════
// mimeFromExt
// ═══════════════════════════════════════════════════
describe('mimeFromExt', () => {
    it('returns correct MIME for known extensions', () => {
        expect(mimeFromExt('.pdf')).toBe('application/pdf');
        expect(mimeFromExt('.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        expect(mimeFromExt('.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(mimeFromExt('.txt')).toBe('text/plain');
        expect(mimeFromExt('.html')).toBe('text/html');
        expect(mimeFromExt('.msg')).toBe('application/vnd.ms-outlook');
    });

    it('returns octet-stream for unknown extensions', () => {
        expect(mimeFromExt('.xyz')).toBe('application/octet-stream');
        expect(mimeFromExt('.foo')).toBe('application/octet-stream');
        expect(mimeFromExt('')).toBe('application/octet-stream');
    });
});
