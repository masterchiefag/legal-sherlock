const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
};

const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Highlight search terms in text content safely.
 * Escapes all HTML first, then wraps matches in <mark> tags.
 */
export function highlightText(text, searchTerm) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    if (!searchTerm?.trim()) return escaped;

    // Split search term into individual words, strip FTS operators and quotes
    const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
    const words = searchTerm.trim().split(/\s+/)
        .filter(Boolean)
        .filter(w => !FTS_OPERATORS.has(w.toUpperCase()))
        .map(w => w.replace(/^["']+|["']+$/g, ''))  // strip surrounding quotes
        .filter(w => w.length > 0);
    if (words.length === 0) return escaped;
    const safeWords = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = safeWords.join('|');
    return escaped.replace(
        new RegExp(`(${pattern})`, 'gi'),
        '<mark>$1</mark>'
    );
}
