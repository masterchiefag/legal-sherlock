import pkg from 'pst-extractor';
const { PSTFile, PSTFolder, PSTMessage } = pkg;

/**
 * Parse a .pst file and extract all email messages with metadata and attachments.
 * 
 * Walks the entire PST folder tree and yields each email as a structured object
 * identical to the output of parseEml().
 * 
 * @param {string} filePath - Absolute path to the .pst file
 * @returns {Array} Array of parsed email objects
 */
export function parsePst(filePath) {
    const pstFile = new PSTFile(filePath);
    const emails = [];

    function walkFolder(folder) {
        // Process emails in this folder
        if (folder.contentCount > 0) {
            let email = folder.getNextChild();
            while (email) {
                if (email instanceof PSTMessage) {
                    try {
                        const parsed = extractEmailData(email);
                        emails.push(parsed);
                    } catch (err) {
                        console.error(`⚠ Failed to extract email: ${err.message}`);
                    }
                }
                email = folder.getNextChild();
            }
        }

        // Recurse into subfolders
        if (folder.hasSubfolders) {
            const subFolders = folder.getSubFolders();
            for (const sub of subFolders) {
                walkFolder(sub);
            }
        }
    }

    walkFolder(pstFile.getRootFolder());
    return emails;
}

/**
 * Lightweight PST walk: collects only identity + authoritative date fields,
 * no body or attachment reads. Used by pst-worker Phase 1.2 to correct
 * readpst's unreliable RFC822 Date: header against MAPI's PR_CLIENT_SUBMIT_TIME.
 *
 * See GitHub issue #65. On Yesha's 30 GB PST this walk completes in ~8 min;
 * a full parsePst() read would take ~30 min because of attachment extraction.
 *
 * @param {string} filePath - Absolute path to the .pst file
 * @returns {Array<{messageId: string | null, clientSubmitTime: string | null,
 *                   messageDeliveryTime: string | null, messageClass: string,
 *                   folderPath: string, subject: string, senderEmail: string}>}
 */
export function collectAuthoritativeDates(filePath) {
    const pstFile = new PSTFile(filePath);
    const results = [];

    function walkFolder(folder, folderPath) {
        if (folder.contentCount > 0) {
            let msg = folder.getNextChild();
            while (msg) {
                if (msg instanceof PSTMessage) {
                    try {
                        let mid = msg.internetMessageId || '';
                        mid = mid.replace(/^</, '').replace(/>$/, '').trim().toLowerCase();

                        let clientSubmit = null;
                        try {
                            if (msg.clientSubmitTime) clientSubmit = msg.clientSubmitTime.toISOString();
                        } catch (_) { /* not set on this message */ }

                        let delivery = null;
                        try {
                            if (msg.messageDeliveryTime) delivery = msg.messageDeliveryTime.toISOString();
                        } catch (_) { /* not set */ }

                        results.push({
                            messageId: mid || null,
                            clientSubmitTime: clientSubmit,
                            messageDeliveryTime: delivery,
                            messageClass: msg.messageClass || '',
                            folderPath,
                            subject: msg.subject || '',
                            senderEmail: (msg.senderEmailAddress || '').toLowerCase(),
                        });
                    } catch (err) {
                        console.warn(`[pst-parser] collectAuthoritativeDates: failed on one message: ${err.message}`);
                    }
                }
                msg = folder.getNextChild();
            }
        }
        if (folder.hasSubfolders) {
            for (const sub of folder.getSubFolders()) {
                const nextPath = folderPath ? `${folderPath}/${sub.displayName}` : (sub.displayName || '');
                walkFolder(sub, nextPath);
            }
        }
    }

    walkFolder(pstFile.getRootFolder(), '');
    return results;
}

/**
 * Extract structured data from a single PSTMessage, including transport metadata.
 */
function extractEmailData(msg) {
    const from = msg.senderName
        ? (msg.senderEmailAddress
            ? `${msg.senderName} <${msg.senderEmailAddress}>`
            : msg.senderName)
        : msg.senderEmailAddress || '';

    // Extract Message-ID from internet headers or from the property
    let messageId = msg.internetMessageId || '';
    if (messageId) {
        messageId = messageId.replace(/^</, '').replace(/>$/, '').trim();
    }

    let inReplyTo = msg.inReplyToId || '';
    if (inReplyTo) {
        inReplyTo = inReplyTo.replace(/^</, '').replace(/>$/, '').trim();
    }

    // ═══════════════════════════════════════════════════
    // Transport headers & server metadata
    // ═══════════════════════════════════════════════════
    const headers = msg.transportMessageHeaders || '';

    // Parse References from transport headers
    let references = '';
    const refMatch = headers.match(/^References:\s*(.+?)(?:\r?\n(?!\s))/ms);
    if (refMatch) {
        references = refMatch[1].replace(/[\r\n\s]+/g, ' ').trim();
    }

    // Parse Received headers into structured hop chain
    const receivedChain = parseReceivedFromHeaders(headers);

    // X-Originating-IP
    const ipMatch = headers.match(/^X-Originating-IP:\s*\[?([\d.]+)\]?/mi);
    const originatingIp = ipMatch ? ipMatch[1] : null;

    // Authentication-Results
    const authMatch = headers.match(/^Authentication-Results:\s*(.+?)(?:\r?\n(?!\s))/ms);
    const authResults = authMatch ? authMatch[1].replace(/[\r\n\s]+/g, ' ').trim() : null;

    // Sending server from first Received header
    const serverInfo = receivedChain.length > 0 ? receivedChain[0].by || null : null;

    // Delivery date — use messageDeliveryTime property or last Received header date
    let deliveryDate = null;
    try {
        if (msg.messageDeliveryTime) {
            deliveryDate = msg.messageDeliveryTime.toISOString();
        }
    } catch (_) { /* property may not exist on all messages */ }
    if (!deliveryDate && receivedChain.length > 0) {
        deliveryDate = receivedChain[receivedChain.length - 1].date || null;
    }

    // Extract attachments
    const attachments = [];
    const numAttachments = msg.numberOfAttachments;
    for (let i = 0; i < numAttachments; i++) {
        try {
            const att = msg.getAttachment(i);
            if (!att) continue;

            const filename = att.longFilename || att.filename || `attachment_${i}`;
            const contentType = att.mimeTag || 'application/octet-stream';
            const size = att.attachSize || 0;

            // Read attachment content into a buffer accurately bounded to avoid Infinite Loops
            const streamLength = att.fileInputStream?.length?.toNumber() || 0;
            const buffers = [];
            let totalWritten = 0;

            if (streamLength > 0) {
                while (totalWritten < streamLength) {
                    const remaining = streamLength - totalWritten;
                    const chunkSize = Math.min(8176, remaining);
                    const buf = Buffer.alloc(chunkSize);
                    
                    att.fileInputStream?.read(buf);
                    buffers.push(buf);
                    totalWritten += chunkSize;
                }
            }

            const content = Buffer.concat(buffers);

            attachments.push({
                filename,
                contentType,
                size: content.length || size,
                content,
            });
        } catch (err) {
            console.error(`⚠ Failed to extract attachment ${i}: ${err.message}`);
        }
    }

    return {
        messageId: messageId || null,
        inReplyTo: inReplyTo || null,
        references,
        from,
        to: msg.displayTo || '',
        cc: msg.displayCC || '',
        bcc: msg.displayBCC || '',
        subject: msg.subject || '(no subject)',
        date: msg.clientSubmitTime ? msg.clientSubmitTime.toISOString() : null,
        textBody: msg.body || '',
        htmlBody: msg.bodyHTML || '',
        // Transport metadata
        headersRaw: headers,
        receivedChain: JSON.stringify(receivedChain),
        originatingIp,
        authResults,
        serverInfo,
        deliveryDate,
        attachments,
    };
}

/**
 * Parse Received headers from raw transport headers string.
 * Returns array of hop objects: { from, by, with, date, ip }
 */
function parseReceivedFromHeaders(headersStr) {
    if (!headersStr) return [];

    const hops = [];
    // Match all Received: header blocks (may span multiple lines via folding)
    const receivedRegex = /^Received:\s*([\s\S]+?)(?=\r?\n(?:[\w-]+:|$))/gmi;
    let match;

    while ((match = receivedRegex.exec(headersStr)) !== null) {
        const str = match[1].replace(/\r?\n\s+/g, ' ').trim();
        const hop = {};

        const fromMatch = str.match(/from\s+(\S+)/i);
        if (fromMatch) hop.from = fromMatch[1];

        const byMatch = str.match(/by\s+(\S+)/i);
        if (byMatch) hop.by = byMatch[1];

        const withMatch = str.match(/with\s+(\S+)/i);
        if (withMatch) hop.with = withMatch[1];

        const dateMatch = str.match(/;\s*(.+)$/);
        if (dateMatch) {
            const d = new Date(dateMatch[1].trim());
            hop.date = isNaN(d.getTime()) ? dateMatch[1].trim() : d.toISOString();
        }

        const ipMatch = str.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
        if (ipMatch) hop.ip = ipMatch[1];

        hops.push(hop);
    }

    return hops;
}
