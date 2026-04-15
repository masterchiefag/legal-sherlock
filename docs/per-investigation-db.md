# Per-Investigation Database Architecture

Technical reference for the split-database architecture where each investigation gets its own SQLite file instead of sharing a monolithic database.

---

## Overview

```
data/
  ediscovery.db                    # Main DB: global tables (users, tags, investigations, ...)
  investigations/
    {investigation-uuid-1}.db      # Documents, reviews, classifications, FTS for investigation 1
    {investigation-uuid-2}.db      # Documents, reviews, classifications, FTS for investigation 2
    ...
```

The main DB (`data/ediscovery.db`) holds tables that span across investigations or are not investigation-scoped. Each investigation's document data lives in its own SQLite file at `data/investigations/{uuid}.db`.

---

## Table Split

### Main DB (`data/ediscovery.db`)

| Table | Purpose |
|-------|---------|
| `tags` | Global tag definitions (name, color) |
| `investigations` | Case metadata + precomputed document counts |
| `users` | User accounts and roles |
| `investigation_members` | User-to-investigation access mapping |
| `audit_logs` | Full audit trail |
| `system_settings` | App-level configuration |
| `image_jobs` | E01/UFDR scan/extract job tracking (investigation-independent) |

### Per-Investigation DB (`data/investigations/{uuid}.db`)

| Table | Purpose |
|-------|---------|
| `documents` | Core document store |
| `document_tags` | Tag assignments (with denormalized `tag_name`, `tag_color`) |
| `document_reviews` | Review status tracking |
| `classifications` | AI relevance scores |
| `import_jobs` | PST/ZIP/chat import job tracking |
| `summarization_jobs` | Batch summarization job tracking |
| `summaries` | Per-document LLM summaries |
| `review_batches` | Review batch assignments |
| `review_batch_documents` | Batch-to-document mapping |
| `documents_fts` | FTS5 virtual table with auto-sync triggers |

---

## Key Files

| File | Role |
|------|------|
| `server/lib/investigation-db.js` | LRU connection pool, schema init, migrations, `openWorkerDb()`, `deleteInvestigationDb()`, `refreshInvestigationCounts()` |
| `server/middleware/investigation-db.js` | Express middleware attaching `req.invDb` / `req.invReadDb` per request |
| `server/db.js` | Main DB schema (tags, investigations, users, etc.) |
| `server/lib/worker-helpers.js` | Shared bulk-ingestion utilities (FTS triggers, index management) -- all functions accept `db` as first arg |
| `server/lib/threading.js` | Email threading -- accepts `db` as first parameter |
| `server/lib/threading-cached.js` | In-memory cached threading for PST worker -- uses internal cache, no `db` param |
| `server/scripts/migrate-to-per-investigation-db.js` | One-time migration from monolithic DB |

---

## Connection Management

### LRU Pool (request path)

`server/lib/investigation-db.js` maintains a pool of up to 5 connection pairs (write + read-only). Each entry is keyed by `investigation_id` and evicts the least-recently-used pair when full.

```js
import { getInvestigationDb } from '../lib/investigation-db.js';

const { db, readDb } = getInvestigationDb(investigationId);
// db    = write connection (WAL, busy_timeout=15000, mmap=256MB)
// readDb = read-only connection (WAL, busy_timeout=1000, mmap=256MB)
```

Both connections register a custom `file_ext()` SQL function for extension extraction.

New databases get the full schema applied via `initSchema()`. Existing databases run idempotent migrations via `runMigrations()`.

### Express Middleware

`server/middleware/investigation-db.js` resolves `investigation_id` from query params, route params, or request body and attaches pool connections:

```js
import { withInvestigationDb } from '../middleware/investigation-db.js';

router.get('/documents', withInvestigationDb, (req, res) => {
    const docs = req.invReadDb.prepare('SELECT ...').all();
    // req.invDb      = write connection
    // req.invReadDb  = read-only connection
    // req.investigationId = resolved ID
});
```

### Worker Connections (background jobs)

Workers use standalone connections that are **not pooled**. The caller must close them.

```js
import { openWorkerDb } from '../lib/investigation-db.js';

const db = openWorkerDb(investigationId);
try {
    // ... bulk inserts ...
} finally {
    db.close();
}
```

Worker connections intentionally skip `pragma journal_mode = WAL` -- see Gotchas.

### Lifecycle

| Operation | Function |
|-----------|----------|
| Close one investigation | `closeInvestigationDb(id)` |
| Close all (graceful shutdown) | `closeAll()` |
| Delete investigation DB + WAL/SHM files | `deleteInvestigationDb(id)` |
| List all investigation DB files | `listInvestigationDbs()` |
| Checkpoint all pooled connections | `checkpointAll()` |

---

## Cross-DB Patterns

### Denormalized Tag Columns

`document_tags` in each investigation DB stores `tag_name` and `tag_color` alongside the `tag_id`. This avoids cross-DB JOINs with the `tags` table in the main DB.

When a tag is renamed or recolored (via `PUT /api/tags/:id`), the route updates the main DB's `tags` table and then syncs the denormalized columns in the **current investigation's** `document_tags`. Other investigations are not updated (TODO: fan-out to all investigation DBs).

When assigning a tag, the route looks up `tag.name` and `tag.color` from the main DB and writes them into the investigation DB's `document_tags` row.

### Investigation Count Refresh

Document counts are precomputed on `investigations` rows in the main DB. After bulk ingestion, workers call:

```js
import { refreshInvestigationCounts } from '../lib/investigation-db.js';

refreshInvestigationCounts(mainDb, invDb, investigationId);
// Reads COUNT(*) grouped by doc_type from invDb
// Writes document_count, email_count, attachment_count, chat_count, file_count to mainDb
```

### Threading

`server/lib/threading.js` accepts `db` (the investigation DB connection) as its first parameter for `resolveThreadId()` and `backfillThread()`, instead of importing a global singleton. This allows the same threading logic to work against any investigation DB.

The cached variant (`threading-cached.js`) uses an in-memory LRU and does not accept a `db` parameter -- it must be initialized with the correct DB before use.

---

## Migration

One-time migration from monolithic to per-investigation databases:

```bash
node server/scripts/migrate-to-per-investigation-db.js          # skip existing DBs
node server/scripts/migrate-to-per-investigation-db.js --force   # re-migrate all
```

The script:
1. Opens `data/ediscovery.db` read-only
2. Loads all tags into a map for denormalization
3. For each investigation:
   - Creates `data/investigations/{id}.db` with full schema
   - Copies documents, document_tags, document_reviews, classifications, import_jobs, summarization_jobs, summaries, review_batches, review_batch_documents
   - Backfills `tag_name`/`tag_color` on document_tags from the tag map
   - Rebuilds FTS index
   - Verifies row counts match source
4. Checkpoints WAL and closes

Idempotent: skips investigations that already have a DB file (unless `--force`). On `--force`, deletes the existing DB before re-migrating. Partial failures are cleaned up (incomplete DB files removed).

---

## Stuck Job Recovery at Startup

On server start, `server/index.js` scans **all** investigation DBs for stuck import jobs:

```js
const invIds = listInvestigationDbs();
for (const invId of invIds) {
    const { db: invDb } = getInvestigationDb(invId);
    // SELECT ... FROM import_jobs WHERE status IN ('processing', 'pending')
    // UPDATE ... SET status = 'failed'
}
```

This replaces the old single-DB scan and ensures no investigation is missed.

---

## Gotchas

1. **Do not set `journal_mode = WAL` in worker connections.** The pool already sets WAL when creating the database. `openWorkerDb()` deliberately skips this pragma. Setting WAL from a worker while the pool holds an open connection can deadlock.

2. **`investigation_id` column is retained.** Per-investigation tables still have `investigation_id` columns for compatibility. All rows in a given DB belong to that investigation. The column is indexed but functionally redundant within a single DB.

3. **Investigation deletion is a file delete.** `deleteInvestigationDb()` closes connections and removes the `.db`, `-wal`, and `-shm` files. No need for multi-table CASCADE deletes.

4. **Tag rename fan-out is incomplete.** Renaming a tag only updates denormalized columns in the current investigation's `document_tags`. Other investigations will show stale tag names/colors until a fan-out across all DBs is implemented.

5. **FTS integrity is self-healing.** On pool connection open, if the FTS integrity check fails, the pool automatically rebuilds the FTS index. If rebuild fails, it drops and recreates the FTS table.

6. **`extract.js` config uses lazy getters.** Environment variables for LLM providers are read at call time, not import time. This avoids stale config if env vars change, but means import-time validation won't catch missing vars.

7. **Stuck job scan iterates all DBs.** At startup, every investigation DB file is opened (via the pool) to check for stuck jobs. For deployments with many investigations, this means the first few may be evicted from the 5-slot pool before the scan completes.

8. **Pool eviction closes connections.** When the LRU pool is full, the least-recently-used connection pair is closed. Any in-flight reads on an evicted read-only connection will fail. In practice this is safe because Express requests complete quickly.
