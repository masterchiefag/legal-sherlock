# Sherlock

eDiscovery platform for uploading, searching, reviewing, and tagging documents for litigation and compliance workflows. Supports multi-case investigations with email threading, deduplication, and AI-powered relevance scoring.

## Dev Commands

```bash
npm run dev          # Start both client (port 5173) and server (port 3001)
npm run dev:client   # Vite dev server only
npm run dev:server   # Express server with --watch
npm run build        # Production build (Vite)
npm run preview      # Preview production build
npm test             # Run tests (vitest run)
npm run test:watch   # Watch mode
```

## Tech Stack

- **Frontend**: React 18, React Router, Vite
- **Backend**: Express.js (Node.js, ES modules)
- **Database**: SQLite via better-sqlite3 (WAL mode, foreign keys enabled)
- **Document processing**: pdf-parse, mammoth (DOCX), xlsx (XLS/XLSX), mailparser, postal-mime, readpst (native CLI for PST), pst-extractor (MAPI-level reads)
- **Container extraction**: `unzip`/`jszip` (ZIP), `pdfdetach` from poppler-utils (PDF portfolios), `tnef` (winmail.dat), `@kenjiuno/msgreader` (embedded MSG)
- **HTML sanitization**: `isomorphic-dompurify` (server-side DOMPurify for email HTML bodies)
- **Forensic extraction**: The Sleuth Kit (mmls, fls, icat for E01 images), unzip (UFDR/ZIP archives)
- **File uploads**: Multer (5GB limit), ZIP archive ingestion via zip-worker
- **AI classification/summarization**: Pluggable LLM providers (Ollama, OpenAI, Anthropic)
- **Auth**: bcryptjs (password hashing), jsonwebtoken (JWT sessions)
- **Package manager**: npm

## Project Structure

```
src/                    # React frontend
  pages/                # Page components
    Dashboard.jsx       # Overview stats, recent uploads
    Upload.jsx          # File upload with progress, PST import
    Search.jsx          # FTS5 search with filters, batch AI classify, card/table view toggle
    DocumentReview.jsx  # Document viewer with inline PDF/image rendering
    ClassificationLogs.jsx  # AI classification logs + model comparison
    Investigations.jsx  # Case/investigation CRUD and management
    Playground.jsx      # Interactive LLM testing interface
    ImageExtraction.jsx # E01/UFDR scanning and file extraction
    SummarizationJobs.jsx # Batch summarization jobs + results with markdown modal
    Login.jsx           # Login / first-user registration page
    UserManagement.jsx  # Admin: user CRUD, role management
    AuditLog.jsx        # Admin: paginated audit trail viewer
  contexts/             # React context providers
    AuthContext.jsx     # Auth state, login/logout/register, token validation
  utils/                # Shared utilities
    api.js              # Auth-aware fetch wrapper (apiFetch, apiPost, etc.)
    format.js           # formatSize, getScoreColor, getScoreLabel
    sanitize.js         # escapeHtml, highlightText (XSS-safe)
  App.jsx               # Root layout with sidebar + routing + auth gate
  main.jsx              # Entry point (wraps with AuthProvider)
  index.css             # Global styles with CSS variables

server/                 # Express backend
  index.js              # Server setup, middleware, auth enforcement, graceful shutdown
  db.js                 # SQLite schema, migrations, indexes, and connection
  middleware/           # Express middleware
    auth.js             # authenticate, requireAuth, requireRole, requireInvestigationAccess
    investigation-db.js # withInvestigationDb — attaches req.invDb/req.invReadDb per request
  routes/               # API route handlers
    auth.js             # Login, register, me, setup-status, change-password
    users.js            # Admin: user CRUD (list, create, update, deactivate)
    audit-logs.js       # Admin: paginated audit log query
    documents.js        # Upload, list, delete, PST import jobs, doc identifier generation, GET /:id/html for sanitized email HTML
    search.js           # FTS5 full-text search with filters + NL2SQL + doc ID search
    summarize.js        # Batch summarization jobs + per-document summarization
    images.js           # E01/UFDR scan + extract jobs (admin only)
    tags.js             # Tag CRUD
    reviews.js          # Document review status + dashboard stats
    classify.js         # AI classification + batch ops + logs + model comparison
    investigations.js   # Investigation/case CRUD + member management
    playground.js       # Freeform LLM queries with model/temperature selection
  lib/                  # Utilities
    auth.js             # Password hashing (bcrypt) + JWT token generation/verification
    audit.js            # Audit logging function + action constants
    extract.js          # Text extraction (PDF, DOCX, XLS/XLSX, DOC, TXT, CSV, MD)
    extract-worker.js   # Subprocess-based extraction with timeout/SIGKILL
    config.js           # Shared configuration constants
    eml-parser.js       # .eml email parsing; computes dedup_md5; surfaces rfc822 embedded parts; writes HTML sidecar + inline-image files
    pst-parser.js       # Outlook PST folder walking + extractNonEmailMapi() for calendar/task/note/contact
    msg-parser.js       # Embedded MSG parsing via @kenjiuno/msgreader (Phase 1.5)
    container-helpers.js # ZIP list/extract (with unzip -p timeout), PDF portfolio detect/extract, TNEF extract, archive helpers
    llm-providers.js    # LLM provider abstraction (Ollama, OpenAI, Anthropic)
    investigation-db.js # Per-investigation DB pool, schema, openWorkerDb(), refreshInvestigationCounts()
    threading.js        # Email thread resolution and backfill (accepts db as first param)
    threading-cached.js # In-memory cached threading for PST worker
    worker-helpers.js   # Shared bulk-ingestion utilities (FTS, indexes, replicateChildrenToDuplicates for fan-out)
    settings.js         # System settings read/write
  scripts/
    migrate-to-per-investigation-db.js  # One-time migration from monolithic DB
  workers/
    pst-worker.js       # Background PST extraction via native readpst CLI
    image-scan-worker.js    # Scan E01/UFDR for PST/OST files
    image-extract-worker.js # Extract selected files from E01/UFDR
    chat-worker.js          # WhatsApp SQLite chat ingestion
    zip-worker.js           # ZIP archive ingestion (extract & process files)

uploads/                # Uploaded files (git-ignored), organized by investigation_id subdirs
data/                   # SQLite databases (git-ignored)
  ediscovery.db         # Main DB (users, tags, investigations, audit_logs, etc.)
  investigations/       # Per-investigation DBs ({uuid}.db) with documents, FTS, reviews, etc.
docs/                   # Architecture and feature reference docs
```

## Code Conventions

- **ES modules** everywhere (`import`/`export`, not `require`)
- **camelCase** for JS variables and functions, **PascalCase** for React components
- **snake_case** for database columns and API query parameters
- **UUIDs** (v4) for all primary keys
- Parameterized SQL queries (prepared statements) for all DB access
- React functional components with hooks (no class components, no state management library)
- XHR for file uploads (not fetch) to get progress events
- Frontend API calls go through Vite proxy (`/api/*` and `/uploads/*` -> port 3001)

## Git Conventions

Conventional commits with imperative mood:
- `feat: add batch classification UI`
- `fix: patch pst-extractor infinite loop`

## Database

**Two-tier SQLite architecture** — a main DB for global tables + per-investigation DB files for document data. See [docs/db-architecture.md](docs/db-architecture.md) and [docs/per-investigation-db.md](docs/per-investigation-db.md) for full details.

- **Main DB** (`data/ediscovery.db`): `users`, `tags`, `investigations`, `investigation_members`, `audit_logs`, `system_settings`, `image_jobs`. Managed by `server/db.js`.
- **Per-investigation DBs** (`data/investigations/{uuid}.db`): `documents`, `document_tags`, `document_reviews`, `classifications`, `import_jobs`, `summarization_jobs`, `summaries`, `review_batches`, `review_batch_documents`, `documents_fts`. Managed by `server/lib/investigation-db.js` (LRU connection pool, 5 slots).

Key access patterns:
- **Request path**: `withInvestigationDb` middleware (`server/middleware/investigation-db.js`) resolves `investigation_id` and attaches `req.invDb` (write) / `req.invReadDb` (read-only) from the LRU pool.
- **Workers**: `openWorkerDb(investigationId)` from `server/lib/investigation-db.js` — standalone connection, caller must close. Do NOT set `journal_mode = WAL` in workers.
- **Cross-DB**: `document_tags` stores denormalized `tag_name`/`tag_color` to avoid cross-DB JOINs. `refreshInvestigationCounts(mainDb, invDb, id)` reads from investigation DB, writes to main DB.
- **Threading**: `server/lib/threading.js` accepts `db` as first parameter (investigation DB connection).

Notable document columns: `doc_type` (file/email/attachment/chat/calendar/task/note/contact), `parent_id` (attachment→email), `thread_id`, `message_id`, `in_reply_to`, `email_references`, `content_hash`, `is_duplicate`, `dedup_md5` (email-level content fingerprint), `duplicate_folders` (JSON array of additional folders the same content appeared in), `investigation_id`, `doc_identifier` (CASE_CUST_00001 format), `recipient_count`, full email headers (from/to/cc/bcc/subject/date), document metadata (author/title/created_at/keywords), `has_html_body` / `inline_images_meta` (HTML email rendering), `file_extension` (indexed, lowercase, no dot), `event_start_at` / `event_end_at` / `event_location` / `mapi_class` (MAPI non-email items), `folder_path` (PST folder the email lived in).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `LLM_PROVIDER` | `ollama` | AI provider: `ollama`, `openai`, `anthropic` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `gemma3:4b` | Ollama model name |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `CORS_ORIGIN` | `true` (all origins) | Restrict CORS in production |
| `JWT_SECRET` | auto-generated | **Required in production**. Secret for JWT signing |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost factor for password hashing |

## Key Patterns

- **Authentication**: Local email/password auth via bcryptjs + JWT (24h expiry). First registered user auto-becomes admin. `authenticate` middleware populates `req.user` globally; `requireAuth` enforces on all `/api/*` except `/api/auth/login`, `/api/auth/register`, `/api/auth/setup-status`, `/api/health`. Frontend stores JWT in localStorage, `apiFetch()` wrapper auto-attaches `Authorization: Bearer` header, global 401 triggers logout.
- **Authorization**: 3 roles — Admin (full access + user management), Reviewer (CRUD within assigned investigations), Viewer (read-only on assigned investigations). `requireRole(...roles)` middleware gates routes. `requireInvestigationAccess` checks `investigation_members` table (admins bypass). Investigation list auto-filtered by membership for non-admins. Search auto-scoped to user's investigations.
- **Audit logging**: All significant actions logged to `audit_logs` table via `logAudit()` from `server/lib/audit.js`. Action constants in `ACTIONS` object (auth.login, document.upload, review.update, etc.). Admin-only `/api/audit-logs` endpoint with pagination and action prefix filtering.
- **Investigations**: Multi-case support with per-investigation SQLite databases; all documents, imports, and searches scoped to active investigation; `withInvestigationDb` middleware resolves and attaches DB connections from LRU pool; investigation selector in sidebar; explicit membership via `investigation_members` table; member management endpoints `GET/POST/DELETE /:id/members` (admin only); investigation deletion removes DB file + uploads directory
- **PST import**: Multi-phase ingestion via native `readpst -e -D` CLI plus MAPI-level supplements via `pst-extractor`. See [docs/ingestion-flows.md](docs/ingestion-flows.md) and [docs/pst-parsing-nuances.md](docs/pst-parsing-nuances.md). Phase order:
  - **Phase 1** — parse .eml files output by readpst, insert emails + attachments
  - **Phase 1.2** — correct email dates from MAPI via `pst-extractor` (readpst fabricates dates for some classes; GitHub issue #65 / #70)
  - **Phase 1.3** — ingest MAPI non-email items: calendar, task, note, contact (readpst's `-e` drops them; GitHub issue #65 Phase 2)
  - **Phase 1.4** — unwrap `IPM.Note.SMIME.MultipartSigned` envelopes: pull attachment 0's `fileInputStream` via `pst-extractor`, parse through `postal-mime`, insert real attachments as children of the matching email row (GitHub issue #79)
  - **Phase 1.5** — parse embedded MSG attachments via `@kenjiuno/msgreader` (forwarded messages as `message/rfc822`)
  - **Phase 1.6** — extract ZIP archive contents and insert as child attachments
  - **Phase 1.7** — detect + extract PDF portfolios via `pdfdetach` (PDF packages carrying embedded files)
  - **Phase 1.8** — extract TNEF `winmail.dat` contents
  - **Phase 1.9** — fixed-point recursion into nested containers (ZIP-in-ZIP, PDF portfolio inside a ZIP, etc.), hard cap of 5 passes to block ZIP bombs (GitHub issue #80)
  - **Phase 2** — extract text from all files via `extract-worker.js` subprocess with timeout/SIGKILL
  - Job tracking in `import_jobs` table, polled from frontend every 3s. Stuck jobs marked as failed on server restart (no auto-resume).
- **Worker thread DB**: Workers use `openWorkerDb(investigationId)` from `server/lib/investigation-db.js` for standalone connections (not pooled); `timeout: 15000` and `busy_timeout = 15000`; do NOT set `journal_mode = WAL` in workers (already set by main process, setting it again deadlocks); caller must close in `finally` block
- **Email threading**: Resolves `thread_id` via `In-Reply-To`/`References` headers with exact message-ID matching; backfill unifies orphan threads on late-arriving emails
- **Email hierarchy**: `doc_type` (file/email/attachment/chat/calendar/task/note/contact) with `parent_id` linking attachments to parent emails. MAPI non-email items (Phase 1.3) carry `doc_type` of calendar/task/note/contact plus `event_start_at` / `event_end_at` / `event_location` / `mapi_class` metadata; no file on disk (body lives in `text_content`).
- **Attachment deduplication**: MD5 `content_hash` on upload; `is_duplicate` flag points at byte-identical earlier copies. Children of deduplicated emails are fanned out to every canonical parent via `replicateChildrenToDuplicates` in `worker-helpers.js` so reviewers see the full attachment tree regardless of which email copy they open (GitHub issue #73). Uses a JS-driven pairing loop with temp tables — a single SQL JOIN hits a quadratic query plan on Yesha-scale data (GitHub issue #77).
- **Email dedup (content-hash)**: `dedup_md5` = MD5 of canonical email form (from/to/cc/bcc, subject, date, collapsed text body, **sorted attachment MD5s**). Same `dedup_md5` seen in a *different* folder collapses onto the primary row; the new folder path is appended to `duplicate_folders` JSON. Different attachments ⇒ different hashes ⇒ both rows kept — this is the discriminator that fixes Gmail's draft/sent Message-ID collision (GitHub issue #61). Computed in `server/lib/eml-parser.js`; worker logic in `server/workers/pst-worker.js`. Surfaced in the DocumentReview sidebar as "Content hash" + "Also appeared in". See [docs/email-deduplication.md](docs/email-deduplication.md).
- **Embedded RFC822 surfacing**: `eml-parser.js` passes `forceRfc822Attachments: true` to postal-mime so forwarded messages show up in `attachments` (not merged into the parent body); Phase 1.5's `mime_type='message/rfc822'` query then extracts them into child rows.
- **HTML email rendering**: Emails with an HTML body have `has_html_body=1` and an HTML sidecar at `uploads/{inv}/html/{emailId}.html`; inline CID images land in `uploads/{inv}/html/{emailId}/imageNNN.ext` and their metadata is stored as JSON in `inline_images_meta`. `GET /api/documents/:id/html` serves the sanitized HTML: relative CID paths are rewritten to `/uploads/...` URLs, the body is run through server-side DOMPurify (WHOLE_DOCUMENT, forbidden tags/attrs), external image sources are stripped to block tracking pixels, and the response is served into a sandboxed `<iframe>` on the DocumentReview page. DocumentReview has a two-tab viewer (HTML | Plain text) that falls back to text when no HTML body is present. See [docs/html-email-rendering.md](docs/html-email-rendering.md).
- **Doc identifiers**: Format `CASE_CUST_00001` — case short_code (3 chars auto or user-entered) + custodian initials (3 chars: first 2 of first name + first of last, or first 3 of single name, `XXX` if none) + 5-digit sequence. Attachments append `_001`. Generated in PST worker, chat worker, and direct upload path.
- **Search**: FTS5 with support for AND (implicit), OR, exact phrases, and exclusion operators; filterable by status, tags, date range, doc_type, AI score (scored/unscored/3+/4+/5), and investigation; latest-in-thread filter; thread position display (#N of M); text preview for filter-only queries; NL2SQL via "Ask AI" button; search state persisted in URL params for back-button support; doc_identifier search bypasses FTS with LIKE filter; card/table view toggle with sortable/filterable columns
- **AI classification**: Scores documents 1-5 with reasoning via pluggable LLM providers; supports batch classification from search results; model comparison via AI Logs page
- **Batch summarization**: Summarize documents via LLM with configurable prompts; job tracking in `summarization_jobs` table; results viewable in Summaries page with markdown modal
- **LLM Playground**: Freeform model testing with configurable temperature, max tokens, context window, and system prompts
- **Text extraction**: `server/lib/extract.js` dispatches by file extension (PDF, DOCX, XLS/XLSX, DOC, TXT, CSV, MD) with graceful fallback on parse failure; subprocess-based extraction via `extract-worker.js` with 15s timeout + SIGKILL for CPU-bound parsers
- **ZIP ingestion**: `zip-worker.js` extracts ZIP archives, processes contained files (including nested PST/OST), and ingests them into the investigation. `container-helpers.js` wraps both `jszip` and the `unzip -p` fallback with `UNZIP_FALLBACK_TIMEOUT_MS` (default 60s) + SIGKILL so corrupt/encrypted ZIPs can't hang the pipeline (GitHub issue #72).
- **Document viewer**: Inline rendering for PDFs (`<object>` tag) and images; fallback to extracted text; "Open in new tab" link for PDFs. Emails render in a two-tab HTML/Plain view when `has_html_body=1` (see HTML email rendering pattern above).
- **Thread tree view**: DocumentReview page shows email thread as hierarchical tree using `message_id`/`in_reply_to` relationships; CSS-drawn connector lines; handles branching and orphaned messages
- **E01/UFDR extraction**: Scan forensic disk images (E01 via Sleuth Kit) or UFDR/ZIP archives (via unzip) for PST/OST files; select and extract to disk; job tracking in `image_jobs` table, investigation-independent
- **WhatsApp ingestion**: Parses iOS `ChatStorage.sqlite` via `chat-worker.js`; groups messages by session + calendar day into `doc_type='chat'` documents; thread ID `wa-chat-{session_id}` groups all days of same chat
- **NL2SQL search**: "Ask AI" button translates natural language queries to FTS5 search params via Ollama/Gemma; `POST /api/search/nl-to-sql` endpoint; editable generated queries
