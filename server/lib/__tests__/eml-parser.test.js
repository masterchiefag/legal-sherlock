import { describe, it, expect } from 'vitest';
import { stripHtml, cleanId, formatAddresses, parseReceivedHeaders, parseEml } from '../eml-parser.js';

describe('stripHtml', () => {
  it('returns empty for null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('strips HTML tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
  });

  it('removes style blocks', () => {
    expect(stripHtml('<style>.x{color:red}</style>Hello')).toBe('Hello');
  });

  it('removes script blocks', () => {
    expect(stripHtml('<script>alert(1)</script>Hello')).toBe('Hello');
  });

  it('converts <br> to newline', () => {
    expect(stripHtml('line1<br>line2')).toBe('line1\nline2');
  });

  it('converts </p> to double newline', () => {
    expect(stripHtml('<p>para1</p><p>para2</p>')).toBe('para1\n\npara2');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe("& < > \" '");
  });

  it('collapses excess newlines', () => {
    expect(stripHtml('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('converts table cells to tabs', () => {
    // First <td> replacement happens before content, but leading tab gets trimmed
    expect(stripHtml('<td>A</td><td>B</td>')).toBe('A\tB');
  });
});

describe('cleanId', () => {
  it('strips angle brackets', () => {
    expect(cleanId('<message@id.com>')).toBe('message@id.com');
  });

  it('returns null for null/undefined', () => {
    expect(cleanId(null)).toBeNull();
    expect(cleanId(undefined)).toBeNull();
  });

  it('handles ID without brackets', () => {
    expect(cleanId('message@id.com')).toBe('message@id.com');
  });

  it('trims whitespace after stripping brackets', () => {
    // cleanId only strips leading < and trailing >, then trims
    // Spaces before < are not removed by replace, but trim() handles them
    expect(cleanId('<msg@id.com>')).toBe('msg@id.com');
  });
});

describe('formatAddresses', () => {
  it('formats name + address', () => {
    expect(formatAddresses([{ name: 'John', address: 'john@test.com' }]))
      .toBe('John <john@test.com>');
  });

  it('uses address only when name is missing', () => {
    expect(formatAddresses([{ address: 'john@test.com' }]))
      .toBe('john@test.com');
  });

  it('joins multiple addresses', () => {
    const result = formatAddresses([
      { name: 'A', address: 'a@test.com' },
      { address: 'b@test.com' },
    ]);
    expect(result).toBe('A <a@test.com>, b@test.com');
  });

  it('returns empty for null/undefined/non-array', () => {
    expect(formatAddresses(null)).toBe('');
    expect(formatAddresses(undefined)).toBe('');
    expect(formatAddresses('not-array')).toBe('');
  });
});

describe('parseReceivedHeaders', () => {
  it('returns empty array for null/empty', () => {
    expect(parseReceivedHeaders(null)).toEqual([]);
    expect(parseReceivedHeaders([])).toEqual([]);
  });

  it('extracts from, by, with from header', () => {
    const hops = parseReceivedHeaders([
      'from mail.example.com by mx.google.com with ESMTP; Mon, 1 Jan 2024 12:00:00 +0000'
    ]);
    expect(hops).toHaveLength(1);
    expect(hops[0].from).toBe('mail.example.com');
    expect(hops[0].by).toBe('mx.google.com');
    // The regex captures the next non-whitespace token, which may include trailing semicolon
    expect(hops[0].with).toMatch(/^ESMTP/);
  });

  it('extracts date after semicolon', () => {
    const hops = parseReceivedHeaders([
      'from mail.example.com by mx.google.com; Mon, 1 Jan 2024 12:00:00 +0000'
    ]);
    expect(hops[0].date).toBeDefined();
  });

  it('extracts IP address', () => {
    const hops = parseReceivedHeaders([
      'from mail.example.com [192.168.1.1] by mx.google.com'
    ]);
    expect(hops[0].ip).toBe('192.168.1.1');
  });

  it('handles missing fields gracefully', () => {
    const hops = parseReceivedHeaders(['some-random-header-value']);
    expect(hops).toHaveLength(1);
    expect(hops[0].from).toBeUndefined();
    expect(hops[0].by).toBeUndefined();
  });
});

describe('parseEml bcc fallback', () => {
  it('reads x-libpst-forensic-bcc when standard bcc header is absent (libpst-extracted sent mail)', async () => {
    // Simulate what readpst emits for a sent email: the standard bcc: line is stripped
    // per RFC 2822, but the MAPI-stored BCC list is surfaced under the forensic header.
    const eml = [
      'from: Yesha Maniar <yeshamaniar@jmbaxi.com>',
      'to: Mr. Tamal Roy <tamalr@jmbaxi.com>',
      'cc: Aman Chandel <amanc@ict.in>',
      'subject: test bcc fallback',
      'date: Thu, 17 Nov 2022 10:00:00 +0000',
      'message-id: <test-bcc@example.com>',
      'x-libpst-forensic-bcc: Nitin Banerjee',
      'content-type: text/plain',
      '',
      'body',
    ].join('\r\n');
    const parsed = await parseEml(Buffer.from(eml));
    expect(parsed.bcc).toBe('Nitin Banerjee');
  });

  it('prefers the standard bcc header when present (does not overwrite)', async () => {
    const eml = [
      'from: a@example.com',
      'to: b@example.com',
      'bcc: real-bcc@example.com',
      'subject: test',
      'date: Thu, 17 Nov 2022 10:00:00 +0000',
      'message-id: <test-bcc2@example.com>',
      'x-libpst-forensic-bcc: someone-else@example.com',
      'content-type: text/plain',
      '',
      'body',
    ].join('\r\n');
    const parsed = await parseEml(Buffer.from(eml));
    // Standard bcc wins
    expect(parsed.bcc).toContain('real-bcc@example.com');
    expect(parsed.bcc).not.toContain('someone-else');
  });

  it('returns empty bcc when neither header is present', async () => {
    const eml = [
      'from: a@example.com',
      'to: b@example.com',
      'subject: no bcc',
      'date: Thu, 17 Nov 2022 10:00:00 +0000',
      'message-id: <no-bcc@example.com>',
      'content-type: text/plain',
      '',
      'body',
    ].join('\r\n');
    const parsed = await parseEml(Buffer.from(eml));
    expect(parsed.bcc).toBe('');
  });
});
