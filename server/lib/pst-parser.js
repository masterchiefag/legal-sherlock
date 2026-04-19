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
 * Classify a MAPI PR_MESSAGE_CLASS string into the Sherlock doc_type bucket.
 * Used by pst-worker Phase 1.3 to ingest non-IPM.Note items that readpst drops.
 *
 * Returns one of: 'email' | 'calendar' | 'task' | 'note' | 'contact' | 'other'.
 * 'email' is reported for anything we already ingest via the readpst/.eml path,
 * so Phase 1.3 knows to skip it (Phase 1 has the better version).
 *
 * @param {string} messageClass - Raw PR_MESSAGE_CLASS like 'IPM.Appointment'
 * @returns {'email'|'calendar'|'task'|'note'|'contact'|'other'}
 */
export function classifyMapiMessage(messageClass) {
    if (!messageClass || typeof messageClass !== 'string') return 'other';
    const c = messageClass.toUpperCase();
    // Regular mail — already covered by readpst.
    if (c === 'IPM.NOTE' || c.startsWith('IPM.NOTE.SMIME') || c === 'IPM' || c === '') return 'email';
    // Calendar + meeting requests (meeting requests ARE a kind of mail in MAPI,
    // but readpst handles IPM.Note better, so only pure appointments here).
    if (c === 'IPM.APPOINTMENT' || c.startsWith('IPM.APPOINTMENT.')) return 'calendar';
    if (c.startsWith('IPM.SCHEDULE.MEETING')) return 'calendar';
    // Tasks
    if (c === 'IPM.TASK' || c.startsWith('IPM.TASK.') || c.startsWith('IPM.TASKREQUEST')) return 'task';
    // Notes / sticky notes / journal
    if (c === 'IPM.STICKYNOTE' || c.startsWith('IPM.STICKYNOTE.')) return 'note';
    if (c === 'IPM.ACTIVITY' || c.startsWith('IPM.ACTIVITY.')) return 'note';
    // Contacts / address-book entries
    if (c === 'IPM.CONTACT' || c.startsWith('IPM.CONTACT.') || c === 'IPM.DISTLIST') return 'contact';
    return 'other';
}

/**
 * Walk the PST and yield MAPI items whose message-class ISN'T a regular email.
 * Returns an array of records — each suitable for insertion as a Sherlock
 * 'calendar' / 'task' / 'note' / 'contact' document. See classifyMapiMessage()
 * for the class → doc_type mapping.
 *
 * Recipients, attendees, and body are pulled via the same API the existing
 * extractEmailData() uses. Attachments are not extracted here — they're
 * handled elsewhere if needed (most non-email MAPI items have none).
 *
 * @param {string} filePath - Absolute path to the .pst file
 * @returns {Array<{
 *   docType: 'calendar'|'task'|'note'|'contact',
 *   mapiClass: string,
 *   messageId: string | null,
 *   subject: string,
 *   body: string,
 *   from: string,         // "Name <email>" or "email" or ""
 *   to: string, cc: string, bcc: string,
 *   folderPath: string,
 *   clientSubmitTime: string | null,
 *   eventStartAt: string | null,
 *   eventEndAt: string | null,
 *   eventLocation: string | null,
 * }>}
 */
export function extractNonEmailMapi(filePath) {
    const pstFile = new PSTFile(filePath);
    const out = [];

    function walkFolder(folder, folderPath) {
        if (folder.contentCount > 0) {
            let msg = folder.getNextChild();
            while (msg) {
                if (msg instanceof PSTMessage) {
                    try {
                        const bucket = classifyMapiMessage(msg.messageClass || '');
                        if (bucket !== 'email' && bucket !== 'other') {
                            out.push(mapiToRecord(msg, bucket, folderPath));
                        }
                    } catch (err) {
                        console.warn(`[pst-parser] extractNonEmailMapi: failed on one message: ${err.message}`);
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
    return out;
}

function mapiToRecord(msg, docType, folderPath) {
    // Message-ID (rarely populated on non-mail items, but try anyway)
    let messageId = msg.internetMessageId || '';
    if (messageId) messageId = messageId.replace(/^</, '').replace(/>$/, '').trim();

    // Sender — applies to meeting requests + mail; calendar-only items may lack
    const from = msg.senderName
        ? (msg.senderEmailAddress
            ? `${msg.senderName} <${msg.senderEmailAddress}>`
            : msg.senderName)
        : msg.senderEmailAddress || '';

    // Dates. pst-extractor exposes various date fields depending on class.
    // Appointment start/end live on the msg for IPM.Appointment; task start/due
    // share the same property names on IPM.Task. We read defensively.
    let clientSubmitTime = null;
    try {
        if (msg.clientSubmitTime) clientSubmitTime = msg.clientSubmitTime.toISOString();
    } catch (_) { /* not set */ }

    let eventStartAt = null;
    try {
        // Appointment: appointmentStartWhole; Task: taskStartDate (field names per pst-extractor)
        const s = msg.appointmentStartWhole || msg.startDate || msg.taskStartDate;
        if (s && typeof s.toISOString === 'function') eventStartAt = s.toISOString();
    } catch (_) { /* defensive */ }

    let eventEndAt = null;
    try {
        const e = msg.appointmentEndWhole || msg.endDate || msg.taskDueDate;
        if (e && typeof e.toISOString === 'function') eventEndAt = e.toISOString();
    } catch (_) { /* defensive */ }

    let eventLocation = null;
    try {
        eventLocation = msg.location || msg.appointmentLocation || null;
    } catch (_) { /* defensive */ }

    return {
        docType,
        mapiClass: msg.messageClass || '',
        messageId: messageId || null,
        subject: msg.subject || '(no subject)',
        body: msg.body || '',
        from,
        to: msg.displayTo || '',
        cc: msg.displayCC || '',
        bcc: msg.displayBCC || '',
        folderPath,
        clientSubmitTime,
        eventStartAt,
        eventEndAt,
        eventLocation,
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

/**
 * Walk the PST and yield the raw multipart/signed MIME payload for every
 * IPM.Note.SMIME.MultipartSigned message.
 *
 * Background (GitHub issue #79): S/MIME-signed emails land in the PST with
 * `messageClass = IPM.Note.SMIME.MultipartSigned` and a single "attachment"
 * that wraps the entire signed MIME body (real body + real attachments + the
 * .p7s signature). Outlook clients render the inner body seamlessly. readpst's
 * `-e` extraction strips this wrapper — the .eml Sherlock ingests has the
 * plaintext body, but all real attachments are gone. pst-extractor reports
 * `numberOfAttachments = 1` but `attachSize` is `undefined`, which tricked our
 * earlier diagnostics into thinking the attachment was empty.
 *
 * The trick: `attachment.fileInputStream` yields the actual bytes (typically
 * 100 KB–5 MB), which are a STANDARD multipart/signed MIME body that
 * postal-mime can parse directly. The caller feeds our blob into postal-mime
 * and inserts the recovered attachments as children of the existing email.
 *
 * @param {string} filePath - Absolute path to the .pst file
 * @returns {Array<{
 *   messageId: string | null,  // lowercased, brackets stripped (matches our message_id column)
 *   folderPath: string,
 *   subject: string,
 *   mapiClass: string,
 *   blob: Buffer | null,      // raw multipart/signed bytes; null if read failed
 *   blobSize: number,
 * }>}
 */
export function extractSignedSmimeBlobs(filePath) {
    const pstFile = new PSTFile(filePath);
    const out = [];

    function walkFolder(folder, folderPath) {
        if (folder.contentCount > 0) {
            let msg = folder.getNextChild();
            while (msg) {
                if (msg instanceof PSTMessage) {
                    try {
                        const cls = msg.messageClass || '';
                        if (cls.toUpperCase().includes('SMIME.MULTIPARTSIGNED')) {
                            const rec = readSignedBlob(msg, folderPath);
                            if (rec) out.push(rec);
                        }
                    } catch (err) {
                        console.warn(`[pst-parser] extractSignedSmimeBlobs: failed on one message: ${err.message}`);
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
    return out;
}

/**
 * Helper for extractSignedSmimeBlobs(): read attachment 0's fileInputStream
 * into a Buffer. Returns null if the message has no attachment or the stream
 * fails to yield bytes.
 */
function readSignedBlob(msg, folderPath) {
    let mid = msg.internetMessageId || '';
    mid = mid.replace(/^</, '').replace(/>$/, '').trim().toLowerCase();

    // For MultipartSigned, the signed MIME body lives on attachment 0.
    // Shape: numberOfAttachments=1, attachSize=undefined, mimeTag='multipart/signed'.
    if (!msg.numberOfAttachments || msg.numberOfAttachments < 1) return null;
    let a;
    try { a = msg.getAttachment(0); } catch (_) { return null; }
    if (!a) return null;

    let stream;
    try { stream = a.fileInputStream; } catch (_) { return null; }
    if (!stream) return null;

    const chunks = [];
    const readBuf = Buffer.alloc(8192);
    let total = 0;
    try {
        let read;
        while ((read = stream.read(readBuf)) > 0) {
            chunks.push(Buffer.from(readBuf.subarray(0, read)));
            total += read;
        }
    } catch (_) { return null; }

    if (total === 0) return null;
    const blob = Buffer.concat(chunks, total);

    return {
        messageId: mid || null,
        folderPath: folderPath || '',
        subject: msg.subject || '',
        mapiClass: msg.messageClass || '',
        blob,
        blobSize: total,
    };
}
