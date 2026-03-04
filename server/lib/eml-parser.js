import { simpleParser } from 'mailparser';
import fs from 'fs';

/**
 * Parse an .eml file and extract all structured data.
 *
 * Returns:
 * {
 *   messageId, inReplyTo, references,
 *   from, to, cc, bcc, subject, date,
 *   textBody, htmlBody,
 *   attachments: [{ filename, contentType, size, content (Buffer) }]
 * }
 */
export async function parseEml(filePath) {
    const raw = fs.readFileSync(filePath);
    const parsed = await simpleParser(raw);

    // Extract addresses as readable strings
    const formatAddresses = (addrObj) => {
        if (!addrObj || !addrObj.value) return '';
        return addrObj.value
            .map(a => a.name ? `${a.name} <${a.address}>` : a.address)
            .join(', ');
    };

    // Extract Message-ID (strip angle brackets)
    const cleanId = (id) => {
        if (!id) return null;
        return id.replace(/^</, '').replace(/>$/, '').trim();
    };

    // References can be a string of space-separated message IDs
    const parseReferences = (refs) => {
        if (!refs) return '';
        if (typeof refs === 'string') return refs;
        if (Array.isArray(refs)) return refs.map(r => cleanId(r)).join(' ');
        return '';
    };

    // Extract attachments (skip inline images with content-id used in HTML)
    const attachments = (parsed.attachments || []).map(att => ({
        filename: att.filename || `attachment_${Date.now()}`,
        contentType: att.contentType || 'application/octet-stream',
        size: att.size || att.content.length,
        content: att.content, // Buffer
    }));

    return {
        messageId: cleanId(parsed.messageId),
        inReplyTo: cleanId(parsed.inReplyTo),
        references: parseReferences(parsed.references),
        from: formatAddresses(parsed.from),
        to: formatAddresses(parsed.to),
        cc: formatAddresses(parsed.cc),
        bcc: formatAddresses(parsed.bcc),
        subject: parsed.subject || '(no subject)',
        date: parsed.date ? parsed.date.toISOString() : null,
        textBody: parsed.text || '',
        htmlBody: parsed.html || '',
        attachments,
    };
}
