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
- **Document processing**: pdf-parse, mammoth (DOCX), xlsx (XLS/XLSX), mailparser, readpst (native CLI for PST)
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
  routes/               # API route handlers
    auth.js             # Login, register, me, setup-status, change-password
    users.js            # Admin: user CRUD (list, create, update, deactivate)
    audit-logs.js       # Admin: paginated audit log query
    documents.js        # Upload, list, delete, PST import jobs, doc identifier generation
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
    eml-parser.js       # .eml email parsing
    pst-parser.js       # Outlook PST folder walking
    llm-providers.js    # LLM provider abstraction (Ollama, OpenAI, Anthropic)
    threading.js        # Email thread resolution and backfill
  workers/
    pst-worker.js       # Background PST extraction via native readpst CLI
    image-scan-worker.js    # Scan E01/UFDR for PST/OST files
    image-extract-worker.js # Extract selected files from E01/UFDR
    chat-worker.js          # WhatsApp SQLite chat ingestion
    zip-worker.js           # ZIP archive ingestion (extract & process files)

uploads/                # Uploaded files (git-ignored)
data/                   # SQLite database (git-ignored)
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

SQLite at `data/ediscovery.db`. Programmatic migrations in `server/db.js` using a `columnExists()` helper to add columns idempotently.

Key tables:
- `documents` — Core document store with email metadata, threading, deduplication, and investigation scoping
- `investigations` — Case management (name, description, status, allegation, key_parties, date_range)
- `classifications` — AI scores with model, elapsed time, reasoning, investigation_prompt
- `tags`, `document_tags` — Tagging system
- `document_reviews` — Review status tracking (pending/relevant/not_relevant/privileged), reviewer_id
- `users` — User accounts (email, password_hash, name, role: admin/reviewer/viewer, is_active)
- `investigation_members` — Explicit user-to-investigation access (user_id, investigation_id, role_override)
- `audit_logs` — Full audit trail (user_id, action, resource_type, resource_id, details JSON, ip_address)
- `import_jobs` — PST import job tracking with phase and investigation_id
- `image_jobs` — E01/UFDR scan and extraction job tracking (type, status, progress, result_data as JSON)
- `summarization_jobs` — Batch summarization job tracking (prompt, model, progress)
- `summaries` — Per-document summaries linked to jobs
- `documents_fts` — FTS5 virtual table (original_name, text_content, email_subject, email_from, email_to) with auto-sync triggers

Notable document columns: `doc_type` (file/email/attachment/chat), `parent_id` (attachment→email), `thread_id`, `message_id`, `in_reply_to`, `email_references`, `content_hash`, `is_duplicate`, `investigation_id`, `doc_identifier` (CASE_CUST_00001 format), `recipient_count`, full email headers (from/to/cc/bcc/subject/date), document metadata (author/title/created_at/keywords).

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
- **Investigations**: Multi-case support; all documents, imports, and searches scoped to active investigation via `investigation_id`; investigation selector in sidebar; explicit membership via `investigation_members` table; member management endpoints `GET/POST/DELETE /:id/members` (admin only)
- **PST import**: Two-phase ingestion via native `readpst -e -D` CLI — Phase 1 parses emails + writes attachments, Phase 2 extracts text via subprocess with timeout; job tracking in `import_jobs` table, polled from frontend every 3s; stuck jobs marked as failed on server restart (no auto-resume)
- **Worker thread DB**: Workers open their own `better-sqlite3` connection with `timeout: 15000` and `busy_timeout = 10000`; do NOT set `journal_mode = WAL` in workers (already set by main process, setting it again deadlocks)
- **Email threading**: Resolves `thread_id` via `In-Reply-To`/`References` headers with exact message-ID matching; backfill unifies orphan threads on late-arriving emails
- **Email hierarchy**: `doc_type` (file/email/attachment/chat) with `parent_id` linking attachments to parent emails
- **Deduplication**: MD5 `content_hash` on upload; `is_duplicate` flag for duplicate detection
- **Doc identifiers**: Format `CASE_CUST_00001` — case short_code (3 chars auto or user-entered) + custodian initials (3 chars: first 2 of first name + first of last, or first 3 of single name, `XXX` if none) + 5-digit sequence. Attachments append `_001`. Generated in PST worker, chat worker, and direct upload path.
- **Search**: FTS5 with support for AND (implicit), OR, exact phrases, and exclusion operators; filterable by status, tags, date range, doc_type, AI score (scored/unscored/3+/4+/5), and investigation; latest-in-thread filter; thread position display (#N of M); text preview for filter-only queries; NL2SQL via "Ask AI" button; search state persisted in URL params for back-button support; doc_identifier search bypasses FTS with LIKE filter; card/table view toggle with sortable/filterable columns
- **AI classification**: Scores documents 1-5 with reasoning via pluggable LLM providers; supports batch classification from search results; model comparison via AI Logs page
- **Batch summarization**: Summarize documents via LLM with configurable prompts; job tracking in `summarization_jobs` table; results viewable in Summaries page with markdown modal
- **LLM Playground**: Freeform model testing with configurable temperature, max tokens, context window, and system prompts
- **Text extraction**: `server/lib/extract.js` dispatches by file extension (PDF, DOCX, XLS/XLSX, DOC, TXT, CSV, MD) with graceful fallback on parse failure; subprocess-based extraction via `extract-worker.js` with 15s timeout + SIGKILL for CPU-bound parsers
- **ZIP ingestion**: `zip-worker.js` extracts ZIP archives, processes contained files (including nested PST/OST), and ingests them into the investigation
- **Document viewer**: Inline rendering for PDFs (`<object>` tag) and images; fallback to extracted text; "Open in new tab" link for PDFs
- **Thread tree view**: DocumentReview page shows email thread as hierarchical tree using `message_id`/`in_reply_to` relationships; CSS-drawn connector lines; handles branching and orphaned messages
- **E01/UFDR extraction**: Scan forensic disk images (E01 via Sleuth Kit) or UFDR/ZIP archives (via unzip) for PST/OST files; select and extract to disk; job tracking in `image_jobs` table, investigation-independent
- **WhatsApp ingestion**: Parses iOS `ChatStorage.sqlite` via `chat-worker.js`; groups messages by session + calendar day into `doc_type='chat'` documents; thread ID `wa-chat-{session_id}` groups all days of same chat
- **NL2SQL search**: "Ask AI" button translates natural language queries to FTS5 search params via Ollama/Gemma; `POST /api/search/nl-to-sql` endpoint; editable generated queries
