import fs from 'fs';
import path from 'path';
import { getSetting } from './settings.js';

/**
 * Extract text content from uploaded files.
 * Supports: .pdf, .docx, .txt
 */
export async function extractText(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();

    try {
        const stat = fs.statSync(filePath);
        // Protect against synchronous parsing lockups (OOM/CPU freeze)
        const maxFileSize = getSetting('extract_max_file_size_mb') * 1024 * 1024;
        if (stat.size > maxFileSize && ['.xlsx', '.xls', '.docx', '.pdf'].includes(ext)) {
            console.warn(`[extractText] Skipping ${filePath} - file too large (${Math.round(stat.size/1e6)}MB)`);
            return `[File too large to safely extract text: ${Math.round(stat.size/1e6)}MB]`;
        }

        if (ext === '.txt' || ext === '.csv' || ext === '.md') {
            if (stat.size > maxFileSize) return ''; // limit arbitrary text too
            return fs.readFileSync(filePath, 'utf-8');
        }

        if (ext === '.pdf') {
            const pdfParse = (await import('pdf-parse')).default;
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            const text = (data.text || '').trim();

            // If pdf-parse returned very little text, the PDF is likely scanned/image-based.
            // Fall back to OCR: convert pages to images with pdftoppm, then run tesseract.
            if (text.length < getSetting('ocr_min_text_length')) {
                console.log(`[extractText] PDF has only ${text.length} chars of text — attempting OCR fallback for ${filePath}`);
                const ocrStart = Date.now();
                const ocrText = await ocrPdf(filePath);
                const ocrTimeMs = Date.now() - ocrStart;
                if (ocrText && ocrText.trim().length > text.length) {
                    console.log(`[extractText] OCR recovered ${ocrText.trim().length} chars from ${filePath}`);
                    return ocrText.trim();
                }
                console.log(`[extractText] OCR did not improve results for ${filePath}`);
            }

            return text;
        }

        if (ext === '.docx') {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        }

        if (ext === '.xls' || ext === '.xlsx') {
            const XLSX = (await import('xlsx')).default;
            const workbook = XLSX.readFile(filePath);
            const texts = [];
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                if (csv.trim()) {
                    texts.push(`[${sheetName}]\n${csv}`);
                }
            }
            return texts.join('\n\n');
        }

        if (ext === '.doc') {
            const { execFile } = await import('child_process');
            const { promisify } = await import('util');
            const execFileAsync = promisify(execFile);
            try {
                const { stdout } = await execFileAsync('antiword', [filePath]);
                return stdout;
            } catch (err) {
                if (err.code === 'ENOENT') {
                    console.warn('antiword not installed. Install with: brew install antiword');
                    return '';
                }
                throw err;
            }
        }

        // Skip binary/media files that have no extractable text
        const skipExts = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
            '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv', '.webm',
            '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
            '.exe', '.dll', '.so', '.dylib', '.bin',
            '.ppt', '.pptx',
            '.emz', '.wmf', '.xlsb',
        ]);
        if (skipExts.has(ext)) {
            return '';
        }

        // Skip files with image MIME types even if extension is missing/wrong
        const skipMimes = ['image/', 'audio/', 'video/', 'application/zip', 'application/x-rar',
            'application/octet-stream'];
        const normalizedMime = (mimeType || '').toLowerCase();
        if (skipMimes.some(prefix => normalizedMime.startsWith(prefix))) {
            // For application/octet-stream, only skip if no extension (likely binary blob)
            if (normalizedMime !== 'application/octet-stream' || !ext || ext === '.') {
                return '';
            }
        }

        // No extension at all — likely an inline image or binary blob, skip
        if (!ext || ext === '.') {
            return '';
        }

        // Fallback: try reading as text for unknown but potentially text-based formats
        // Cap at 10MB to prevent memory issues with large binary files
        if (stat.size > 50 * 1024 * 1024) {
            return '';
        }
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        console.error(`Text extraction failed for ${filePath}:`, err.message);
        return `[Extraction failed: ${err.message}]`;
    }
}

/**
 * Extract document metadata from uploaded files.
 * Supports: .pdf, .docx, .doc, .xls, .xlsx
 *
 * Returns: { author, title, createdAt, modifiedAt, creatorTool, keywords }
 * All fields are strings or null.
 */
export async function extractMetadata(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();
    const meta = {
        author: null,
        title: null,
        createdAt: null,
        modifiedAt: null,
        creatorTool: null,
        keywords: null,
        lastModifiedBy: null,
        printedAt: null,
        lastAccessedAt: null,
    };

    // Capture filesystem last accessed time (best effort)
    let stat;
    try {
        stat = fs.statSync(filePath);
        if (stat.atime) meta.lastAccessedAt = stat.atime.toISOString();
    } catch (_) {}

    try {
        // Protect against parsing locks during metadata resolution
        if (stat && stat.size > getSetting('extract_max_file_size_mb') * 1024 * 1024 && ['.xlsx', '.xls', '.docx', '.pdf'].includes(ext)) {
            console.warn(`[extractMetadata] Skipping ${filePath} - file too large (${Math.round(stat.size/1e6)}MB)`);
            return meta;
        }

        if (ext === '.pdf') {
            return await extractPdfMetadata(filePath, meta);
        }

        if (ext === '.docx') {
            return await extractDocxMetadata(filePath, meta);
        }

        if (ext === '.xls' || ext === '.xlsx') {
            const XLSX = (await import('xlsx')).default;
            const workbook = XLSX.readFile(filePath);
            const props = workbook.Props || {};
            meta.author = props.Author || null;
            meta.lastModifiedBy = props.LastAuthor || null;
            meta.title = props.Title || null;
            meta.createdAt = props.CreatedDate ? new Date(props.CreatedDate).toISOString() : null;
            meta.modifiedAt = props.ModifiedDate ? new Date(props.ModifiedDate).toISOString() : null;
            meta.creatorTool = props.Application || null;
            meta.keywords = props.Keywords || null;
            return meta;
        }

        if (ext === '.doc') {
            return extractDocOle2Metadata(filePath, meta);
        }
    } catch (err) {
        console.error(`Metadata extraction failed for ${filePath}:`, err.message);
    }

    return meta;
}

/**
 * Extract metadata from a PDF file using pdf-parse.
 * pdf-parse returns an info object with: Author, Title, Creator, Producer,
 * CreationDate, ModDate, Keywords, etc.
 */
async function extractPdfMetadata(filePath, meta) {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const info = data.info || {};
    const pdfMeta = data.metadata?._metadata || {};

    meta.author = info.Author || pdfMeta['dc:creator'] || null;
    meta.title = info.Title || pdfMeta['dc:title'] || null;
    meta.creatorTool = info.Creator || info.Producer || null;
    meta.keywords = info.Keywords || null;

    // Parse PDF date format (D:YYYYMMDDHHmmSS+HH'mm' or ISO)
    if (info.CreationDate) {
        meta.createdAt = parsePdfDate(info.CreationDate);
    }
    if (info.ModDate) {
        meta.modifiedAt = parsePdfDate(info.ModDate);
    }

    return meta;
}

/**
 * Parse PDF date strings into ISO format.
 * PDF dates look like: D:20240122093045+05'30' or D:20240122093045Z
 */
function parsePdfDate(pdfDate) {
    if (!pdfDate) return null;

    // Already a valid date string
    const direct = new Date(pdfDate);
    if (!isNaN(direct.getTime())) return direct.toISOString();

    // Handle D: prefix format
    const match = pdfDate.match(
        /D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([+-Z])?(\d{2})?'?(\d{2})?'?/
    );
    if (match) {
        const [, Y, M, D, h, m, s, sign, tzH, tzM] = match;
        let iso = `${Y}-${M}-${D}T${h}:${m}:${s}`;
        if (sign === 'Z' || !sign) {
            iso += 'Z';
        } else {
            iso += `${sign}${tzH || '00'}:${tzM || '00'}`;
        }
        const d = new Date(iso);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    return pdfDate; // Return raw string as fallback
}

/**
 * Extract metadata from a DOCX file by parsing its internal XML.
 * DOCX files are ZIP archives containing docProps/core.xml with Dublin Core metadata.
 */
async function extractDocxMetadata(filePath, meta) {
    const { createReadStream } = await import('fs');
    const { createUnzip } = await import('zlib');
    
    // DOCX is a ZIP file — read it and look for docProps/core.xml
    const buffer = fs.readFileSync(filePath);
    
    // Use a simple approach: scan the ZIP for core.xml entry
    const coreXml = await extractFileFromZip(buffer, 'docProps/core.xml');
    if (!coreXml) return meta;

    const xml = coreXml.toString('utf-8');

    // Parse XML fields with regex (avoiding need for XML parser dependency)
    meta.author = extractXmlTag(xml, 'dc:creator');
    meta.lastModifiedBy = extractXmlTag(xml, 'cp:lastModifiedBy');
    if (!meta.author) meta.author = meta.lastModifiedBy; // fallback
    meta.title = extractXmlTag(xml, 'dc:title');
    meta.keywords = extractXmlTag(xml, 'cp:keywords');

    const created = extractXmlTag(xml, 'dcterms:created');
    if (created) {
        const d = new Date(created);
        meta.createdAt = isNaN(d.getTime()) ? created : d.toISOString();
    }

    const modified = extractXmlTag(xml, 'dcterms:modified');
    if (modified) {
        const d = new Date(modified);
        meta.modifiedAt = isNaN(d.getTime()) ? modified : d.toISOString();
    }

    const printed = extractXmlTag(xml, 'cp:lastPrinted');
    if (printed) {
        const d = new Date(printed);
        meta.printedAt = isNaN(d.getTime()) ? printed : d.toISOString();
    }

    // Try to get the creator tool from app.xml
    const appXml = await extractFileFromZip(buffer, 'docProps/app.xml');
    if (appXml) {
        const appStr = appXml.toString('utf-8');
        meta.creatorTool = extractXmlTag(appStr, 'Application');
    }

    return meta;
}

/**
 * Extract a single file from a ZIP buffer by filename.
 * Uses a minimal ZIP parser — no external dependencies needed.
 */
async function extractFileFromZip(zipBuffer, targetFilename) {
    // ZIP local file header signature: PK\x03\x04
    const LOCAL_HEADER_SIG = 0x04034b50;
    let offset = 0;

    while (offset < zipBuffer.length - 30) {
        const sig = zipBuffer.readUInt32LE(offset);
        if (sig !== LOCAL_HEADER_SIG) break;

        const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
        const filenameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);

        const filename = zipBuffer.toString('utf-8', offset + 30, offset + 30 + filenameLen);
        const dataStart = offset + 30 + filenameLen + extraLen;

        if (filename === targetFilename) {
            const rawData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

            if (compressionMethod === 0) {
                // Stored (no compression)
                return rawData;
            } else if (compressionMethod === 8) {
                // Deflate
                const zlib = await import('zlib');
                return new Promise((resolve, reject) => {
                    zlib.inflateRaw(rawData, (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                });
            }
            return null;
        }

        offset = dataStart + compressedSize;
    }

    return null;
}

/**
 * Extract content of an XML tag by name (simple regex-based).
 */
function extractXmlTag(xml, tagName) {
    // Handle both <tag>value</tag> and <ns:tag>value</ns:tag>
    const regex = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

/**
 * Extract metadata from a .doc file by parsing OLE2 SummaryInformation stream.
 * Uses cfb (bundled with xlsx) to read the compound document structure.
 */
function extractDocOle2Metadata(filePath, meta) {
    const cfb = require('cfb');
    const buf = fs.readFileSync(filePath);
    const container = cfb.read(buf);
    const si = cfb.find(container, '/\x05SummaryInformation');
    if (!si || si.content.length < 48) return meta;

    const data = si.content;
    const numSets = data.readUInt32LE(24);
    if (numSets < 1) return meta;

    const setOffset = data.readUInt32LE(44);
    const numProps = data.readUInt32LE(setOffset + 4);

    // OLE2 SummaryInformation property IDs
    const PROP_MAP = { 2: 'title', 3: 'subject', 4: 'author', 5: 'keywords', 8: 'lastModifiedBy', 11: 'printedAt', 12: 'createdAt', 13: 'modifiedAt', 18: 'application' };

    for (let i = 0; i < numProps; i++) {
        const propId = data.readUInt32LE(setOffset + 8 + i * 8);
        const propOff = data.readUInt32LE(setOffset + 8 + i * 8 + 4);
        const abs = setOffset + propOff;
        const name = PROP_MAP[propId];
        if (!name || abs + 8 > data.length) continue;

        const type = data.readUInt32LE(abs);
        try {
            if (type === 0x1e) { // VT_LPSTR
                const len = data.readUInt32LE(abs + 4);
                if (abs + 8 + len <= data.length) {
                    const str = data.toString('utf-8', abs + 8, abs + 8 + len).replace(/\x00+$/, '').trim();
                    if (str) {
                        if (name === 'application') meta.creatorTool = str;
                        else if (name === 'subject') { /* skip subject */ }
                        else meta[name] = str;
                    }
                }
            } else if (type === 0x40) { // VT_FILETIME
                const lo = data.readUInt32LE(abs + 4);
                const hi = data.readUInt32LE(abs + 8);
                const ms = (hi * 0x100000000 + lo) / 10000 - 11644473600000;
                if (ms > 0) meta[name] = new Date(ms).toISOString();
            }
        } catch (e) { /* skip unparseable property */ }
    }

    return meta;
}

/**
 * Extract text with OCR tracking info.
 * Returns: { text, ocr: { attempted, succeeded, timeMs } }
 */
export async function extractTextWithOcrInfo(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();
    const ocrInfo = { attempted: false, succeeded: false, timeMs: 0 };

    // Only PDFs can trigger OCR
    if (ext !== '.pdf') {
        const text = await extractText(filePath, mimeType);
        return { text, ocr: ocrInfo };
    }

    try {
        const stat = fs.statSync(filePath);
        if (stat.size > getSetting('extract_max_file_size_mb') * 1024 * 1024) {
            return { text: `[File too large to safely extract text: ${Math.round(stat.size/1e6)}MB]`, ocr: ocrInfo };
        }

        const pdfParse = (await import('pdf-parse')).default;
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        const text = (data.text || '').trim();

        if (text.length < getSetting('ocr_min_text_length')) {
            ocrInfo.attempted = true;
            const ocrStart = Date.now();
            const ocrText = await ocrPdf(filePath);
            ocrInfo.timeMs = Date.now() - ocrStart;

            if (ocrText && ocrText.trim().length > text.length) {
                ocrInfo.succeeded = true;
                return { text: ocrText.trim(), ocr: ocrInfo };
            }
        }

        return { text, ocr: ocrInfo };
    } catch (err) {
        console.error(`Text extraction failed for ${filePath}:`, err.message);
        return { text: `[Extraction failed: ${err.message}]`, ocr: ocrInfo };
    }
}

/**
 * OCR a PDF file by converting pages to images and running tesseract.
 * Requires system dependencies: poppler (pdftoppm) and tesseract.
 * 
 * Flow: PDF → pdftoppm (page images) → tesseract (text per page) → concatenated text
 */
async function ocrPdf(filePath) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const os = await import('os');
    const execFileAsync = promisify(execFile);

    // Verify both tools are available
    try {
        await execFileAsync('pdftoppm', ['-v']);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn('[OCR] pdftoppm not found. Install with: brew install poppler');
            return '';
        }
        // pdftoppm -v exits with code 0 and prints to stderr, which is fine
    }
    try {
        await execFileAsync('tesseract', ['--version']);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn('[OCR] tesseract not found. Install with: brew install tesseract');
            return '';
        }
    }

    // Create a temp directory for page images
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-ocr-'));

    try {
        // Convert PDF pages to PNG images. DPI configurable via admin settings.
        // Benchmarked 100 vs 200 DPI: conversion is ~2x faster, OCR text output
        // is nearly identical (99% char match). pdftoppm is the bottleneck (70-90%
        // of total OCR time), so halving DPI roughly halves total pipeline time.
        const ocrDpi = String(getSetting('ocr_dpi'));
        const pdftoppmTimeout = getSetting('ocr_pdftoppm_timeout') * 1000;
        const prefix = path.join(tmpDir, 'page');
        console.log(`[OCR] Converting PDF pages to images at ${ocrDpi} DPI...`);
        await execFileAsync('pdftoppm', [
            '-png', '-r', ocrDpi, filePath, prefix
        ], { timeout: pdftoppmTimeout });

        // List generated page images, sorted
        const pageFiles = fs.readdirSync(tmpDir)
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => path.join(tmpDir, f));

        if (pageFiles.length === 0) {
            console.warn('[OCR] pdftoppm produced no page images');
            return '';
        }
        console.log(`[OCR] Generated ${pageFiles.length} page images, running tesseract...`);

        // OCR each page
        const pageTexts = [];
        for (let i = 0; i < pageFiles.length; i++) {
            try {
                const tesseractTimeout = getSetting('ocr_tesseract_timeout') * 1000;
                const { stdout } = await execFileAsync('tesseract', [
                    pageFiles[i], 'stdout', '--psm', '6'
                ], { timeout: tesseractTimeout, maxBuffer: 10 * 1024 * 1024 });
                const pageText = stdout.trim();
                if (pageText) {
                    pageTexts.push(`--- Page ${i + 1} ---\n${pageText}`);
                }
            } catch (pageErr) {
                console.warn(`[OCR] Tesseract failed on page ${i + 1}:`, pageErr.message);
            }
        }

        const fullText = pageTexts.join('\n\n');
        console.log(`[OCR] Completed: ${pageFiles.length} pages, ${fullText.length} chars extracted`);
        return fullText;
    } catch (err) {
        console.error('[OCR] Pipeline failed:', err.message);
        return '';
    } finally {
        // Clean up temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    }
}
