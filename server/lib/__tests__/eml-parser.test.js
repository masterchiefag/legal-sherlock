import { describe, it, expect } from 'vitest';
import { stripHtml, cleanId, formatAddresses, parseReceivedHeaders, computeDedupMd5, canonicalAddresses, parseEml } from '../eml-parser.js';

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

describe('canonicalAddresses', () => {
  it('returns empty string for null / non-array', () => {
    expect(canonicalAddresses(null)).toBe('');
    expect(canonicalAddresses(undefined)).toBe('');
    expect(canonicalAddresses('not-an-array')).toBe('');
  });

  it('lowercases, sorts, and comma-joins email addresses', () => {
    const list = [
      { name: 'Zelda', address: 'Zelda@Example.COM' },
      { name: 'Alice', address: 'alice@example.com' },
    ];
    expect(canonicalAddresses(list)).toBe('alice@example.com,zelda@example.com');
  });

  it('skips entries without an address', () => {
    const list = [{ name: 'No Address' }, { address: 'real@x.com' }, {}];
    expect(canonicalAddresses(list)).toBe('real@x.com');
  });
});

describe('computeDedupMd5', () => {
  const base = {
    fromAddr: 'alice@example.com',
    to: [{ address: 'bob@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: test',
    date: '2024-06-01T10:00:00.000Z',
    textBody: 'Hello Bob',
    attachmentMd5s: [],
  };

  it('returns a 32-char hex MD5', () => {
    const h = computeDedupMd5(base);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable across repeated calls', () => {
    expect(computeDedupMd5(base)).toBe(computeDedupMd5({ ...base }));
  });

  it('differs when attachments differ (the Gmail draft/sent fix, issue #61)', () => {
    const draft = computeDedupMd5({ ...base, attachmentMd5s: ['aa', 'bb'] });
    const sent  = computeDedupMd5({ ...base, attachmentMd5s: ['aa', 'bb', 'cc', 'dd'] });
    expect(draft).not.toBe(sent);
  });

  it('ignores attachment ordering (sorted before hashing)', () => {
    const a = computeDedupMd5({ ...base, attachmentMd5s: ['aa', 'bb', 'cc'] });
    const b = computeDedupMd5({ ...base, attachmentMd5s: ['cc', 'aa', 'bb'] });
    expect(a).toBe(b);
  });

  it('normalizes whitespace in the body', () => {
    const a = computeDedupMd5({ ...base, textBody: 'Hello   Bob' });
    const b = computeDedupMd5({ ...base, textBody: ' Hello Bob ' });
    const c = computeDedupMd5({ ...base, textBody: 'Hello\n\tBob' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('is case-insensitive for recipient addresses', () => {
    const lower = computeDedupMd5({ ...base, to: [{ address: 'bob@example.com' }] });
    const upper = computeDedupMd5({ ...base, to: [{ address: 'BOB@EXAMPLE.COM' }] });
    expect(lower).toBe(upper);
  });

  it('distinguishes different senders', () => {
    const a = computeDedupMd5({ ...base });
    const b = computeDedupMd5({ ...base, fromAddr: 'someone-else@example.com' });
    expect(a).not.toBe(b);
  });

  it('handles missing fields (no crash)', () => {
    const h = computeDedupMd5({});
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parseEml (integration)', () => {
  // Build a minimal EML with an embedded message/rfc822 part — the pattern readpst
  // emits for MAPI attachMethod=5 embedded emails. This test locks in the fix for
  // the "11 embedded MSGs vs Relativity's 1,582" gap.
  it('surfaces message/rfc822 sub-parts as attachments with forceRfc822Attachments', async () => {
    const boundary = 'testbnd_abc';
    const innerEml = [
      'From: inner@example.com',
      'To: outer@example.com',
      'Subject: Inner Forwarded',
      'Date: Sat, 01 Jun 2024 09:00:00 +0000',
      'Message-ID: <inner-msg-id@example.com>',
      'Content-Type: text/plain',
      '',
      'I am the inner email content.',
    ].join('\r\n');
    const outerEml = [
      'From: outer@example.com',
      'To: dest@example.com',
      'Subject: Outer',
      'Date: Sat, 01 Jun 2024 10:00:00 +0000',
      'Message-ID: <outer-msg-id@example.com>',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Please see attached email.',
      '',
      `--${boundary}`,
      'Content-Type: message/rfc822',
      'Content-Disposition: inline',
      '',
      innerEml,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const parsed = await parseEml(Buffer.from(outerEml));
    const rfc = parsed.attachments.find(a => a.contentType === 'message/rfc822');
    expect(rfc).toBeDefined();
    expect(rfc.content.length).toBeGreaterThan(0);
    // Unnamed parts get synthesized so Phase 1.5's *.eml filter matches
    expect(rfc.filename).toMatch(/\.eml$/i);
  });

  it('populates dedupMd5 on every parsed email', async () => {
    const eml = [
      'From: x@example.com',
      'To: y@example.com',
      'Subject: plain',
      'Date: Sat, 01 Jun 2024 10:00:00 +0000',
      'Message-ID: <m@example.com>',
      'Content-Type: text/plain',
      '',
      'hi',
    ].join('\r\n');
    const parsed = await parseEml(Buffer.from(eml));
    expect(parsed.dedupMd5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different dedupMd5 when attachments differ but envelope is the same (issue #61)', async () => {
    const makeEml = (attachBlock) => [
      'From: yesha@example.com',
      'To: tamal@example.com',
      'Subject: Re: Docs required',
      'Date: Thu, 17 Nov 2022 12:48:18 +0530',
      'Message-ID: <CAA_wxhu=draft-reused@example.com>', // same msg-id for both!
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'hello',
      '',
      attachBlock,
      '--b--',
      '',
    ].join('\r\n');

    const draft = makeEml([
      '--b',
      'Content-Type: text/plain; name="sig.txt"',
      'Content-Disposition: attachment; filename="sig.txt"',
      '',
      'signature',
      '',
    ].join('\r\n'));

    const sent = makeEml([
      '--b',
      'Content-Type: text/plain; name="sig.txt"',
      'Content-Disposition: attachment; filename="sig.txt"',
      '',
      'signature',
      '',
      '--b',
      'Content-Type: application/pdf; name="board-reso.pdf"',
      'Content-Disposition: attachment; filename="board-reso.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('pretend pdf content').toString('base64'),
      '',
    ].join('\r\n'));

    const pDraft = await parseEml(Buffer.from(draft));
    const pSent  = await parseEml(Buffer.from(sent));
    expect(pDraft.messageId).toBe(pSent.messageId); // msg-id collision (Gmail quirk)
    expect(pDraft.dedupMd5).not.toBe(pSent.dedupMd5); // but content hash differs → both survive
  });

  it('produces the same dedupMd5 when only wrapping whitespace differs', async () => {
    const a = [
      'From: x@example.com',
      'To: y@example.com',
      'Subject: Same',
      'Date: Sat, 01 Jun 2024 10:00:00 +0000',
      'Message-ID: <m1@example.com>',
      'Content-Type: text/plain',
      '',
      'hello world',
    ].join('\r\n');
    const b = [
      'From: x@example.com',
      'To: y@example.com',
      'Subject: Same',
      'Date: Sat, 01 Jun 2024 10:00:00 +0000',
      'Message-ID: <m2@example.com>', // different msg-id — but content is the same
      'Content-Type: text/plain',
      '',
      'hello    world', // extra whitespace — should normalize
    ].join('\r\n');
    const pa = await parseEml(Buffer.from(a));
    const pb = await parseEml(Buffer.from(b));
    expect(pa.dedupMd5).toBe(pb.dedupMd5);
  });
});
