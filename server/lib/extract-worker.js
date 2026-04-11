/**
 * Subprocess extraction worker.
 * Receives a file path + mime type via argv, extracts text, prints to stdout.
 * Used by pst-worker to enforce real OS-level timeouts on CPU-bound parsers
 * (mammoth, pdf-parse, xlsx) that block the event loop and defeat Promise.race.
 */
import { extractText, extractMetadata, extractTextWithOcrInfo } from './extract.js';

const filePath = process.argv[2];
const mimeType = process.argv[3];
const mode = process.argv[4] || 'text'; // 'text', 'meta', or 'textocr'

// For textocr mode, redirect console.log/warn to stderr so stdout stays clean JSON
if (mode === 'textocr' || mode === 'meta') {
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
    console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');
}

try {
    if (mode === 'meta') {
        const meta = await extractMetadata(filePath, mimeType);
        process.stdout.write(JSON.stringify(meta));
    } else if (mode === 'textocr') {
        const result = await extractTextWithOcrInfo(filePath, mimeType);
        process.stdout.write(JSON.stringify(result));
    } else {
        const text = await extractText(filePath, mimeType);
        process.stdout.write(text || '');
    }
} catch (e) {
    process.stderr.write(e.message);
    process.exit(1);
}
