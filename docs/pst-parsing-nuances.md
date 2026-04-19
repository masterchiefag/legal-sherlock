# PST Parsing: Technical Nuances and Known Gaps

Reference doc for Outlook PST/OST file parsing in Sherlock. Covers parser behavior, known limitations, and comparison with commercial tools (Relativity).

---

## Parser Stack

Sherlock uses two complementary approaches for PST parsing:

| Tool | Type | Used In | Purpose |
|------|------|---------|---------|
| `readpst` (libpst CLI) | Native C library | `pst-worker.js` (primary) | Extract emails as `.eml` files + attachments to disk |
| `pst-extractor` (npm) | JavaScript | `pst-parser.js` (secondary) | Walk PST folder tree + read attachment metadata in-memory |
| `@kenjiuno/msgreader` (npm) | JavaScript | `msg-parser.js` | Parse OLE `.msg` files extracted by readpst |

### Why Two PST Parsers?

`readpst` is the primary ingestion path. It's fast, handles large (30GB+) PST files, and produces standard `.eml` files that feed into `postal-mime` via `eml-parser.js`.

`pst-extractor` is used for auditing and diagnostics (e.g., `pst-attachment-audit.js`). It walks the PST in JavaScript without extracting to disk, useful for comparing what's in the PST vs. what Sherlock ingested.

Both have the **same blind spot**: embedded MSG files (see below).

---

## Embedded MSG Files (The Biggest Gap)

### The Problem

When a user forwards an email **as an attachment** in Outlook, or when an email contains another email as an attachment, the inner email is stored as an embedded MSG object inside the PST. These MSG files use Microsoft's OLE Compound Binary format — a completely different format from the surrounding PST structure.

Open-source PST parsers (both `readpst` and `pst-extractor`) extract these as opaque `.msg` file blobs. They **do not** recurse into the MSG to extract its attachments. This means:

- A forwarded email containing 5 PDF attachments appears as a single `.msg` file
- Those 5 PDFs are invisible to search, review, and document counts
- Commercial tools like Relativity parse MSGs natively and count every nested document

### Impact

Testing on a 30GB PST (Yesha Maniar case):
- Direct PDF attachments visible to readpst: **13,123**
- PDFs hidden inside embedded MSG files: **~9,678**
- Total: **~22,801** (before dedup, vs Relativity's 18,948 unique)
- **~43% of PDFs were invisible** without MSG parsing

### The Fix (Phase 1.5)

`pst-worker.js` now includes a Phase 1.5 that runs after email import:

1. Queries all non-duplicate `.msg` attachments in the investigation
2. Parses each with `@kenjiuno/msgreader` (`server/lib/msg-parser.js`)
3. Extracts document attachments (skipping images)
4. Inserts them as children of the MSG: `Email → MSG attachment → extracted files`
5. Updates the MSG document's `text_content` with the embedded email body (making forwarded email text searchable)

Document hierarchy:
```
Email (doc_type='email', doc_identifier=YES_YM_00001)
  └─ forwarded.msg (doc_type='attachment', doc_identifier=YES_YM_00001_001)
       └─ report.pdf (doc_type='attachment', parent_id=msg.id, doc_identifier=YES_YM_00001_001_001)
       └─ data.xlsx (doc_type='attachment', parent_id=msg.id, doc_identifier=YES_YM_00001_001_002)
```

---

## readpst Flags

| Flag | Behavior | Sherlock Uses |
|------|----------|---------------|
| `-e` | Extract emails as `.eml`, attachments as separate files | ✅ Primary flag |
| `-m` | Extract embedded messages as `.msg` files (vs `.eml` in `-e` mode) | Not used (Phase 1.5 handles MSGs from `-e` output) |
| `-D` | Include deleted items | ✅ Used |
| `-b` | Don't save RTF body | Not used |
| `-S` | Separate files for each email folder | Not used (we flatten) |

### `-e` vs `-m` Flag

With `-e` (Sherlock's current flag):
- Top-level emails → `.eml` files (good, parsed by `postal-mime`)
- Embedded/forwarded emails → `.msg` attachment blobs inside the `.eml`
- Total output for 30GB PST: ~52K `.eml` files

With `-m` flag:
- Top-level emails → ALSO output as `.msg` files alongside `.eml`
- Embedded emails → `.msg` files
- Total output for same PST: ~52K `.eml` + ~39K `.msg` files
- The `.msg` files include all the embedded emails that `-e` misses

We chose to keep `-e` and post-process MSGs (Phase 1.5) rather than switching to `-m`, because:
- `-m` changes the output format for ALL emails, requiring a new parsing path
- `-e` output works well with `postal-mime` for top-level emails
- Phase 1.5 only touches the MSG blobs that need special handling

---

## Known Open-Source Parser Limitations

### 1. Unsupported Message Types

Both readpst and pst-extractor log warnings for certain message types they can't handle:

```
PSTUtil::createAppropriatePSTMessageObject unknown message type: Report.IPM.Note.IPNRN
PSTUtil::createAppropriatePSTMessageObject unknown message type: Report.IPM.Note.NDR
PSTUtil::createAppropriatePSTMessageObject unknown message type: IPM.Outlook.Recall
PSTUtil::createAppropriatePSTMessageObject unknown message type: IPM
```

- `Report.IPM.Note.IPNRN` — Read receipt (non-delivery read notification)
- `Report.IPM.Note.NDR` — Non-delivery report (bounce)
- `IPM.Outlook.Recall` — Message recall attempt
- `IPM` — Generic folder item (calendar, contact, etc.)

These are typically not document-relevant for eDiscovery.

### 2. Email Count Differences

PST files store the same email in multiple Outlook folders (Inbox, Sent Items, etc.). readpst extracts ALL copies. Sherlock deduplicates by `message_id` during Phase 1 to avoid storing duplicates.

Example: A PST with 52,716 raw emails may have only 48,476 unique `message_id` values.

### 3. Attachment Count Differences

The `pst-attachment-audit.js` script (in `server/scripts/`) can compare PST attachment counts against Sherlock's database. Common sources of discrepancy:

- **Inline images**: readpst extracts CID-referenced images (logo.png in email signatures). These are counted but not always relevant.
- **Embedded MSG files**: Parsed in Phase 1.5 via msgreader (~282 PDFs in Yesha case).
- **ZIP contents**: Extracted in Phase 1.6 (~2,500-3,000 PDFs in Yesha case). This was the single biggest gap.
- **PDF portfolios**: Extracted in Phase 1.7 (~2,500 PDFs in Yesha case). Second biggest gap.
- **TNEF/winmail.dat**: Extracted in Phase 1.8 (~5 docs). Small but handled for completeness.
- **Calendar attachments (.ics)**: Sherlock stores these but doesn't extract text from them.
- **S/MIME signed envelopes**: Unwrapped in Phase 1.4 via `pst-extractor` `fileInputStream` → `postal-mime` (~330 attachments / 72 PDFs in Yesha case). readpst drops these silently (see the S/MIME section below).

---

## S/MIME Multipart/Signed Unwrap (Phase 1.4 — GitHub issue #79)

S/MIME-signed emails arrive in the PST with `messageClass = IPM.Note.SMIME.MultipartSigned` and a SINGLE MAPI attachment that is the entire signed MIME body. Outlook clients render the inner content seamlessly, so reviewers never see the wrapping. `readpst -e`, however, strips the wrapper and emits an `.eml` with only the plaintext body — **every real attachment behind the signature is lost**.

### The trap

`pst-extractor` reports `numberOfAttachments = 1` but `attachment.attachSize` returns `undefined`. Earlier diagnostic scripts used `a.attachSize || 0` and wrongly concluded the attachment was empty, so we dismissed the whole class as "not recoverable."

The real data is behind `attachment.fileInputStream`:

```js
const a = msg.getAttachment(0);           // attachSize === undefined
const stream = a.fileInputStream;          // this yields the real bytes
// read stream fully → Buffer of standard multipart/signed MIME body
// feed into postal-mime → real attachments come out the other side
```

Typical blob size: 100 KB – 5 MB. The content is a standard multipart/signed MIME body that starts with:

```
MIME-Version: 1.0
Content-Type: multipart/signed; micalg=sha-256;
    protocol="application/pkcs7-signature";
    boundary="MimeBoundary..."
Content-Transfer-Encoding: 7BIT
```

Inside: text body, HTML body, real attachments, `smime.p7s` signature.

### Implementation

- `extractSignedSmimeBlobs(pstPath)` in `server/lib/pst-parser.js` — walks the PST and yields `{ messageId, folderPath, subject, mapiClass, blob, blobSize }` for every signed message.
- `server/workers/pst-worker.js` Phase 1.4 — for each blob: match the existing email row by `message_id`, parse the blob via `postal-mime` (with `forceRfc822Attachments: true`), skip the `.p7s` signature + inline CID images, insert the rest as children. Runs after Phase 1.3 and before Phase 1.5 so any forwarded RFC822 sub-parts surfaced here become candidates for MSG recursion.
- `server/scripts/backfill-smime-multipartsigned.mjs` — applies the same logic to an existing investigation without a full re-ingest. Idempotent (dedup by attachment content-hash against children already on the email).

### Out of scope

- **Encrypted S/MIME** (`application/pkcs7-mime; smime-type=enveloped-data`): requires a private key. Future work — for now these are logged and skipped.
- **Backfill recursion into newly-surfaced ZIPs / MSGs**: a fresh re-ingest runs Phase 1.9 naturally and recovers deeply nested content. The backfill script only handles direct attachments — PDFs hiding inside a newly-surfaced ZIP still need a separate ZIP-extraction pass.

### Impact (Yesha Maniar 30 GB PST)

| Metric | Count |
|---|---:|
| Signed emails walked | 428 |
| Emails with recoverable non-signature attachments | 198 |
| Attachments inserted | 330 |
| &nbsp;&nbsp;PDFs | 72 |
| &nbsp;&nbsp;DOCX | 187 |
| &nbsp;&nbsp;XLSX | 41 |
| &nbsp;&nbsp;DOC / ZIP / rfc822 / ics / img | 30 |
| Of the 61 residual "missing PDFs" vs Rel | 31 recovered directly, 28 behind newly-surfaced ZIPs (recovered on fresh re-ingest via Phase 1.9), 2 truly Rel-side artifacts |

---

## Container Extraction (Phases 1.6-1.9)

After Phase 1.5 (MSG extraction), the pipeline now extracts files from all container types to match Relativity's behavior:

### Phase 1.6: ZIP Extraction

- Queries all non-duplicate `.zip` attachments
- Uses `zipinfo` to list contents, `unzip -p` to extract individual files
- Inserts extracted files as children of the ZIP document
- Deduplicates by MD5 hash against all previously seen files
- **Impact**: ~2,500-3,000 additional documents in the Yesha case

### Phase 1.7: PDF Portfolio Extraction

- Scans all non-duplicate PDF attachments with `pdfdetach -list` (fast catalog-only read)
- For PDFs with embedded files: extracts via `pdfdetach -saveall` to a temp directory
- **Dependencies**: `pdfdetach` from poppler-utils (same package as `pdftoppm` used for OCR)
- **Impact**: ~2,500 additional documents (1,140 parent PDFs contained 2,506 embedded files in Yesha case)

### Phase 1.8: TNEF Extraction

- Handles winmail.dat / noname.dat / application/ms-tnef attachments
- Uses `tnef -C <tmpdir> --overwrite` CLI
- **Impact**: ~5 documents (tiny but trivial to handle)

### Phase 1.9: Recursive Container Pass

- Relativity recurses into nested containers (ZIP inside ZIP, PDF portfolio inside ZIP, etc.)
- Loops up to 5 passes, processing any newly-inserted containers from prior phases
- Also re-scans newly extracted PDFs for portfolio detection
- Stops when no new files are extracted or depth limit reached

### System Dependencies

| Tool | Package | Purpose | Phase |
|------|---------|---------|-------|
| `zipinfo` | Built-in (macOS) / `unzip` package (Linux) | List ZIP contents | 1.6, 1.9 |
| `unzip` | Built-in (macOS) / `unzip` package (Linux) | Extract ZIP files | 1.6, 1.9 |
| `pdfdetach` | `poppler-utils` | Detect + extract PDF portfolios | 1.7, 1.9 |
| `tnef` | `tnef` | Extract winmail.dat | 1.8, 1.9 |

### Relativity Gap Analysis (Yesha Maniar 30GB PST)

Comparison against Relativity export (81,580 rows):

| Gap Source | Estimated Docs | Phase | Status |
|------------|---------------|-------|--------|
| ZIP flattening | ~2,500-3,000 | 1.6 | Implemented |
| PDF portfolios | ~2,506 | 1.7 | Implemented |
| MSG/EML containers | ~282 | 1.5 | Implemented |
| S/MIME signed unwrap | ~330 (72 PDFs) | 1.4 | Implemented |
| TNEF/winmail.dat | ~5 | 1.8 | Implemented |
| Nested containers | ~100-500 | 1.9 | Implemented |
| **Total** | **~5,400-6,300** | | |

This should close the gap from ~76K to ~81-82K documents, aligning closely with Relativity's 81,580.

---

## Deduplication: Sherlock vs Relativity

| Aspect | Sherlock | Relativity |
|--------|----------|------------|
| Hash algorithm | MD5 | SHA-256 |
| Scope | Per-investigation | Configurable (workspace, custodian, etc.) |
| What's hashed | File content (attachment bytes) | File content |
| Dedup behavior | `is_duplicate` flag, row still exists | Configurable (suppress or flag) |
| Cross-email dedup | Yes — same attachment in multiple emails marked as duplicate | Similar |

**Important**: In eDiscovery, each attachment instance tied to a specific email matters for chain-of-custody. Dedup is informational — both tools keep all rows, they just flag duplicates.

When comparing counts:
- **Total count** (all instances) is the right comparison for "did we extract everything?"
- **Unique count** (after dedup) is the right comparison for "do we have the same document universe?"

---

## Diagnostic Scripts

All in `server/scripts/`:

| Script | Purpose |
|--------|---------|
| `pst-attachment-audit.js` | Walk PST with pst-extractor, compare attachment manifest against Sherlock DB |
| `ingest-zip-attachments.js` | One-off: extract ZIP attachment contents and ingest as children (now superseded by Phase 1.6 in pipeline, kept for standalone re-runs) |
| `ingest-remaining-containers.js` | One-off: extract RAR, 7z, EML, MSG, TNEF containers (now mostly superseded by Phases 1.5-1.8) |

Usage:
```bash
node --max-old-space-size=8192 server/scripts/pst-attachment-audit.js <pst_path> <investigation_id>
node server/scripts/ingest-zip-attachments.js <investigation_id> [--dry-run]
node server/scripts/ingest-remaining-containers.js <investigation_id> [--dry-run]
```

---

## Comparison Methodology

When comparing Sherlock output against another tool (Relativity, Nuix, etc.):

1. **Use total counts, not unique** — each attachment instance matters
2. **Compare by file type** — breakdown by extension catches category-level gaps
3. **Check container extraction** — does the other tool open ZIPs, MSGs, RARs, TNEF?
4. **Check dedup methodology** — same hash algorithm? Same scope?
5. **Account for skipped types** — Sherlock skips images in Phase 1.5 MSG extraction; some tools count everything

Expected sources of remaining differences after full container extraction (Phases 1.5-1.9):
- Password-protected containers (ZIP, PDF, RAR)
- RAR/7z archives (not yet extracted in pipeline; handled by `ingest-remaining-containers.js` one-off)
- Corrupted files that one parser handles but another doesn't
- Different treatment of inline images vs. true attachments
- Edge cases in PDF portfolio detection (some non-standard PDF packages may not be detected by pdfdetach)
