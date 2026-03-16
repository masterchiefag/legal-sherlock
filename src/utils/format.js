export function formatSize(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function getScoreColor(score) {
    const colors = { 1: '#6b7280', 2: '#3b82f6', 3: '#f59e0b', 4: '#f97316', 5: '#ef4444' };
    return colors[score] || '#6b7280';
}

export function getScoreLabel(score) {
    const labels = { 1: 'Not Relevant', 2: 'Unlikely Relevant', 3: 'Potentially Relevant', 4: 'Highly Relevant', 5: 'Smoking Gun' };
    return labels[score] || 'Unknown';
}
