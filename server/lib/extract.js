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

        // Fallback: try reading as text
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        console.error(`Text extraction failed for ${filePath}:`, err.message);
        return `[Extraction failed: ${err.message}]`;
    }
}
