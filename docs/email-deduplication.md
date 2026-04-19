# Email Deduplication

Sherlock deduplicates emails by **content fingerprint**, not by RFC822 `Message-ID`. This doc covers why, how the fingerprint is built, and how duplicates are collapsed onto a single row while keeping forensic visibility.

Related: [pst-parsing-nuances.md](./pst-parsing-nuances.md) · [ingestion-flows.md](./ingestion-flows.md) · GitHub issues #61, #62.

## Why not Message-ID?

Earlier versions of the PST worker keyed dedup off `Message-ID`. Two production bugs forced a rewrite:

### 1. Gmail draft/sent Message-ID collision

Gmail preserves a **draft's** RFC822 `Message-ID` into the headers of the **sent** copy of the same email, even though MAPI's `PR_INTERNET_MESSAGE_ID` differs between the two messages. Under msg-ID dedup the sent copy was silently skipped as a duplicate of the already-ingested draft — losing the attachments that were only added at send time.

Concrete repro from the Yesha PST: `Re: Docs required for JMBPL goa Registration` (2022-11-17 15:21 IST). The draft has 2 inline-signature JPGs; the sent copy has the same 2 JPGs plus `CTC Board Resolution goa.pdf` and `List of Directors.pdf`. Under msg-ID dedup both PDFs were lost. Impact across Yesha: **117 sent-items emails dropped**, ~75 PDFs + ~40 DOCX + ~11 XLSX + ~11 ZIP.

### 2. Same email, multiple folders

Gmail-sourced PSTs routinely file the same physical message into `/Inbox`, a label folder, and sometimes `/All Mail` — all three carry identical bytes. We want to **count these as one document** but preserve the list of folders the message appeared in, because a reviewer may need to know a particular email was labelled `Legal` or filed under `SPV Nhava Sheva`.

## The fingerprint: `dedup_md5`

`server/lib/eml-parser.js → computeDedupMd5()` returns the 32-char hex MD5 of the following canonical string, joined with `\n`:

| # | Field | Canonicalization |
|---|---|---|
| 1 | `from.address` | lowercased + trimmed |
| 2 | `to` addresses | lowercased emails, sorted, comma-joined |
| 3 | `cc` addresses | same |
| 4 | `bcc` addresses | same |
| 5 | `subject` | trimmed |
| 6 | `date` | ISO 8601 string, or empty if unparseable |
| 7 | `textBody` | whitespace-collapsed (`/\s+/g → ' '`, trimmed) |
| 8 | attachment MD5s | sorted list of attachment content MD5s, comma-joined |

Why MD5 (and not SHA256)? The existing `content_hash` column on `documents` is MD5, as is the eDiscovery industry convention (Relativity uses MD5 too). One hash, one mental model.

**Why include attachment MD5s — this is the whole point.** The draft and sent copies of a Gmail message share envelope + body + date + message-id — they only differ in attachments. Folding the sorted attachment MD5 list into the fingerprint is the discriminator that keeps both rows. Remove the attachment list and the Gmail bug reappears.

### Code reference

```js
// server/lib/eml-parser.js
function computeDedupMd5({ fromAddr, to, cc, bcc, subject, date, textBody, attachmentMd5s }) {
    const attList = [...(attachmentMd5s || [])].sort().join(',');
    const bodyNorm = (textBody || '').replace(/\s+/g, ' ').trim();
    const parts = [
        fromAddr || '',
        canonicalAddresses(to),
        canonicalAddresses(cc),
        canonicalAddresses(bcc),
        (subject || '').trim(),
        date || '',
        bodyNorm,
        attList,
    ];
    return crypto.createHash('md5').update(parts.join('\n'), 'utf8').digest('hex');
}
```

## Schema

Two columns on `documents` (see `server/lib/investigation-db.js`):

| Column | Type | Purpose |
|---|---|---|
| `dedup_md5` | TEXT (indexed via `idx_documents_dedup_md5`) | The content fingerprint, set on every email row |
| `duplicate_folders` | TEXT (JSON array) | List of additional folder paths where the same content appeared. Populated on the **primary** row; duplicates are never inserted as their own row |

The `folder_path` column already holds the folder of the primary copy, so `duplicate_folders` only stores the additional ones. Reviewers see both in the DocumentReview sidebar.

## Worker behaviour

`server/workers/pst-worker.js` maintains an in-memory `seenDedupMd5s: Map<md5, { folder, emailId }>` during ingestion:

1. Parse an .eml into a postal-mime tree, compute `dedup_md5`.
2. If the hash is **unseen**, insert a new email row and record `{ md5 → { folder, emailId } }`.
3. If the hash is **seen** and the new folder differs from the recorded one, skip the insert and append the new folder path to `duplicate_folders` on the primary row.
4. If the hash is seen in the **same** folder — true byte-identical reappearance — skip silently (shouldn't happen in a sane PST).

On worker resume, `seenDedupMd5s` is seeded from existing rows so a mid-ingest restart picks up where it left off.

### Append helper

```js
function appendDuplicateFolder(primaryEmailId, newFolder) {
    const row = db.prepare('SELECT duplicate_folders FROM documents WHERE id = ?').get(primaryEmailId);
    let list = [];
    try { list = row?.duplicate_folders ? JSON.parse(row.duplicate_folders) : []; } catch (_) {}
    if (!list.includes(newFolder)) list.push(newFolder);
    updateDuplicateFolders.run(JSON.stringify(list), primaryEmailId);
}
```

## Reviewer UI

`src/pages/DocumentReview.jsx` renders two dedup-aware rows in the email sidebar:

- **Content hash** — truncated `dedup_md5` (16 chars + ellipsis) with a copy-to-clipboard button.
- **Also appeared in** — bulleted list of `duplicate_folders` paths. Hidden if the JSON is empty.

## What this doesn't do

- **Cross-investigation dedup**. The `seenDedupMd5s` map is per-import; two separate investigations each ingesting the same PST will have two copies of the same email. This is intentional — investigations are isolation boundaries.
- **Attachment-level dedup**. That's handled separately by `content_hash` + `is_duplicate` on the attachment row, with children fanned out to every canonical parent via `replicateChildrenToDuplicates` (see [worker-helpers.js](../server/lib/worker-helpers.js), GitHub issue #73).
- **Backfill**. Existing rows ingested before the feature landed carry `dedup_md5 = NULL`. The assumption is a re-ingest when you want the new behaviour. An offline backfill would need to re-read the preserved readpst temp `.eml` files, which aren't kept past ingestion.
- **Chat/ZIP workers**. Only the PST worker applies this logic — the Gmail quirk doesn't surface on other ingestion paths.

## Tests

- `server/lib/__tests__/eml-parser.test.js` — covers `computeDedupMd5` determinism, draft-vs-sent discrimination, and whitespace-insensitive body hashing.
- Manual verification path: re-ingest Yesha PST, navigate to the `goa Registration` thread, confirm both draft and sent rows exist with distinct `dedup_md5` values and the sent row carries `CTC Board Resolution goa.pdf` + `List of Directors.pdf` as children.
