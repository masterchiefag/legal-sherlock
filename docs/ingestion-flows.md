# Document Ingestion Flows

Technical reference for all extraction and ingestion entry points in Sherlock. Each flow ultimately inserts rows into the `documents` table and the `documents_fts` virtual table, but they differ in how files arrive, get parsed, and reach that common destination.

---

## Architecture Overview

```
Entry Points                     Workers / Handlers                  Shared Post-Ingestion
------------------------------   ---------------------------------   -------------------------
                                                                     worker-helpers.js:
Upload Page (.eml)               documents.js  processEmlFile()  -+   disableFtsTriggers()
Upload Page (.pdf/.docx/etc)     documents.js  processRegularFile()   enableFtsTriggers()
                                               |                  |   rebuildFtsIndex()
Upload Page (.pst/.ost) -------> pst-worker.js (7 phases)       --+   dropBulkIndexes()
Upload Page (.zip)   ----------> zip-worker.js                  --+   recreateBulkIndexes()
Upload Page (.zip+ChatStorage)-> chat-worker.js                 --+   refreshInvestigationCounts()
Upload Page (.sqlite/.db) -----> chat-worker.js                 --+   walCheckpoint()
                                                                  |
E01 Image (3 phases):                                             |
  Phase 1  POST /api/images/scan ------> image-scan-worker.js    |
  Phase 2  POST /api/images/metadata --> image-metadata-worker.js |
  Phase 3  POST /api/images/ingest ----> image-ingest-worker.js --+
                                                                  |
UFDR/ZIP Archive (3 phases):                                      |
  Same endpoints, same workers, archive-mode branches ------------+
```

---

## 1. Direct File Upload

**Route**: `POST /api/documents/upload` (documents.js)
**Auth**: `requireRole('admin', 'reviewer')` + investigation access check
**Handler**: Multer middleware, up to 50 files per request

### Routing by extension

The upload handler inspects each file's extension and dispatches accordingly:

| Extension | Handler | Sync/Async |
|-----------|---------|------------|
| `.eml` | `processEmlFile()` inline | Synchronous (awaited) |
| `.pst`, `.ost` | `spawnPstWorker()` | Background worker, returns 202 |
| `.sqlite`, `.db` | `spawnChatWorker()` | Background worker, returns 202 |
| `.zip` | Peek for `ChatStorage.sqlite` first; if found -> `spawnChatWorker()`, else -> `spawnZipWorker()` | Background worker, returns 202 |
| Everything else | `processRegularFile()` inline | Synchronous (awaited) |

### Regular file pipeline (processRegularFile)

1. Multer writes file to `uploads/{investigation_id}/{uuid}.{ext}`
2. Compute MD5 content hash for deduplication (`content_hash` column)
3. Check for existing document with same hash in same investigation -> set `is_duplicate = 1`
4. Generate doc identifier via `generateDocIdentifier()` (format: `CASE_CUST_00001`)
5. Insert row with `status = 'processing'`
6. Call `extractText(filePath, mimeType)` for text content
7. Call `extractMetadata(filePath, mimeType)` for author, title, dates, keywords
8. Update row to `status = 'ready'` with extracted text and metadata
9. On failure: set `status = 'error'`

### EML file pipeline (processEmlFile -> processEmailData)

1. `parseEml()` extracts headers, body, attachments
2. `resolveThreadId()` resolves thread from `message_id`, `in_reply_to`, `references` headers
3. Insert email document with `doc_type = 'email'`, full transport metadata (headers_raw, received_chain, originating_ip, auth_results, server_info, delivery_date)
4. `backfillThread()` unifies orphan threads for late-arriving emails
5. Each attachment: write to disk, compute MD5, extract text + metadata, insert with `doc_type = 'attachment'` and `parent_id` pointing to email
6. Attachment doc identifiers append `_001`, `_002` etc. to parent's identifier

### Allowed file types (Multer filter)

`.pdf`, `.docx`, `.doc`, `.xls`, `.xlsx`, `.txt`, `.csv`, `.md`, `.eml`, `.pst`, `.ost`, `.sqlite`, `.db`, `.zip`

### Gotchas

- The Multer file size limit is commented out to allow massive PST files. There is effectively no upload size cap.
- Custodian falls back to the first file's name (minus extension) if not provided in the request body.
- For PST/ZIP/Chat uploads, the endpoint returns 202 immediately. Only regular files and EMLs return the full result set synchronously.
- `refreshInvestigationCounts()` is called inline for sync uploads but is handled by the worker for background jobs.

---

## 2. PST Import

**Worker**: `server/workers/pst-worker.js`
**Spawned by**: `spawnPstWorker()` in documents.js
**Job tracking**: `import_jobs` table

### Seven-phase process

**Phase 1 -- Parse emails + extract attachments**

1. Shell out to `readpst -e -D {filepath}` which dumps emails as individual `.eml` files and extracts embedded attachments to a temp directory
2. Parse each `.eml` via a pool of `eml-parse-worker.js` sub-workers (concurrency = `min(cpus - 1, 6)`, minimum 2)
3. Resolve email threading via cached threading module (`threading-cached.js`) for performance
4. Insert emails and attachments in batched transactions (`DB_BATCH_SIZE = 500`)
5. Attachment dedup: MD5 hash checked in-memory first, then against DB
6. Attachments > 100MB (`MAX_ATTACHMENT_SIZE`) are skipped (not written to disk)

**Phase 1.5 -- Embedded MSG extraction**

Forwarded/attached Outlook emails are stored as opaque `.msg` files by readpst. This phase parses them to extract their document attachments, which would otherwise be invisible. See [pst-parsing-nuances.md](./pst-parsing-nuances.md) for full details.

1. Queries all non-duplicate `.msg` attachments in the investigation
2. Parses each with `@kenjiuno/msgreader` via `server/lib/msg-parser.js`
3. Extracts document attachments (skips images), writes to disk with dedup
4. Inserts as children of the MSG doc: `Email → MSG → extracted files`
5. Updates MSG document's `text_content` with embedded email body (makes forwarded email text searchable)

**Phase 1.6 -- ZIP extraction**

Relativity flattens ZIP containers — extracts all files inside as child documents. Without this, PDFs/DOCX inside ZIPs are invisible to search. Uses `zipinfo` to list contents and `unzip -p` to extract. Impact: ~2,500-3,000 additional documents in large PSTs.

1. Queries all non-duplicate `.zip` attachments, deduplicates by content_hash
2. For each unique ZIP: lists contents via `zipinfo`, extracts each file via `unzip -p`
3. Hashes, deduplicates, writes to disk, inserts as children of the ZIP document
4. Skips images/media/executables (same `SKIP_EXTS` as other phases)

**Phase 1.7 -- PDF portfolio extraction**

Some PDFs contain embedded file attachments (PDF portfolios / PDF packages). Relativity extracts these as separate documents. Uses `pdfdetach` from poppler-utils. Impact: ~2,500 additional documents.

1. Scans all non-duplicate PDF attachments with `pdfdetach -list` (fast catalog read)
2. For PDFs with embedded files: extracts all via `pdfdetach -saveall` to temp directory
3. Hashes, deduplicates, inserts as children of the PDF document

**Phase 1.8 -- TNEF extraction**

Outlook's Transport Neutral Encapsulation Format (winmail.dat) wraps attachments in a binary blob. Small impact (~5 docs) but trivial to handle. Uses `tnef` CLI.

1. Queries winmail.dat / noname.dat / application/ms-tnef attachments
2. Extracts via `tnef -C <tmpdir> --overwrite`, inserts children

**Phase 1.9 -- Recursive container pass**

Phases 1.5-1.8 handle one level of extraction. But containers can be nested (ZIP inside ZIP, PDF portfolio inside ZIP, MSG inside ZIP). Relativity recurses. This phase loops until no new containers are found, with a hard limit of 5 passes to prevent ZIP bombs.

1. Finds newly-inserted containers that haven't been processed yet
2. Processes each by type (reuses logic from phases 1.5-1.8)
3. Also re-scans newly extracted PDFs for portfolio detection
4. Repeats until no new files are extracted or depth limit reached

**Phase 2 -- Text extraction**

1. Runs `extractText()` on attachments that were inserted with `status = 'processing'` (including all newly extracted files from phases 1.5-1.9)
2. Concurrency capped at `PHASE2_CONCURRENCY = 4`
3. Updates each attachment's `text_content` and sets `status = 'ready'`

### Doc identifier generation

- Format: `{CASE_SHORT_CODE}_{CUSTODIAN_INITIALS}_{5-DIGIT_SEQ}`
- Custodian initials: first 2 chars of first name + first char of last name (e.g., "John Doe" -> "JOD"). Single name: first 3 chars. Missing: "XXX".
- Sequence number is resume-safe: queries `MAX(CAST(SUBSTR(...)))` on startup
- Attachment identifiers: `{parent_id}_{3-DIGIT_SEQ}` (e.g., `CASE_JOD_00001_001`)

### FTS and index management

1. `disableFtsTriggers()` before bulk insert
2. `dropBulkIndexes()` drops 7 indexes for insert speed
3. After completion: `enableFtsTriggers()` + `rebuildFtsIndex()` + `recreateBulkIndexes()`
4. `walCheckpoint(PASSIVE)` to flush WAL
5. `refreshInvestigationCounts()` to update precomputed counts

### Gotchas

- Workers open their own `better-sqlite3` connection. They must NOT set `journal_mode = WAL` (already set by main process; doing so deadlocks).
- Worker DB connections use `timeout: 15000` and `busy_timeout = 10000` to handle contention with the main process.
- Stuck jobs (status `processing` or `pending` at server startup) are auto-marked as `failed` with a "Server restarted" error. No auto-resume.
- Embedded MSG files (forwarded emails) are parsed in Phase 1.5 via `@kenjiuno/msgreader`. Without this, ~30-50% of document attachments can be invisible. See [pst-parsing-nuances.md](./pst-parsing-nuances.md).
- Container extraction (Phases 1.6-1.9) uses external CLI tools: `zipinfo`/`unzip` (ZIP), `pdfdetach` (PDF portfolios, from poppler-utils), `tnef` (winmail.dat). These must be installed on the host.
- The `extractionOnly` flag skips Phase 1 and only runs Phase 2 (text extraction) on existing attachments. Used for resuming failed extraction.
- Threading uses `threading-cached.js` (in-memory LRU cache) in the PST worker for speed, vs `threading.js` (DB-only) in other workers.

---

## 3. ZIP Import

**Worker**: `server/workers/zip-worker.js`
**Spawned by**: `spawnZipWorker()` in documents.js
**Job tracking**: `import_jobs` table (job_type = 'zip')

### Detection and routing (in documents.js upload handler)

Before spawning the ZIP worker, the upload route peeks inside the archive with `unzip -l` looking for `ChatStorage.sqlite` (case-insensitive, any depth). If found, the upload is routed to `chat-worker.js` instead. Otherwise, `zip-worker.js` handles it.

### Processing pipeline

1. List contents via `zipinfo` (more reliable than `unzip -l` across formats)
2. Categorize entries: `.eml` files go to email pipeline, everything else to file pipeline
3. Skip `__MACOSX/` junk and dotfiles
4. **EML entries**: extract from ZIP to buffer, parse with `parseEml()`, resolve threading, batch-insert emails + attachments
5. **File entries**: extract from ZIP, compute MD5, check dedup (in-memory `seenHashes` map first), extract text + metadata for known types, batch-insert
6. Known non-extractable extensions (images, videos, executables, etc.) are silently skipped via `SKIP_EXTS`
7. Batched DB writes with `DB_BATCH_SIZE = 200` via transaction wrapper

### Post-ingestion

1. `enableFtsTriggers()` + `rebuildFtsIndex()` (no index drop/recreate -- ZIP worker does not drop indexes unlike PST/E01 workers)
2. `refreshInvestigationCounts()`
3. Source ZIP is deleted from disk after successful completion to free space

### Gotchas

- ZIP worker uses `zipinfo` to list contents, but the ChatStorage detection in documents.js uses `unzip -l`. These are two different tools with different output formats.
- The ZIP worker does NOT drop/recreate bulk indexes (only disables/re-enables FTS triggers). For very large ZIPs this may be slower than the PST worker's approach.
- In-memory dedup (`seenHashes` map) means duplicate files within the same ZIP are detected without DB queries, but cross-ZIP duplicates rely on DB `content_hash` check.
- The custodian initials algorithm differs slightly from the PST worker: ZIP uses first initial of first + first initial of last (2 chars), while PST uses first 2 chars of first + first of last (3 chars). This is a known inconsistency.

---

## 4. E01 Forensic Disk Image (3-Phase Flow)

**Routes**: `POST /api/images/scan`, `/metadata`, `/extract`, `/ingest` (images.js)
**Auth**: All routes require `requireRole('admin')`
**Job tracking**: `image_jobs` table
**Valid extensions**: `.e01`, `.e01x`, `.ex01`, `.zip`, `.ufdr`

The E01 flow is investigation-independent for scanning and metadata, but investigation-scoped for ingestion. The image must exist on the server's filesystem (not uploaded through the browser).

### Phase 1 -- Scan (image-scan-worker.js)

**Endpoint**: `POST /api/images/scan`
**Input**: `{ imagePath, searchPattern }` (searchPattern defaults to `.*\.(pst|ost)$`)

For E01 images:
1. Run `mmls {imagePath}` to discover partitions
2. Parse partition table, skip unallocated/meta/safety/GPT partitions
3. For each data partition: run `fls -r -p -o {offset} {imagePath}` to recursively list all files
4. Filter files against the regex search pattern
5. Output: array of `{ inode, path, partition_offset, partition_desc }` (no size/date metadata yet)

Fallback: if `mmls` fails (no partition table), tries `fls` directly with offset 0 (single-partition image).

For ZIP/UFDR archives:
1. Run `unzip -l {imagePath}` to list contents
2. Parse output for file paths, sizes, and dates
3. Output includes `size` and `modified` from the listing (metadata is already available)
4. Files are tagged with `is_zip: true`

Result stored as JSON in `image_jobs.result_data`.

### Phase 2 -- Metadata (image-metadata-worker.js)

**Endpoint**: `POST /api/images/metadata`
**Input**: `{ scanJobId, selectedIndices }` (indices into scan result array)

For E01 images:
1. Run `istat -o {offset} {imagePath} {inode}` on each selected file
2. Parse output for: size (`$DATA` attribute), created/modified/accessed timestamps, NTFS flags
3. **Cloud-only detection**: if `$STANDARD_INFORMATION` flags contain both `Sparse` and `Offline`, mark `is_cloud_only: true` (OneDrive/SharePoint files synced as placeholders)
4. Concurrency: 10 parallel `istat` calls

For ZIP/UFDR archives:
- Metadata is already embedded from the scan phase (size + modified date from `unzip -l` output)
- Worker passes through immediately without running any commands

Result: enriched file array with size, dates, and cloud-only flag, stored in `image_jobs.result_data`.

### Phase 3a -- Extract to Disk (image-extract-worker.js)

**Endpoint**: `POST /api/images/extract`
**Input**: `{ scanJobId, metadataJobId, selectedIndices, outputDir }`

Extracts files to a user-specified output directory (not into the investigation). Useful for pulling PST/OST files out of an E01 image to then upload them separately.

- E01: uses `icat -o {offset} {imagePath} {inode}` piped to a file
- ZIP/UFDR: uses `unzip -p {zipPath} {internalPath}` piped to a file

### Phase 3b -- Ingest into Investigation (image-ingest-worker.js)

**Endpoint**: `POST /api/images/ingest`
**Input**: `{ scanJobId, metadataJobId, selectedIndices, investigationId, custodian }`

Two internal phases:
1. **Extracting (0-40%)**: Pull each file from the image to a temp directory
   - Cloud-only files: skip extraction, insert metadata-only record with `is_cloud_only = 1` (no `filename`, no `text_content`)
   - E01 files: `icat` extraction
   - ZIP files: `unzip -p` extraction
2. **Ingesting (40-100%)**: Process extracted files
   - `.eml` files: full email pipeline (parse, thread, insert email + attachments)
   - Other files: copy to `uploads/{investigationId}/`, compute MD5, extract text + metadata, insert

### Post-ingestion (image-ingest-worker.js)

Full suite of cleanup:
1. `enableFtsTriggers()` + `rebuildFtsIndex()`
2. `recreateBulkIndexes()` (indexes were dropped at start)
3. `walCheckpoint(PASSIVE)`
4. `refreshInvestigationCounts()`
5. Temp directory cleaned up in `finally` block
6. FTS triggers and indexes are restored even on error (safety net in `finally`)

### File resolution between phases

The extract/ingest endpoints accept `metadataJobId` (optional). If provided and that job completed successfully, files are resolved from the metadata job's `result_data` (which has enriched size/date/cloud-only info). Otherwise, falls back to the scan job's `result_data`.

Both endpoints use `selectedIndices` -- an array of integer indices into the source file list. This avoids re-transmitting the full file list from client to server.

### Gotchas

- The scan worker opens its own `better-sqlite3` connection to the main DB (not using the pool from `server/lib/investigation-db.js`). It connects directly to the DB file path.
- `mmls` timeout is 60s; `fls` timeout is 300s (5 min) with 100MB buffer. Large images with millions of files may hit these limits.
- `istat` timeout is 30s per file. Failed metadata lookups default to size=0 and null dates -- they don't fail the whole batch.
- Cloud-only files (OneDrive/SharePoint placeholders) have `Sparse+Offline` NTFS flags. The file content on the disk image is typically a reparse point stub, not the actual file. Extracting via `icat` would yield garbage, so they are ingested as metadata-only records.
- The `unzip` exit code 1 means "warnings but data is fine" and is treated as success in the extraction helpers.
- The ingest worker has its own inline `resolveThreadId()` and `backfillThread()` implementations (not importing from `threading.js`) that use the worker's own DB connection.

---

## 5. WhatsApp Ingestion

**Worker**: `server/workers/chat-worker.js`
**Spawned by**: `spawnChatWorker()` in documents.js, or via UFDR extraction endpoint

Supports two input formats:
1. Bare `ChatStorage.sqlite` file (text-only, no media)
2. ZIP archive containing `ChatStorage.sqlite` + `Message/Media/` folder (full ingestion with media)

See [whatsapp-ingestion.md](./whatsapp-ingestion.md) for the full technical reference, including iOS SQLite schema, message type mapping, contact resolution, and day-chunking logic.

---

## 6. UFDR/ZIP Archive Scan

Uses the same 3-phase flow as E01 images (same endpoints, same workers) but branches internally based on file extension:

| Aspect | E01 Image | UFDR/ZIP Archive |
|--------|-----------|------------------|
| Scan tool | `mmls` + `fls` (Sleuth Kit) | `unzip -l` |
| Metadata tool | `istat` per file | Metadata embedded in scan output (pass-through) |
| Extraction tool | `icat` | `unzip -p` |
| Cloud-only detection | Yes (NTFS flags from istat) | No (not applicable) |
| Partition handling | Iterates over data partitions | Single flat listing |
| File identifier | `inode` + `partition_offset` | `path` (internal ZIP path) |

The archive path is determined by regex `/\.(zip|ufdr)$/i` in each worker. The `is_zip` flag on file entries signals downstream code to use `unzip` instead of `icat`.

### WhatsApp extraction from UFDR

**Endpoint**: `POST /api/images/extract-whatsapp`

Separate endpoint for extracting WhatsApp data from UFDR archives. Scans the archive for `ChatStorage.sqlite`, then spawns `whatsapp-zip-worker.js` to extract it + associated media into a new ZIP that can be uploaded via the normal chat worker flow.

---

## Shared Post-Ingestion Steps

All bulk workers (PST, ZIP, E01 ingest) share a common set of post-ingestion operations defined in `server/lib/worker-helpers.js`.

### FTS Trigger Management

The `documents_fts` virtual table is kept in sync via two triggers (`documents_ai` for INSERT, `documents_au` for UPDATE). During bulk imports:

1. `disableFtsTriggers()` -- drops both triggers before bulk insert
2. Bulk inserts proceed without FTS overhead
3. `rebuildFtsIndex()` -- runs `INSERT INTO documents_fts(documents_fts) VALUES('rebuild')` to reindex everything
4. `enableFtsTriggers()` -- recreates both triggers

The trigger SQL in `worker-helpers.js` must stay in sync with the canonical definitions in `server/lib/investigation-db.js`. If you add a column to the FTS table, update both places.

### Index Drop/Rebuild

Seven indexes are dropped before bulk imports and recreated after (defined in `BULK_DROP_INDEXES`):

- `idx_documents_status`
- `idx_documents_doc_type`
- `idx_documents_status_doctype`
- `idx_documents_thread_doctype`
- `idx_documents_content_hash`
- `idx_documents_is_duplicate`
- `idx_documents_inv_doctype`

Not all workers drop indexes. The PST and E01 ingest workers do. The ZIP worker does not (it only manages FTS triggers).

### WAL Checkpoint

`walCheckpoint()` runs `PRAGMA wal_checkpoint(PASSIVE)` which is safe to call from workers -- PASSIVE mode never blocks writers. This flushes the write-ahead log to the main database file.

### Investigation Count Refresh

`refreshInvestigationCounts()` updates precomputed counts on the `investigations` row:
- `document_count`, `email_count`, `attachment_count`, `chat_count`, `file_count`

Each is a subquery `COUNT(*)` filtered by `investigation_id` and `doc_type`.

### Doc Identifier Generation

Format: `{CASE}_{CUST}_{SEQ}` where:
- `CASE` = investigation `short_code` (3 chars, auto-generated or user-entered)
- `CUST` = custodian initials (varies by worker -- see gotcha below)
- `SEQ` = 5-digit zero-padded sequence number

Attachment identifiers append `_{3-DIGIT_SEQ}` (e.g., `INV_JOD_00042_003`).

Sequence numbers are resume-safe: each worker queries `MAX(CAST(SUBSTR(...)))` at startup to continue from the highest existing sequence.

### Content Hash Deduplication

All flows compute an MD5 hash of file content (`content_hash` column). If a document with the same hash already exists in the same investigation, the new document is inserted with `is_duplicate = 1`. The duplicate still gets its own row and doc identifier -- dedup is informational, not destructive.

Some workers (ZIP, PST) also maintain an in-memory `seenHashes` map for intra-batch dedup, avoiding DB round-trips for files that appear multiple times within the same import.

---

## Detailed Flow Diagram

```
                                   Upload Page (POST /api/documents/upload)
                                   =========================================
                                                    |
                          +---------+------+--------+--------+--------+
                          |         |      |        |        |        |
                        .eml    .pst/.ost .zip    .sqlite  .zip      other
                          |         |      |  (w/ ChatStorage) .db     |
                          |         |      |        |        |        |
                    [parseEml]  [Worker]  [Worker] [Worker] [Worker]  [extractText]
                          |     thread    thread   thread   thread    [extractMetadata]
                    processEmail  |        |        |        |        |
                    Data()     pst-      zip-    chat-    chat-     processRegular
                          |    worker   worker   worker   worker    File()
                          |      .js     .js      .js      .js       |
                          |         |      |        |        |        |
                          +----+----+------+--------+--------+--------+
                               |
                               v
                    +------------------------+
                    |   documents table       |
                    |   (id, doc_type,        |
                    |    text_content,         |
                    |    content_hash, ...)    |
                    +------------------------+
                               |
                               v
                    +------------------------+
                    |   documents_fts         |
                    |   (FTS5 virtual table)  |
                    +------------------------+


       E01/UFDR Forensic Extraction (POST /api/images/*)
       ==================================================

       Phase 1: Scan                Phase 2: Metadata          Phase 3: Ingest
       ─────────────                ─────────────────          ────────────────
       POST /scan                   POST /metadata             POST /ingest
            |                            |                          |
            v                            v                          v
       image-scan-                  image-metadata-            image-ingest-
       worker.js                    worker.js                  worker.js
            |                            |                          |
       ┌────┴────┐                  ┌────┴────┐                ┌────┴────┐
       │E01:     │                  │E01:     │                │Extract: │
       │ mmls    │                  │ istat   │                │ icat or │
       │ fls -r  │                  │ per file│                │ unzip -p│
       │         │                  │         │                │         │
       │UFDR/ZIP:│                  │UFDR/ZIP:│                │Cloud-   │
       │ unzip -l│                  │ pass-   │                │only:    │
       └────┬────┘                  │ through │                │ meta-   │
            |                       └────┬────┘                │ only    │
            v                            v                     └────┬────┘
       image_jobs                   image_jobs                      |
       result_data:                 result_data:                    v
       [{inode,path,                [{inode,path,             ┌──────────┐
         partition_offset}]           size,created,           │extractText│
                                      modified,              │extractMeta│
                                      is_cloud_only}]        │MD5 hash  │
                                                             │doc ID gen│
                                                             │threading │
                                                             └────┬─────┘
                                                                  |
                                                                  v
                                                           documents table
                                                           documents_fts
```

---

## Common Gotchas

1. **Worker DB connections**: Workers use `openWorkerDb(investigationId)` from `server/lib/investigation-db.js`. They must NOT set `journal_mode = WAL`. The pool already sets it when creating the DB, and re-setting in a worker thread causes a deadlock. Workers use `busy_timeout = 15000` to handle contention.

2. **FTS trigger sync**: The FTS trigger SQL in `worker-helpers.js` must match `server/lib/investigation-db.js`. If columns are added to `documents_fts`, update both places.

3. **Custodian initials inconsistency**: The PST worker and image-ingest-worker use 3-char initials (first 2 of first name + first of last). The ZIP worker uses 2-char initials (first of first + first of last). Direct upload uses the 3-char version.

4. **No auto-resume**: On server restart, stuck import jobs are marked `failed`. There is no automatic retry. The PST worker supports manual resume via the `extractionOnly` flag (re-runs Phase 2 text extraction only).

5. **File size limits**: Multer's file size limit is commented out. PST files can be multiple GB. Attachment extraction in the PST worker skips files > 100MB.

6. **Error recovery in workers**: All bulk workers wrap the main flow in try/catch and restore FTS triggers + indexes in a `finally` block. This prevents leaving the database in a degraded state (missing triggers/indexes) if the worker crashes mid-import.

7. **ZIP source cleanup**: The ZIP worker deletes the source ZIP after successful completion. PST and E01 workers do not delete their source files.

8. **Temp directory cleanup**: The E01 ingest worker creates a temp directory under `os.tmpdir()` and cleans it up in `finally`. Other workers extract directly into `uploads/{investigation_id}/`.
