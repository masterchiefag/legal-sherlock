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
 * Extract structured data from a single PSTMessage.
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

    // Parse References from transport headers
    let references = '';
    const headers = msg.transportMessageHeaders || '';
    const refMatch = headers.match(/^References:\s*(.+?)(?:\r?\n(?!\s))/ms);
    if (refMatch) {
        references = refMatch[1].replace(/[\r\n\s]+/g, ' ').trim();
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

            // Read attachment content into a buffer
            const buffers = [];
            const blockSize = 8176;
            let offset = 0;
            let bytesRead;
            do {
                const buf = Buffer.alloc(blockSize);
                bytesRead = att.fileInputStream?.read(buf) || 0;
                if (bytesRead > 0) {
                    buffers.push(buf.subarray(0, bytesRead));
                    offset += bytesRead;
                }
            } while (bytesRead === blockSize);

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
        attachments,
    };
}
