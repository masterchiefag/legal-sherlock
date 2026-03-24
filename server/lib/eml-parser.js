import { simpleParser } from 'mailparser';
import fs from 'fs';

/**
 * Parse an .eml file and extract all structured data including transport metadata.
 *
 * Returns:
 * {
 *   messageId, inReplyTo, references,
 *   from, to, cc, bcc, subject, date,
 *   textBody, htmlBody,
 *   headersRaw, receivedChain, originatingIp, authResults, serverInfo, deliveryDate,
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

    // ═══════════════════════════════════════════════════
    // Transport / server metadata
    // ═══════════════════════════════════════════════════

    // Raw headers as text (forensic copy)
    const headersRaw = (parsed.headerLines || []).map(h => h.line).join('\n');

    // Parse Received headers into structured hop chain
    const receivedRaw = parsed.headers?.get('received');
    const receivedChain = parseReceivedHeaders(receivedRaw);

    // X-Originating-IP
    const originatingIpRaw = parsed.headers?.get('x-originating-ip');
    const originatingIp = originatingIpRaw
        ? String(originatingIpRaw).replace(/[\[\]]/g, '').trim()
        : null;

    // Authentication-Results (SPF / DKIM / DMARC)
    const authResultsRaw = parsed.headers?.get('authentication-results');
    const authResults = authResultsRaw ? String(authResultsRaw).trim() : null;

    // Sending server from first Received header
    const serverInfo = receivedChain.length > 0 ? receivedChain[0].by || null : null;

    // Delivery date from last Received header (final hop)
    const deliveryDate = receivedChain.length > 0
        ? receivedChain[receivedChain.length - 1].date || null
        : null;

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
        // Transport metadata
        headersRaw,
        receivedChain: JSON.stringify(receivedChain),
        originatingIp,
        authResults,
        serverInfo,
        deliveryDate,
        attachments,
    };
}

/**
 * Parse Received header(s) into structured hop objects.
 * Each hop: { from, by, with, date }
 */
function parseReceivedHeaders(raw) {
    if (!raw) return [];

    const entries = Array.isArray(raw) ? raw : [raw];
    const hops = [];

    for (const entry of entries) {
        const str = String(entry);
        const hop = {};

        const fromMatch = str.match(/from\s+(\S+)/i);
        if (fromMatch) hop.from = fromMatch[1];

        const byMatch = str.match(/by\s+(\S+)/i);
        if (byMatch) hop.by = byMatch[1];

        const withMatch = str.match(/with\s+(\S+)/i);
        if (withMatch) hop.with = withMatch[1];

        // Date is usually after a semicolon
        const dateMatch = str.match(/;\s*(.+)$/);
        if (dateMatch) {
            const d = new Date(dateMatch[1].trim());
            hop.date = isNaN(d.getTime()) ? dateMatch[1].trim() : d.toISOString();
        }

        // Extract IP addresses from the header
        const ipMatch = str.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
        if (ipMatch) hop.ip = ipMatch[1];

        hops.push(hop);
    }

    return hops;
}
