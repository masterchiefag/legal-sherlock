import fs from 'fs';
import path from 'path';

/**
 * Extract text content from uploaded files.
 * Supports: .pdf, .docx, .txt
 */
export async function extractText(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();

    try {
        if (ext === '.txt' || ext === '.csv' || ext === '.md') {
            return fs.readFileSync(filePath, 'utf-8');
        }

        if (ext === '.pdf') {
            const pdfParse = (await import('pdf-parse')).default;
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            return data.text;
        }

        if (ext === '.docx') {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        }

        // Skip binary/media files that have no extractable text
        const skipExts = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
            '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv', '.webm',
            '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
            '.exe', '.dll', '.so', '.dylib', '.bin',
            '.xls', '.xlsx', '.ppt', '.pptx', '.doc',
        ]);
        if (skipExts.has(ext)) {
            return '';
        }

        // Fallback: try reading as text for unknown but potentially text-based formats
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        console.error(`Text extraction failed for ${filePath}:`, err.message);
        return `[Extraction failed: ${err.message}]`;
    }
}

/**
 * Extract document metadata from uploaded files.
 * Supports: .pdf, .docx
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
    };

    try {
        if (ext === '.pdf') {
            return await extractPdfMetadata(filePath, meta);
        }

        if (ext === '.docx') {
            return await extractDocxMetadata(filePath, meta);
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
    meta.author = extractXmlTag(xml, 'dc:creator') || extractXmlTag(xml, 'cp:lastModifiedBy');
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
