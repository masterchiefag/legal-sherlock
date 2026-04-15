import PostalMime from 'postal-mime';
import fs from 'fs';

/**
 * Parse an .eml file and extract all structured data including transport metadata.
 * Uses postal-mime (official mailparser successor) for faster parsing.
 */

/**
 * Strip HTML tags and decode entities to get plain text from HTML body.
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // remove style blocks
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // remove script blocks
        .replace(/<br\s*\/?>/gi, '\n')                     // br → newline
        .replace(/<\/p>/gi, '\n\n')                        // closing p → double newline
        .replace(/<\/div>/gi, '\n')                        // closing div → newline
        .replace(/<\/tr>/gi, '\n')                         // table rows → newline
        .replace(/<td[^>]*>/gi, '\t')                      // table cells → tab
        .replace(/<[^>]+>/g, '')                           // strip remaining tags
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')                       // collapse excess newlines
        .trim();
}

/**
 * Strip angle brackets from message IDs.
 */
function cleanId(id) {
    if (!id) return null;
    return id.replace(/^</, '').replace(/>$/, '').trim();
}

/**
 * Format address objects to "Name <email>" strings.
 */
function formatAddresses(addrList) {
    if (!addrList || !Array.isArray(addrList)) return '';
    return addrList
        .map(a => a.name ? `${a.name} <${a.address}>` : a.address)
        .join(', ');
}

export { stripHtml, cleanId, formatAddresses, parseReceivedHeaders };

export async function parseEml(filePathOrBuffer) {
    const raw = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);

    // References can be a string of space-separated message IDs
    const parseReferences = (refs) => {
        if (!refs) return '';
        if (typeof refs === 'string') {
            // postal-mime returns references as a space/comma-separated string
            return refs.split(/[\s,]+/).filter(Boolean).map(r => cleanId(r)).join(' ');
        }
        if (Array.isArray(refs)) return refs.map(r => cleanId(r)).join(' ');
        return '';
    };

    // ═══════════════════════════════════════════════════
    // Transport / server metadata from raw headers
    // ═══════════════════════════════════════════════════

    // postal-mime gives us parsed.headers as an array of {key, value}
    const headers = parsed.headers || [];
    const getHeader = (name) => {
        const h = headers.find(h => h.key.toLowerCase() === name.toLowerCase());
        return h ? h.value : null;
    };
    const getHeaders = (name) => {
        return headers.filter(h => h.key.toLowerCase() === name.toLowerCase()).map(h => h.value);
    };

    // Raw headers as text (forensic copy)
    const headersRaw = headers.map(h => `${h.key}: ${h.value}`).join('\n');

    // Parse Received headers into structured hop chain
    const receivedHeaders = getHeaders('received');
    const receivedChain = parseReceivedHeaders(receivedHeaders);

    // X-Originating-IP
    const originatingIpRaw = getHeader('x-originating-ip');
    const originatingIp = originatingIpRaw
        ? String(originatingIpRaw).replace(/[\[\]]/g, '').trim()
        : null;

    // Authentication-Results (SPF / DKIM / DMARC)
    const authResultsRaw = getHeader('authentication-results');
    const authResults = authResultsRaw ? String(authResultsRaw).trim() : null;

    // Sending server from first Received header
    const serverInfo = receivedChain.length > 0 ? receivedChain[0].by || null : null;

    // Delivery date from last Received header (final hop)
    const deliveryDate = receivedChain.length > 0
        ? receivedChain[receivedChain.length - 1].date || null
        : null;

    // Extract attachments
    const attachments = (parsed.attachments || []).map(att => ({
        filename: att.filename || `attachment_${Date.now()}`,
        contentType: att.mimeType || 'application/octet-stream',
        size: att.content?.byteLength || att.content?.length || 0,
        content: Buffer.from(att.content), // postal-mime gives ArrayBuffer/Uint8Array
    }));

    // postal-mime uses .from/.to as {name, address} or arrays
    const from = parsed.from ? formatAddresses(Array.isArray(parsed.from) ? parsed.from : [parsed.from]) : '';
    const to = parsed.to ? formatAddresses(Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : '';
    const cc = parsed.cc ? formatAddresses(Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : '';
    const bcc = parsed.bcc ? formatAddresses(Array.isArray(parsed.bcc) ? parsed.bcc : [parsed.bcc]) : '';

    const warnings = [];

    let emailDate = null;
    if (parsed.date) {
        const d = new Date(parsed.date);
        if (isNaN(d.getTime())) {
            console.warn(`[eml-parser] Invalid date "${parsed.date}" in email: ${parsed.subject || '(no subject)'}`);
            emailDate = String(parsed.date);
            warnings.push({ type: 'invalid_date', raw: String(parsed.date) });
        } else {
            emailDate = d.toISOString();
        }
    }

    return {
        messageId: cleanId(parsed.messageId),
        inReplyTo: cleanId(parsed.inReplyTo),
        references: parseReferences(parsed.references),
        from,
        to,
        cc,
        bcc,
        subject: parsed.subject || '(no subject)',
        date: emailDate,
        textBody: parsed.text || stripHtml(parsed.html) || '',
        htmlBody: parsed.html || '',
        // Transport metadata
        headersRaw,
        receivedChain: JSON.stringify(receivedChain),
        originatingIp,
        authResults,
        serverInfo,
        deliveryDate,
        attachments,
        _warnings: warnings,
    };
}

/**
 * Parse Received header(s) into structured hop objects.
 * Each hop: { from, by, with, date }
 */
function parseReceivedHeaders(entries) {
    if (!entries || entries.length === 0) return [];

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
