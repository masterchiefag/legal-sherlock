/**
 * Sub-worker: long-lived parser thread.
 * Receives .eml file paths via parentPort messages, returns parsed data.
 * Stays alive until sent a 'done' message.
 */
import { parentPort } from 'worker_threads';
import { parseEml } from '../lib/eml-parser.js';

parentPort.on('message', async (msg) => {
    if (msg === 'done') {
        process.exit(0);
    }

    const { emlPath, index } = msg;
    try {
        const result = await parseEml(emlPath);

        // Convert attachment buffers to base64 for transfer across threads
        const attachments = result.attachments.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            content: att.content.toString('base64'),
        }));

        parentPort.postMessage({
            ok: true,
            index,
            data: { ...result, attachments },
        });
    } catch (err) {
        parentPort.postMessage({
            ok: false,
            index,
            error: err.message,
        });
    }
});
