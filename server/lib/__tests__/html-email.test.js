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
