# Sherlock

eDiscovery platform for uploading, searching, reviewing, and tagging documents for litigation and compliance workflows.

## Dev Commands

```bash
npm run dev          # Start both client (port 5173) and server (port 3001)
npm run dev:client   # Vite dev server only
npm run dev:server   # Express server with --watch
npm run build        # Production build (Vite)
npm run preview      # Preview production build
```

No test framework or linter is configured.

## Tech Stack

- **Frontend**: React 18, React Router, Vite
- **Backend**: Express.js (Node.js, ES modules)
- **Database**: SQLite via better-sqlite3 (WAL mode, foreign keys enabled)
- **Document processing**: pdf-parse, mammoth (DOCX), mailparser, pst-extractor
- **File uploads**: Multer (5GB limit)
- **AI classification**: Pluggable LLM providers (Ollama, OpenAI, Anthropic)
- **Package manager**: npm

## Project Structure

```
src/                    # React frontend
  pages/                # Page components (Dashboard, Upload, Search, DocumentReview, ClassificationLogs)
  App.jsx               # Root layout with sidebar + routing
  main.jsx              # Entry point
  index.css             # Global styles with CSS variables

server/                 # Express backend
  index.js              # Server setup and middleware
  db.js                 # SQLite schema, migrations, and connection
  routes/               # API route handlers
    documents.js        # Upload, list, delete, PST import jobs
    search.js           # FTS5 full-text search with filters
    tags.js             # Tag CRUD
    reviews.js          # Document review status + dashboard stats
    classify.js         # AI classification + batch ops + logs
  lib/                  # Utilities
    extract.js          # Text extraction (PDF, DOCX, TXT, CSV, MD)
    eml-parser.js       # .eml email parsing
    pst-parser.js       # Outlook PST folder walking
    llm-providers.js    # LLM provider abstraction
  workers/
    pst-worker.js       # Background PST extraction (Worker thread)

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

SQLite at `data/ediscovery.db`. Programmatic migrations in `server/db.js` using a `columnExists()` helper to add columns idempotently. Key tables: `documents`, `tags`, `document_tags`, `document_reviews`, `classifications`, `import_jobs`, `documents_fts` (FTS5 virtual table with auto-sync triggers).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `LLM_PROVIDER` | `ollama` | AI provider: `ollama`, `openai`, `anthropic` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `gemma3:1b` | Ollama model name |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |

## Key Patterns

- **PST import**: Background Worker thread (`pst-worker.js`) with job tracking in `import_jobs` table, polled from frontend every 3s
- **Email threading**: Resolves `thread_id` via `In-Reply-To`/`References` headers with backfill for late-arriving emails
- **Search**: FTS5 with support for OR, exact phrases, and exclusion operators; filterable by status, tags, date range, doc_type, and AI score
- **AI classification**: Scores documents 1-5 with reasoning, tracks elapsed time; supports batch classification from search results
- **Text extraction**: `server/lib/extract.js` dispatches by file extension with graceful fallback on parse failure
