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

    const safeSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(
        new RegExp(`(${safeSearch})`, 'gi'),
        '<mark>$1</mark>'
    );
}
