# HTML Email Rendering

Sherlock can render the original HTML body of an email alongside (or instead of) the extracted plain-text content. This doc describes the end-to-end pipeline: what gets written during ingestion, how the HTML is served safely, and how the DocumentReview UI consumes it.

Related: [ingestion-flows.md](./ingestion-flows.md) · [pst-parsing-nuances.md](./pst-parsing-nuances.md) · GitHub PR #76.

## Motivation

Plain-text extraction loses layout, branding, tables, signatures, and inline images — reviewers routinely need the visual rendition (an invoice, a marketing email, a threaded reply with coloured quoted blocks). Shipping this required four things: a storage format for the HTML body, a safe way to serve it, an in-iframe viewer that couldn't escape the page, and schema changes to track it.

## Schema

Two columns on `documents` (see `server/lib/investigation-db.js`):

| Column | Type | Purpose |
|---|---|---|
| `has_html_body` | INTEGER (0/1, default 0) | Set to 1 during ingestion when an HTML body exists and the sidecar was written |
| `inline_images_meta` | TEXT (JSON array) | Per-image metadata: `{ filename, contentId, disposition, size, mimeType }` for each inline CID image; lets the UI render a "Inline images" panel |

No FTS changes — HTML is viewed visually; searchable text still comes from the plain-text extraction stored in `text_content`.

## Ingestion path

### 1. Parse (`server/lib/eml-parser.js`)

- postal-mime is invoked with `forceRfc822Attachments: true` so embedded forwarded messages surface as attachments (unrelated to HTML rendering, but they flow through the same tree).
- The result carries both `.text` (plain body) and `.html` (HTML body) fields.
- Every attachment exposes `contentId`, `disposition`, and `related` — postal-mime fields that let us detect inline CID images vs. real attachments.

### 2. Write HTML + inline images (`server/workers/pst-worker.js`)

During email insertion the worker does the following in `uploads/{investigation_id}/html/`:

1. **Build a CID map** — `contentId → attachment index`.
2. **Scan the HTML body** for `cid:...` references and record which attachments are referenced inline.
3. **Tag inline images** — any attachment with `disposition === 'inline'` OR `related === true` OR a non-empty `contentId` is considered inline; these are **not** inserted as DB attachment rows (so the attachment grid doesn't fill with logos and signature pixels).
4. **Write the per-email image directory** — `uploads/{inv}/html/{emailId}/imageNNN.{ext}` — one file per inline image.
5. **Rewrite CID references** in the HTML — `cid:XYZ` is replaced with the relative path `{emailId}/imageNNN.png` so the HTML file is self-contained within the `html/` directory.
6. **Write the HTML sidecar** — `uploads/{inv}/html/{emailId}.html` (rewritten body).
7. **Record metadata** — `has_html_body = 1`, `inline_images_meta = JSON.stringify([...])`.

Non-inline attachments continue through the regular attachment path and become child rows with `parent_id = emailId`.

### Directory layout

```
uploads/
└── {investigation_id}/
    └── html/
        ├── {emailId}.html                  # sanitized, CID-rewritten HTML body
        └── {emailId}/
            ├── image001.png                # inline CID image 1
            ├── image002.gif                # inline CID image 2
            └── ...
```

The per-email image directory exists only when the email has inline CID images.

## Serving: `GET /api/documents/:id/html`

Route: `server/routes/documents.js` — uses the per-investigation read-only DB connection.

1. Load the email row, confirm `has_html_body = 1`.
2. Read `uploads/{inv}/html/{emailId}.html` from disk.
3. **Rewrite relative image paths** to absolute URLs served by `express.static`:
   - On disk: `src="{emailId}/image001.png"`
   - Rewritten: `src="/uploads/{inv}/html/{emailId}/image001.png"`
4. **Server-side sanitize** with `isomorphic-dompurify`:
   ```js
   DOMPurify.sanitize(rewritten, {
     WHOLE_DOCUMENT: true,
     FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form',
                   'input', 'base', 'textarea', 'button'],
     FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover',
                   'onfocus', 'onblur', 'onsubmit', 'onchange',
                   'onkeydown', 'onkeyup', 'onkeypress'],
     ALLOW_DATA_ATTR: false,
   })
   ```
5. **Block external images** — strip `http(s)://` image sources and replace with `data-blocked-src="[external image blocked]"` to neutralize tracking pixels and remote beacons. Only local `/uploads/...` sources are allowed through.
6. Respond with `{ html }` JSON.

Returns 404 if the row doesn't exist, has no HTML body, or the sidecar is missing from disk.

## UI: `src/pages/DocumentReview.jsx`

- **Two-tab viewer** — "HTML" and "Plain text" tabs on email documents. The HTML tab is the default when `has_html_body = 1`, otherwise the Plain text tab is primary.
- **Rendering** — the sanitized HTML is written to a `<iframe sandbox="allow-same-origin">`. The sandbox attribute is the **hard security boundary** — DOMPurify is defense in depth. With no `allow-scripts` flag, the HTML cannot execute JS even if sanitization missed something.
- **Inline images panel** — if `inline_images_meta` is non-empty, a sidebar section renders a grid of the inline images with filename + size, useful when a reviewer wants to save or inspect an individual image.
- **Fallback** — an email with `has_html_body = 0` shows only the Plain text tab (the HTML tab is hidden).

## Security layering

```
┌──────────────────────────────────────────────────────┐
│ 1. Ingestion: inline images stored under per-email   │
│    directory, HTML rewritten to relative paths       │
├──────────────────────────────────────────────────────┤
│ 2. Serving:   server-side DOMPurify sanitization     │
│               + external image source stripping      │
├──────────────────────────────────────────────────────┤
│ 3. Rendering: <iframe sandbox="allow-same-origin">   │
│               — no JS execution, no form submission  │
└──────────────────────────────────────────────────────┘
```

Each layer is redundant to the others — a miss in sanitization is caught by the sandbox, a miss in image-source stripping is caught by the no-remote-resources policy implied by relative-only paths + sandbox constraints.

## Tests

- `server/lib/__tests__/html-email.test.js` — 18 tests covering the end-to-end HTML pipeline: CID rewriting, inline-vs-attachment tagging, sanitization, external-image blocking.

## Gotchas / nuances

- **CID uniqueness** — postal-mime's `contentId` can be missing or non-unique on pathological emails. We match on first occurrence and ignore stale CIDs; any unmatched `cid:...` survives in the final HTML and renders as a broken image, which is benign.
- **Signature images** — signature logos are almost always `disposition: inline` + a non-empty `contentId`, so they're correctly tagged as inline (and suppressed from the attachment grid). Emails with `disposition: attachment` images included in an HTML body are rare but do exist; those show up in both the inline-images panel (if referenced) and the attachment grid.
- **Large HTML bodies** — we don't truncate. A few thousand emails have megabyte-scale HTML, mostly from deeply nested `<blockquote>` reply chains. The iframe handles these fine.
- **OFT / calendar items** — MAPI non-email items (Phase 1.3) don't go through this path; their body lives in `text_content` only.
- **Embedded RFC822 parts** — a forwarded email attached as `message/rfc822` is handled by Phase 1.5 as a child row, not rendered inline in the parent's HTML body.
