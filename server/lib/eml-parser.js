import PostalMime from 'postal-mime';
import fs from 'fs';
import crypto from 'crypto';

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

/**
 * Extract just the email addresses from an addrList, lowercased + sorted + comma-joined.
 * Used for stable dedup hashing — we ignore display name noise and ordering.
 */
function canonicalAddresses(addrList) {
    if (!addrList || !Array.isArray(addrList)) return '';
    const addrs = addrList
        .map(a => (a.address || '').toLowerCase().trim())
        .filter(Boolean);
    addrs.sort();
    return addrs.join(',');
}

/**
 * Compute the canonical content MD5 for email-level dedup.
 *
 * See GitHub issue #61: Gmail preserves a draft's Message-ID into the sent copy's
 * RFC822 headers, so keying dedup on msg-id silently drops the sent email (with its
 * real attachments). We instead fingerprint the canonical content — critically
 * including a sorted list of attachment MD5s so the draft (no real attachments) and
 * the sent copy (same envelope + real attachments) hash differently and both survive.
 *
 * Input format (joined with "\n"):
 *   1. from email (lowercase, trimmed)
 *   2. to addrs (lowercase, sorted, comma-joined)
 *   3. cc addrs (same)
 *   4. bcc addrs (same)
 *   5. subject (trimmed)
 *   6. date ISO string (or empty)
 *   7. text body (whitespace-collapsed, trimmed)
 *   8. sorted attachment content MD5s (comma-joined)
 */
function computeDedupMd5({ fromAddr, to, cc, bcc, subject, date, textBody, attachmentMd5s }) {
    const attList = [...(attachmentMd5s || [])].sort().join(',');
    const bodyNorm = (textBody || '').replace(/\s+/g, ' ').trim();
    const parts = [
        fromAddr || '',
        canonicalAddresses(to),
        canonicalAddresses(cc),
        canonicalAddresses(bcc),
        (subject || '').trim(),
        date || '',
        bodyNorm,
        attList,
    ];
    return crypto.createHash('md5').update(parts.join('\n'), 'utf8').digest('hex');
}

export { stripHtml, cleanId, formatAddresses, parseReceivedHeaders, computeDedupMd5, canonicalAddresses };

export async function parseEml(filePathOrBuffer) {
    const raw = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);
    // forceRfc822Attachments: surface `message/rfc822` MIME parts (embedded forwarded
    // emails, MAPI attachMethod=5) in parsed.attachments instead of inlining them into
    // the parent's text body. Phase 1.5 in pst-worker already queries for mime_type =
    // 'message/rfc822' to extract children — this flag is what gets the rows in front of
    // that query. Without it Sherlock had 11 embedded-MSG rows for 1,582 in Relativity.
    // NB: postal-mime takes options via the constructor, not via parse().
    const parser = new PostalMime({ forceRfc822Attachments: true });
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

    // Extract attachments.
    // For each, compute MD5 of content — we'll use it both downstream (worker attachment
    // dedup) AND locally in the dedup_md5 canonical form. Also synthesize a filename for
    // unnamed message/rfc822 parts so Phase 1.5's `LIKE '%.msg' OR LIKE '%.eml'` query
    // matches the .eml on disk and picks them up for child-attachment extraction.
    const rawAttachments = parsed.attachments || [];
    const attachments = rawAttachments.map((att, idx) => {
        const content = Buffer.from(att.content);
        const md5 = crypto.createHash('md5').update(content).digest('hex');
        const mimeType = att.mimeType || 'application/octet-stream';
        let filename = att.filename;
        if (!filename) {
            if (mimeType === 'message/rfc822') {
                filename = `forwarded_message_${idx + 1}.eml`;
            } else {
                filename = `attachment_${idx + 1}`;
            }
        }
        return {
            filename,
            contentType: mimeType,
            size: content.byteLength || content.length || 0,
            content,
            md5,
        };
    });

    // postal-mime uses .from/.to as {name, address} or arrays
    const fromArr = parsed.from ? (Array.isArray(parsed.from) ? parsed.from : [parsed.from]) : [];
    const toArr = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [];
    const ccArr = parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : [];
    let bccArr = parsed.bcc ? (Array.isArray(parsed.bcc) ? parsed.bcc : [parsed.bcc]) : [];
    // BCC: RFC 2822 says sent mail SHOULD NOT carry a bcc: header (recipients don't
    // see each other's BCCs). libpst recovers the MAPI-stored BCC list and emits it
    // under `x-libpst-forensic-bcc`. If postal-mime's standard `bcc` is empty, fall
    // back to the forensic variant so reviewers can see who was BCC'd on sent mail —
    // and so the dedup_md5 hash participates in BCC identity instead of hashing on
    // an empty list (two sent emails with identical envelopes but different BCCs
    // would otherwise collide).
    if (bccArr.length === 0) {
        const forensicBcc = getHeader('x-libpst-forensic-bcc');
        if (forensicBcc) {
            bccArr = String(forensicBcc).split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(raw => {
                    // Accept "Name <email>" or bare "email"
                    const m = raw.match(/^(.*?)\s*<(.+?)>\s*$/);
                    return m ? { name: m[1].trim(), address: m[2].trim() } : { address: raw };
                });
        }
    }
    const from = formatAddresses(fromArr);
    const to = formatAddresses(toArr);
    const cc = formatAddresses(ccArr);
    const bcc = formatAddresses(bccArr);

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

    const textBody = parsed.text || stripHtml(parsed.html) || '';

    // Email-level content fingerprint — see GitHub issue #61 and computeDedupMd5() above
    const fromAddr = (fromArr[0]?.address || '').toLowerCase().trim();
    const dedupMd5 = computeDedupMd5({
        fromAddr,
        to: toArr,
        cc: ccArr,
        bcc: bccArr,
        subject: parsed.subject,
        date: emailDate,
        textBody,
        attachmentMd5s: attachments.map(a => a.md5),
    });

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
        textBody,
        htmlBody: parsed.html || '',
        // Transport metadata
        headersRaw,
        receivedChain: JSON.stringify(receivedChain),
        originatingIp,
        authResults,
        serverInfo,
        deliveryDate,
        attachments,
        dedupMd5,
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
