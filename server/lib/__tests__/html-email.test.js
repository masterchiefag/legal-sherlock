/**
 * Tests for HTML email rendering: inline image detection, CID rewriting, sanitization.
 */
import { describe, it, expect } from 'vitest';
import DOMPurify from 'isomorphic-dompurify';

// ─── Inline image detection logic (mirrors pst-worker processEmail) ──────────

function isInlineImage(att, idx, htmlBody, cidMap) {
    // Check if CID-referenced in HTML
    if (att.contentId && cidMap.has(att.contentId)) return true;
    // Check postal-mime signals + image00N pattern
    const isInlineSignal = att.disposition === 'inline' || att.related || !!att.contentId;
    const isImagePattern = /^image\d{3,4}\.\w+$/i.test(att.filename);
    return isInlineSignal && isImagePattern;
}

function buildCidMap(htmlBody, attachments) {
    const cidMap = new Map();
    const cidRefs = (htmlBody || '').match(/cid:([^"'\s>]+)/gi) || [];
    for (const ref of cidRefs) {
        const cid = ref.slice(4).replace(/^</, '').replace(/>$/, '');
        cidMap.set(cid, true);
    }
    return cidMap;
}

describe('Inline image detection', () => {
    it('flags attachment with contentId matching CID ref in HTML', () => {
        const att = { filename: 'image001.png', contentId: 'image001.png@01DB123', disposition: null, related: false };
        const html = '<img src="cid:image001.png@01DB123">';
        const cidMap = buildCidMap(html, [att]);
        expect(isInlineImage(att, 0, html, cidMap)).toBe(true);
    });

    it('flags attachment with disposition=inline + contentId', () => {
        const att = { filename: 'image002.jpg', contentId: 'img002@host', disposition: 'inline', related: false };
        const html = '';
        const cidMap = buildCidMap(html, [att]);
        // No CID ref in HTML, but disposition=inline + contentId + image00N pattern
        expect(isInlineImage(att, 0, html, cidMap)).toBe(true);
    });

    it('flags attachment with related=true + image00N pattern', () => {
        const att = { filename: 'image003.gif', contentId: null, disposition: null, related: true };
        const html = '';
        const cidMap = buildCidMap(html, [att]);
        expect(isInlineImage(att, 0, html, cidMap)).toBe(true);
    });

    it('does NOT flag report.pdf with no contentId', () => {
        const att = { filename: 'report.pdf', contentId: null, disposition: null, related: false };
        const html = '';
        const cidMap = buildCidMap(html, [att]);
        expect(isInlineImage(att, 0, html, cidMap)).toBe(false);
    });

    it('does NOT flag image001.jpg with disposition=attachment and no contentId', () => {
        const att = { filename: 'image001.jpg', contentId: null, disposition: 'attachment', related: false };
        const html = '';
        const cidMap = buildCidMap(html, [att]);
        // disposition=attachment, no contentId, no related → NOT inline
        expect(isInlineImage(att, 0, html, cidMap)).toBe(false);
    });

    it('does NOT flag descriptive image name even with inline disposition', () => {
        const att = { filename: 'company-logo-2024.png', contentId: null, disposition: 'inline', related: false };
        const html = '';
        const cidMap = buildCidMap(html, [att]);
        // disposition=inline but filename doesn't match image00N pattern and no contentId
        expect(isInlineImage(att, 0, html, cidMap)).toBe(false);
    });
});

// ─── CID rewriting ───────────────────────────────────────────────────────────

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteCidRefs(html, emailId, inlineAttachments) {
    let result = html;
    for (const att of inlineAttachments) {
        if (att.contentId) {
            result = result.replace(
                new RegExp(`cid:${escapeRegex(att.contentId)}`, 'gi'),
                `${emailId}/${att.filename}`
            );
        }
    }
    return result;
}

describe('CID rewriting', () => {
    it('replaces cid: refs with relative paths', () => {
        const html = '<img src="cid:image001.png@01DB123"><img src="cid:image002.jpg@01DB456">';
        const emailId = 'abc-123';
        const atts = [
            { filename: 'image001.png', contentId: 'image001.png@01DB123' },
            { filename: 'image002.jpg', contentId: 'image002.jpg@01DB456' },
        ];
        const result = rewriteCidRefs(html, emailId, atts);
        expect(result).toBe('<img src="abc-123/image001.png"><img src="abc-123/image002.jpg">');
    });

    it('leaves unmatched cid: refs untouched', () => {
        const html = '<img src="cid:unknown@host">';
        const result = rewriteCidRefs(html, 'abc', []);
        expect(result).toBe('<img src="cid:unknown@host">');
    });

    it('handles contentId with special regex chars', () => {
        const html = '<img src="cid:image001.png+test@host.com">';
        const atts = [{ filename: 'image001.png', contentId: 'image001.png+test@host.com' }];
        const result = rewriteCidRefs(html, 'email-1', atts);
        expect(result).toBe('<img src="email-1/image001.png">');
    });
});

// ─── inline_images_meta generation ───────────────────────────────────────────

describe('inline_images_meta JSON', () => {
    it('generates correct metadata', () => {
        const inlineAttachments = [
            { filename: 'image001.png', size: 257, contentType: 'image/png' },
            { filename: 'image002.jpg', size: 36124, contentType: 'image/jpeg' },
        ];
        const meta = {
            count: inlineAttachments.length,
            totalSize: inlineAttachments.reduce((sum, a) => sum + a.size, 0),
            images: inlineAttachments.map(a => ({ name: a.filename, size: a.size, type: a.contentType })),
        };
        expect(meta.count).toBe(2);
        expect(meta.totalSize).toBe(36381);
        expect(meta.images[0].name).toBe('image001.png');
        expect(meta.images[1].type).toBe('image/jpeg');
    });
});

// ─── DOMPurify sanitization ──────────────────────────────────────────────────

function sanitizeHtml(html) {
    const clean = DOMPurify.sanitize(html, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'textarea', 'button'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'onchange', 'onkeydown', 'onkeyup', 'onkeypress'],
        ALLOW_DATA_ATTR: false,
    });
    // Block external images
    return clean.replace(
        /(<img[^>]*)\ssrc="(https?:\/\/[^"]+)"/gi,
        (match, prefix) => `${prefix} data-blocked-src="[external image blocked]"`
    );
}

describe('HTML sanitization', () => {
    it('strips script tags', () => {
        const result = sanitizeHtml('<div>Hello</div><script>alert(1)</script>');
        expect(result).not.toContain('<script');
        expect(result).toContain('Hello');
    });

    it('strips onerror attribute', () => {
        const result = sanitizeHtml('<img src="/uploads/inv/html/email/image001.png" onerror="alert(1)">');
        expect(result).not.toContain('onerror');
        expect(result).toContain('src="/uploads/inv/html/email/image001.png"');
    });

    it('preserves local image src', () => {
        const result = sanitizeHtml('<img src="/uploads/inv/html/email/image001.png">');
        expect(result).toContain('src="/uploads/inv/html/email/image001.png"');
    });

    it('blocks external image src', () => {
        const result = sanitizeHtml('<img src="https://tracker.evil.com/pixel.gif">');
        expect(result).not.toContain('https://tracker.evil.com');
        expect(result).toContain('data-blocked-src');
    });

    it('strips javascript: URIs in href', () => {
        const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
        expect(result).not.toContain('javascript:');
    });

    it('preserves safe HTML structure', () => {
        const result = sanitizeHtml('<div><p>text</p><span>more</span></div>');
        expect(result).toContain('<p>text</p>');
        expect(result).toContain('<span>more</span>');
    });

    it('strips iframe tags', () => {
        const result = sanitizeHtml('<iframe src="https://evil.com"></iframe><p>safe</p>');
        expect(result).not.toContain('<iframe');
        expect(result).toContain('safe');
    });

    it('strips form tags', () => {
        const result = sanitizeHtml('<form action="/steal"><input type="text"></form><p>safe</p>');
        expect(result).not.toContain('<form');
        expect(result).not.toContain('<input');
    });
});

// ─── resolveFileExtension (shared helper) ───────────────────────────────────

import { resolveFileExtension, MIME_TO_EXT } from '../file-extension.js';

describe('resolveFileExtension', () => {
    it('uses original_name extension when present', () => {
        expect(resolveFileExtension('report.pdf', 'application/pdf', 'abc-123.pdf')).toBe('pdf');
    });

    it('uses original_name extension even when MIME disagrees', () => {
        // Trust the filename over MIME for normal cases
        expect(resolveFileExtension('data.csv', 'text/plain', 'abc.csv')).toBe('csv');
    });

    it('falls back to MIME type when original_name has no extension', () => {
        expect(resolveFileExtension('NSDL-Fees Calculator Tool ', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'abc.xlsx')).toBe('xlsx');
    });

    it('falls back to MIME for text/calendar (ICS files)', () => {
        expect(resolveFileExtension('Meeting Request', 'text/calendar', 'abc.bin')).toBe('ics');
    });

    it('falls back to MIME for message/rfc822', () => {
        expect(resolveFileExtension('Forwarded Email', 'message/rfc822', 'abc.bin')).toBe('eml');
    });

    it('falls back to disk filename when MIME is octet-stream', () => {
        expect(resolveFileExtension('attachment_1776336142593', 'application/octet-stream', 'inv-id/doc-id.xlsx')).toBe('xlsx');
    });

    it('returns bin for octet-stream with .bin disk file', () => {
        expect(resolveFileExtension('attachment_1776336142593', 'application/octet-stream', 'inv-id/doc-id.bin')).toBe('bin');
    });

    it('handles all null/empty inputs gracefully', () => {
        expect(resolveFileExtension(null, null, null)).toBe('');
        expect(resolveFileExtension('', '', '')).toBe('');
        expect(resolveFileExtension('noext', null, null)).toBe('');
    });

    it('handles readpst double-space names (extension survived)', () => {
        expect(resolveFileExtension('R.S. No. 206  - Industrial N.A. land.docx', null, 'abc.docx')).toBe('docx');
    });

    it('handles common MIME types correctly', () => {
        expect(resolveFileExtension(null, 'application/pdf', null)).toBe('pdf');
        expect(resolveFileExtension(null, 'image/jpeg', null)).toBe('jpg');
        expect(resolveFileExtension(null, 'image/png', null)).toBe('png');
        expect(resolveFileExtension(null, 'application/msword', null)).toBe('doc');
        expect(resolveFileExtension(null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', null)).toBe('docx');
    });

    it('returns empty for unknown MIME with no other signals', () => {
        expect(resolveFileExtension(null, 'application/octet-stream', null)).toBe('');
        expect(resolveFileExtension(null, 'application/x-unknown', null)).toBe('');
    });

    it('rejects non-alphanumeric extensions', () => {
        // Trailing spaces or special chars shouldn't be treated as extensions
        expect(resolveFileExtension('file.a b c', null, null)).toBe('');
    });

    it('MIME_TO_EXT map covers key formats', () => {
        expect(MIME_TO_EXT['text/calendar']).toBe('ics');
        expect(MIME_TO_EXT['message/rfc822']).toBe('eml');
        expect(MIME_TO_EXT['application/zip']).toBe('zip');
        expect(MIME_TO_EXT['application/vnd.ms-outlook']).toBe('msg');
    });
});
