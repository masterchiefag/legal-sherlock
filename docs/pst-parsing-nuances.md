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
- **Embedded MSG files**: Main source of missing documents (see above).
- **TNEF/winmail.dat**: Outlook's Transport Neutral Encapsulation Format wraps attachments in a binary blob. readpst usually unpacks these, but edge cases exist.
- **Calendar attachments (.ics)**: Sherlock stores these but doesn't extract text from them.

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
| `ingest-zip-attachments.js` | One-off: extract ZIP attachment contents and ingest as children |
| `ingest-remaining-containers.js` | One-off: extract RAR, 7z, EML, MSG, TNEF containers |

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

Expected sources of remaining differences after MSG parsing:
- Nested MSG files (MSG inside MSG) — currently skipped at depth > 0
- Password-protected containers
- Corrupted files that one parser handles but another doesn't
- Different treatment of inline images vs. true attachments
