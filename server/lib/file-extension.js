/**
 * Shared MIME-to-extension mapping and file extension resolution.
 * Used at ingestion time (workers) and for backfill migration.
 */

export const MIME_TO_EXT = {
    // Calendar
    'text/calendar': 'ics',
    // Email
    'message/rfc822': 'eml',
    'application/vnd.ms-outlook': 'msg',
    'application/x-msg': 'msg',
    // Documents
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/rtf': 'rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    // Text
    'text/plain': 'txt',
    'text/html': 'html',
    'text/csv': 'csv',
    'text/xml': 'xml',
    'application/xml': 'xml',
    'application/json': 'json',
    // Images
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    // Archives
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z',
    'application/gzip': 'gz',
    // Audio/Video
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    // Misc
    'application/vnd.visio': 'vsd',
    'application/vnd.ms-project': 'mpp',
};

/**
 * Resolve file extension from available signals.
 * Priority: original_name > MIME type > disk filename.
 * Returns extension without dot (e.g., 'pdf', 'docx') or '' if unknown.
 *
 * @param {string|null} originalName - Original filename (may be corrupted by readpst)
 * @param {string|null} mimeType - MIME type from email parser
 * @param {string|null} diskFilename - On-disk filename (UUID-based, usually has correct ext)
 * @returns {string}
 */
export function resolveFileExtension(originalName, mimeType, diskFilename) {
    // 1. Try original_name extension
    if (originalName?.includes('.')) {
        const ext = originalName.split('.').pop().toLowerCase().trim();
        if (ext && ext.length <= 10 && /^[a-z0-9]+$/.test(ext)) return ext;
    }
    // 2. Try MIME type mapping
    if (mimeType && MIME_TO_EXT[mimeType]) return MIME_TO_EXT[mimeType];
    // 3. Try disk filename extension
    if (diskFilename?.includes('.')) {
        const ext = diskFilename.split('.').pop().toLowerCase().trim();
        if (ext && ext.length <= 10 && /^[a-z0-9]+$/.test(ext)) return ext;
    }
    return '';
}
