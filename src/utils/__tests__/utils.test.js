import { describe, it, expect } from 'vitest';
import { formatSize, getScoreColor, getScoreLabel } from '../format.js';
import { escapeHtml, highlightText } from '../sanitize.js';

// ═══════════════════════════════════════════════════
// formatSize
// ═══════════════════════════════════════════════════
describe('formatSize', () => {
  it('returns dash for 0/null/undefined', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(null)).toBe('—');
    expect(formatSize(undefined)).toBe('—');
  });

  it('formats bytes', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(1073741824)).toBe('1.0 GB');
  });
});

// ═══════════════════════════════════════════════════
// getScoreColor / getScoreLabel
// ═══════════════════════════════════════════════════
describe('getScoreColor', () => {
  it('returns correct color for each score', () => {
    expect(getScoreColor(1)).toBe('#6b7280');
    expect(getScoreColor(5)).toBe('#ef4444');
  });

  it('returns default for unknown score', () => {
    expect(getScoreColor(99)).toBe('#6b7280');
  });
});

describe('getScoreLabel', () => {
  it('returns correct label for each score', () => {
    expect(getScoreLabel(1)).toBe('Not Relevant');
    expect(getScoreLabel(5)).toBe('Smoking Gun');
  });

  it('returns Unknown for invalid score', () => {
    expect(getScoreLabel(99)).toBe('Unknown');
  });
});

// ═══════════════════════════════════════════════════
// escapeHtml
// ═══════════════════════════════════════════════════
describe('escapeHtml', () => {
  it('returns empty for falsy input', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('escapes & < > " \'', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
    expect(escapeHtml("it's")).toBe('it&#x27;s');
  });

  it('handles mixed content', () => {
    expect(escapeHtml('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
  });
});

// ═══════════════════════════════════════════════════
// highlightText
// ═══════════════════════════════════════════════════
describe('highlightText', () => {
  it('returns empty for null text', () => {
    expect(highlightText(null, 'term')).toBe('');
  });

  it('returns escaped text when no search term', () => {
    expect(highlightText('<b>Hello</b>', '')).toBe('&lt;b&gt;Hello&lt;/b&gt;');
  });

  it('wraps matching words in <mark> tags', () => {
    const result = highlightText('The cat sat on the mat', 'cat');
    expect(result).toBe('The <mark>cat</mark> sat on the mat');
  });

  it('is case-insensitive', () => {
    const result = highlightText('Hello World', 'hello');
    expect(result).toBe('<mark>Hello</mark> World');
  });

  it('skips FTS operators', () => {
    const result = highlightText('The cat AND dog', 'cat AND dog');
    expect(result).toBe('The <mark>cat</mark> AND <mark>dog</mark>');
  });

  it('escapes HTML in text before highlighting', () => {
    const result = highlightText('<script>cat</script>', 'cat');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('<mark>cat</mark>');
  });

  it('handles special regex characters in search term', () => {
    const result = highlightText('price is $100.00', '$100.00');
    expect(result).toContain('<mark>$100.00</mark>');
  });
});
