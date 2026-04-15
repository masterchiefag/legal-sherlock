# Database Architecture

High-level overview of Sherlock's two-tier SQLite architecture.

---

## Overview

Sherlock uses a **split-database architecture**: one main SQLite database for global tables, plus a separate SQLite file per investigation for all document-scoped data.

```
data/
  ediscovery.db                    # Main DB: users, tags, investigations, audit_logs, settings
  investigations/
    {uuid-1}.db                    # Investigation 1: documents, FTS, reviews, classifications, ...
    {uuid-2}.db                    # Investigation 2: documents, FTS, reviews, classifications, ...
    ...
```

This design provides:
- **Write isolation**: Each investigation has its own WAL and write lock. Concurrent imports to different cases never contend.
- **Cache efficiency**: SQLite page cache and mmap are per-DB. A 3GB investigation DB gets much better cache coverage than a 30GB monolithic DB.
- **Corruption isolation**: A disk error during write corrupts one investigation, not all.
- **Simple archival**: Copy one `.db` file to archive a case. Delete it to purge.
- **Data separation**: No risk of cross-case data leaks from missing WHERE clauses.

---

## Main DB (`data/ediscovery.db`)

Managed by `server/db.js`. Contains tables that span across investigations or are not investigation-scoped.

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, password_hash, role) |
| `tags` | Global tag definitions (name, color) |
| `investigations` | Case metadata + precomputed document counts |
| `investigation_members` | User-to-investigation access mapping |
| `audit_logs` | Full audit trail |
| `system_settings` | App-level configuration (OCR settings, etc.) |
| `image_jobs` | E01/UFDR scan/extract job tracking |

The `investigations` table stores precomputed counts (`document_count`, `email_count`, `attachment_count`, `chat_count`, `file_count`) that are refreshed after each ingestion via `refreshInvestigationCounts()`.

---

## Per-Investigation DBs (`data/investigations/{uuid}.db`)

Managed by `server/lib/investigation-db.js`. Each investigation gets its own file with full schema including FTS.

| Table | Purpose |
|-------|---------|
| `documents` | Core document store (emails, attachments, files, chats) |
| `document_tags` | Tag assignments (denormalized `tag_name`, `tag_color`) |
| `document_reviews` | Review status tracking |
| `classifications` | AI relevance scores |
| `import_jobs` | PST/ZIP/chat import job tracking |
| `summarization_jobs` | Batch summarization tracking |
| `summaries` | Per-document LLM summaries |
| `review_batches` | Review batch assignments |
| `review_batch_documents` | Batch-to-document mapping |
| `documents_fts` | FTS5 virtual table with auto-sync triggers |

---

## Connection Management

### Request Path (LRU Pool)

`server/lib/investigation-db.js` maintains an LRU pool of up to 5 connection pairs (write + read-only).

```
Request → withInvestigationDb middleware → getInvestigationDb(id)
                                              ↓
                                         LRU pool hit? → return cached pair
                                              ↓ miss
                                         evict oldest → open new pair → apply schema/migrations
                                              ↓
                                         req.invDb (write), req.invReadDb (read-only)
```

Both connections are configured with:
- WAL mode, `busy_timeout = 15000` (write) / `1000` (read)
- 64MB page cache, 256MB mmap
- Custom `file_ext()` SQL function

### Worker Path (Standalone)

Workers (PST, ZIP, chat) use `openWorkerDb(investigationId)` for standalone connections that are **not pooled**. Workers must close connections in a `finally` block. Workers do NOT set `journal_mode = WAL` (already set by pool on creation).

### Lifecycle

| Operation | Function |
|-----------|----------|
| Get/create pooled pair | `getInvestigationDb(id)` |
| Open standalone (workers) | `openWorkerDb(id)` |
| Close one | `closeInvestigationDb(id)` |
| Close all (shutdown) | `closeAll()` |
| Delete DB + WAL/SHM | `deleteInvestigationDb(id)` |
| List all DB files | `listInvestigationDbs()` |
| WAL checkpoint all | `checkpointAll()` |

---

## Cross-DB Patterns

### Denormalized Tags

`document_tags` in each investigation DB stores `tag_name` and `tag_color` alongside `tag_id`. This avoids cross-DB JOINs with the main DB's `tags` table.

- **Tag creation/rename**: Updates `tags` in main DB, syncs denormalized columns in current investigation's `document_tags`
- **Tag assignment**: Looks up tag from main DB, writes denormalized values to investigation DB
- **Known limitation**: Tag rename only updates current investigation; other investigations show stale names until accessed

### Investigation Counts

After ingestion, workers refresh precomputed counts:

```js
refreshInvestigationCounts(mainDb, invDb, investigationId);
// Reads from investigation DB → writes to investigations table in main DB
```

This is not transactional across DBs. A crash between read and write leaves stale counts (cosmetic only).

### Threading

`server/lib/threading.js` accepts the investigation DB as its first parameter:

```js
resolveThreadId(invDb, messageId, inReplyTo, references);
backfillThread(invDb, threadId, messageId, references);
```

This scopes thread resolution to a single investigation, preventing cross-case thread collisions.

---

## Performance Characteristics

| Factor | Monolithic (30GB) | Per-Investigation (3GB each) |
|--------|-------------------|------------------------------|
| Page cache hit rate | ~0.2% (64MB / 30GB) | ~2% (64MB / 3GB) |
| mmap coverage | ~0.8% (256MB / 30GB) | ~8.5% (256MB / 3GB) |
| B-tree depth | 4-5 levels | 3 levels |
| Write contention | All cases share one lock | Zero cross-case contention |
| WAL checkpoint | Proportional to full DB | Proportional to single case |
| VACUUM | Requires 30GB temp space | Requires 3GB temp space |
| Inactive cases | Inflate indexes and queries | Not loaded (zero cost) |

---

## Migration

One-time migration from monolithic to per-investigation databases:

```bash
node server/scripts/migrate-to-per-investigation-db.js          # skip existing
node server/scripts/migrate-to-per-investigation-db.js --force   # re-migrate all
```

The script copies documents, tags, reviews, classifications, import jobs, summaries, and review batches per investigation. It denormalizes tag names/colors and rebuilds FTS indexes. Idempotent and safe to re-run.
