/**
 * msg-parser.js
 *
 * Parses Outlook .msg files (OLE Compound Binary format) using @kenjiuno/msgreader.
 * Extracts email metadata and attachment contents, returning a structure compatible
 * with the eml-parser.js interface.
 *
 * MSG files appear as opaque attachments when readpst -e extracts a PST. These are
 * typically forwarded or embedded emails. Without parsing them, their document
 * attachments (PDFs, DOCX, etc.) are invisible to search and review.
 *
 * Key difference from eml-parser: MSG files use OLE Compound Binary format (Microsoft
 * proprietary), while EML files are RFC 5322 plain text. The msgreader library handles
 * the binary parsing; this module normalizes the output.
 *
 * Gotchas:
 * - msgreader's getAttachment() returns { fileName, content: Uint8Array }
 * - innerMsgContent attachments are nested embedded emails (we recurse into them)
 * - attachmentHidden attachments are inline images for HTML body (we skip them)
 * - Some MSG files have EX-type addresses (Exchange DN) instead of SMTP — we try
 *   smtpAddress and creatorSMTPAddress as fallbacks
 * - Content is returned as Buffer (converted from Uint8Array)
 */

import MsgReader from '@kenjiuno/msgreader';
import { stripHtml, cleanId, formatAddresses, parseReceivedHeaders } from './eml-parser.js';

// Extensions we skip when extracting attachments (images, media, executables)
const SKIP_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv', '.webm',
    '.exe', '.dll', '.so', '.dylib',
    '.emz', '.wmf',
]);

/**
 * Parse a .msg file buffer and extract email metadata + attachments.
 *
 * @param {Buffer} msgBuffer - Raw MSG file content
 * @param {Object} opts
 * @param {boolean} opts.skipImages - Skip image attachments (default: true)
 * @param {number} opts.maxAttachmentSize - Max attachment size in bytes (default: 100MB)
 * @param {number} opts.maxDepth - Max recursion depth for nested MSGs (default: 3)
 * @returns {{ metadata: Object, attachments: Array<{filename, contentType, size, content}> }}
 */
export function parseMsg(msgBuffer, opts = {}) {
    const {
        skipImages = true,
        maxAttachmentSize = 100 * 1024 * 1024,
        maxDepth = 3,
    } = opts;

    return parseMsgInner(msgBuffer, { skipImages, maxAttachmentSize, maxDepth, depth: 0 });
}

function parseMsgInner(msgBuffer, opts) {
    const { skipImages, maxAttachmentSize, maxDepth, depth } = opts;

    // msgreader expects ArrayBuffer
    const arrayBuffer = msgBuffer.buffer.slice(
        msgBuffer.byteOffset,
        msgBuffer.byteOffset + msgBuffer.byteLength
    );
    // MsgReader import resolves differently in Node (object with .default) vs vitest (direct class)
    const MsgReaderClass = typeof MsgReader === 'function' ? MsgReader : MsgReader.default;
    const reader = new MsgReaderClass(arrayBuffer);
    const fields = reader.getFileData();

    if (fields.error) {
        throw new Error(`MSG parse error: ${fields.error}`);
    }

    // ═══════════════════════════════════════════════════
    // Email metadata
    // ═══════════════════════════════════════════════════
    const subject = fields.subject || '(no subject)';
    const body = fields.body || '';

    // Sender — try SMTP address first, fall back to EX-type
    const senderName = fields.senderName || '';
    const senderEmail = fields.senderSmtpAddress
        || fields.creatorSMTPAddress
        || fields.senderEmail
        || '';
    const from = senderName && senderEmail
        ? `${senderName} <${senderEmail}>`
        : senderEmail || senderName || '';

    // Recipients
    const recipients = fields.recipients || [];
    const toAddrs = recipients.filter(r => (r.recipType || '').toLowerCase() === 'to');
    const ccAddrs = recipients.filter(r => (r.recipType || '').toLowerCase() === 'cc');
    const bccAddrs = recipients.filter(r => (r.recipType || '').toLowerCase() === 'bcc');

    const formatRecipients = (list) => list.map(r => {
        const email = r.smtpAddress || r.email || '';
        const name = r.name || '';
        return name && email ? `${name} <${email}>` : email || name;
    }).join(', ');

    const to = formatRecipients(toAddrs);
    const cc = formatRecipients(ccAddrs);
    const bcc = formatRecipients(bccAddrs);

    // Dates
    const emailDate = fields.messageDeliveryTime || fields.clientSubmitTime || null;

    // Message ID from transport headers
    let messageId = null;
    let inReplyTo = null;
    let references = '';
    let headersRaw = null;

    if (fields.headers) {
        headersRaw = fields.headers;
        // Parse message-id from headers
        const msgIdMatch = fields.headers.match(/^Message-ID:\s*<?([^>\r\n]+)>?/mi);
        if (msgIdMatch) messageId = cleanId(msgIdMatch[1].trim());

        const replyMatch = fields.headers.match(/^In-Reply-To:\s*<?([^>\r\n]+)>?/mi);
        if (replyMatch) inReplyTo = cleanId(replyMatch[1].trim());

        const refsMatch = fields.headers.match(/^References:\s*(.+?)(?:\r?\n(?!\s))/mis);
        if (refsMatch) {
            references = refsMatch[1].trim().split(/[\s,]+/)
                .filter(Boolean)
                .map(r => cleanId(r))
                .join(' ');
        }
    }

    // Parse Received headers for transport metadata
    let receivedChain = [];
    let originatingIp = null;
    let authResults = null;
    let serverInfo = null;
    let deliveryDate = null;

    if (fields.headers) {
        const receivedMatches = fields.headers.match(/^Received:\s*.+?(?=\r?\n(?![\t ]))/gms) || [];
        receivedChain = parseReceivedHeaders(receivedMatches);

        const origIpMatch = fields.headers.match(/^X-Originating-IP:\s*\[?([^\]\r\n]+)/mi);
        if (origIpMatch) originatingIp = origIpMatch[1].trim();

        const authMatch = fields.headers.match(/^Authentication-Results:\s*(.+?)(?:\r?\n(?!\s))/mis);
        if (authMatch) authResults = authMatch[1].trim();

        serverInfo = receivedChain.length > 0 ? receivedChain[0].by || null : null;
        deliveryDate = receivedChain.length > 0
            ? receivedChain[receivedChain.length - 1].date || null
            : null;
    }

    // ═══════════════════════════════════════════════════
    // Attachments
    // ═══════════════════════════════════════════════════
    const attachments = [];
    const msgAttachments = fields.attachments || [];

    for (const attField of msgAttachments) {
        try {
            // Skip hidden/inline attachments (CID-referenced images in HTML body)
            if (attField.attachmentHidden) continue;

            // Handle nested MSG (embedded email inside an embedded email)
            if (attField.innerMsgContent) {
                if (depth < maxDepth && attField.innerMsgContentFields) {
                    // We could recurse, but for now just skip nested MSGs and log
                    // The nested MSG's attachments would need their own email record
                    console.log(`  [msg-parser] Skipping nested MSG at depth ${depth + 1}: ${attField.name || '(unnamed)'}`);
                }
                continue;
            }

            const attData = reader.getAttachment(attField);
            if (!attData || !attData.content) continue;

            const filename = attData.fileName || attField.fileName || attField.fileNameShort || attField.name || `attachment_${attachments.length}`;
            const ext = (filename.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
            const extWithDot = ext ? `.${ext}` : '';

            // Skip images if requested
            if (skipImages && SKIP_EXTS.has(extWithDot)) continue;

            // Skip oversized attachments
            const content = Buffer.from(attData.content);
            if (content.length > maxAttachmentSize) {
                console.log(`  [msg-parser] Skipping oversized attachment: ${filename} (${(content.length / 1e6).toFixed(1)}MB)`);
                continue;
            }

            // Infer MIME type from extension
            const contentType = mimeFromExt(extWithDot);

            attachments.push({
                filename,
                contentType,
                size: content.length,
                content,
            });
        } catch (err) {
            console.warn(`  [msg-parser] Error reading attachment: ${err.message}`);
        }
    }

    return {
        metadata: {
            subject,
            from,
            to,
            cc,
            bcc,
            date: emailDate,
            messageId,
            inReplyTo,
            references,
            textBody: body,
            headersRaw,
            receivedChain: JSON.stringify(receivedChain),
            originatingIp,
            authResults,
            serverInfo,
            deliveryDate,
        },
        attachments,
    };
}

function mimeFromExt(ext) {
    const map = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
        '.rtf': 'application/rtf',
        '.odt': 'application/vnd.oasis.opendocument.text',
        '.eml': 'message/rfc822',
        '.msg': 'application/vnd.ms-outlook',
        '.htm': 'text/html',
        '.html': 'text/html',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.7z': 'application/x-7z-compressed',
    };
    return map[ext] || 'application/octet-stream';
}

export { mimeFromExt };
