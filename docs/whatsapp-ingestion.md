# WhatsApp Chat Ingestion

Technical reference for WhatsApp iOS backup ingestion via `server/workers/chat-worker.js`.

## Input Formats

| Format | Description |
|--------|-------------|
| Bare `.sqlite` | Just `ChatStorage.sqlite` — text-only ingestion, no media |
| ZIP archive | Contains `ChatStorage.sqlite` + `Message/Media/` folder — full ingestion with media attachments |

ZIP detection happens in `server/routes/documents.js`: the upload route peeks inside `.zip` files with `unzip -l` looking for `ChatStorage.sqlite` (case-insensitive, any depth). If found, routes to chat worker instead of zip-worker.

## iOS WhatsApp SQLite Schema (ChatStorage.sqlite)

Key tables and their roles:

### ZWACHATSESSION (chat/group metadata)
- `Z_PK` — primary key (session ID)
- `ZPARTNERNAME` — **contact book name** set by the device owner (most authoritative name source)
- `ZCONTACTJID` — JID of the chat partner (phone@s.whatsapp.net for 1:1, group-id@g.us for groups)

### ZWAMESSAGE (messages)
- `Z_PK` — primary key (used to join with media)
- `ZCHATSESSION` — FK to ZWACHATSESSION.Z_PK
- `ZFROMJID` — sender JID. **Gotcha: in group messages, this is the GROUP JID (@g.us), NOT the individual sender**
- `ZGROUPMEMBER` — FK to ZWAGROUPMEMBER.Z_PK — **the correct way to identify individual senders in groups**
- `ZMESSAGEDATE` — CoreData timestamp (seconds since Jan 1 2001, NOT Unix epoch)
- `ZMESSAGETYPE` — see Message Types below
- `ZISFROMME` — 1 if sent by device owner, 0 if received
- `ZTEXT` — message text. **For type 8 (documents), this contains the ACTUAL FILENAME** (e.g. "Report.pdf")
- `ZFLAGS` — bitfield; `ZFLAGS & 256` = forwarded message
- `ZMEDIAITEM` — FK to ZWAMEDIAITEM.Z_PK (non-null if message has media)

### ZWAMEDIAITEM (media attachments)
- `ZMESSAGE` — FK to ZWAMESSAGE.Z_PK
- `ZMEDIALOCALPATH` — path within the ZIP's Media folder (UUID-based filename, e.g. `f26003d1-cffd-4697-9bd4-f55ee085f264.pdf`)
- `ZTITLE` — **NOT a filename. This is a caption/message text.** Often NULL. Never use for original_name.
- `ZFILESIZE` — file size in bytes

### ZWAGROUPMEMBER (group participants)
- `Z_PK` — primary key
- `ZMEMBERJID` — individual JID of the group member
- `ZCONTACTNAME` — often empty, unreliable

### ZWAPROFILEPUSHNAME (display names)
- `ZJID` — user's JID
- `ZPUSHNAME` — self-set display name (can be nicknames like "Dev" instead of full name)

## Message Types

| ZMESSAGETYPE | Meaning | Handling |
|-------------|---------|----------|
| 0 | Text message | Normal ingestion |
| 1 | Image | Media attachment (type 1). No filename in ZTEXT. |
| 8 | Document | Media attachment (type 8). **ZTEXT = actual filename.** |
| 14 | Deleted/revoked | Shown as `[This message was deleted]` in transcript |

## CoreData Timestamps

WhatsApp on iOS uses Apple's CoreData epoch: seconds since **January 1, 2001** (not 1970).

```
Unix timestamp = CoreData timestamp + 978307200
```

All timestamps displayed as UTC with AM/PM format.

## Name Resolution Priority

Names are resolved in this order (first non-empty wins):

1. **ZGROUPMEMBER lookup** — for group messages, resolves individual sender via `ZGROUPMEMBER` FK on the message, then looks up the JID
2. **Contact book names** (`ZWACHATSESSION.ZPARTNERNAME`) — the device owner's address book. Most reliable because it's set by someone who knows the contacts.
3. **Push names** (`ZWAPROFILEPUSHNAME.ZPUSHNAME`) — self-set by each user. Can be unreliable (e.g. "Dev" instead of "Devesh Goyal").
4. **JID-based** — phone number from the JID as last resort

**Why this order matters:** In testing, ~1,780 contacts had conflicts between contact book names and push names. Contact book names are authoritative because they're set by the device owner (who knows the people), while push names are self-set vanity names.

### Sender Resolution for Individual Messages

1. `ZISFROMME = 1` → use custodian name
2. Group message → look up `ZGROUPMEMBER` FK → resolve JID via name maps
3. `ZFROMJID` present AND not a group JID (`@g.us`) → resolve JID
4. 1:1 chat → use session partner name
5. Fallback → session name

**Critical gotcha:** `ZFROMJID` in group messages contains the **group JID** (`xxx@g.us`), not the individual sender. You MUST use the `ZGROUPMEMBER` FK to identify who sent each message in a group.

## Media / Attachment Ingestion

### ZIP Structure
Standard iOS WhatsApp export:
```
ChatStorage.sqlite
Message/
  Media/
    <uuid>.<ext>     # e.g. f26003d1-cffd-4697-9bd4-f55ee085f264.pdf
    ...
```

### Media Path Resolution
`ZMEDIALOCALPATH` in the DB may not exactly match ZIP paths. Resolution tries:
1. Exact match
2. With `Message/` prefix
3. Without `Message/` prefix
4. Basename-only match (last resort)

### Filename Resolution for Attachments

| Media Type | Filename Source | Notes |
|-----------|----------------|-------|
| Type 8 (documents) | `ZWAMESSAGE.ZTEXT` | Contains real filename like "Report.pdf" |
| Type 1 (images) | `path.basename(resolvedPath)` | Images have no filename in WhatsApp; use UUID from ZIP |
| **Never use** | `ZWAMEDIAITEM.ZTITLE` | This is a caption, not a filename. Using it causes message text to leak into `original_name`. |

### MIME Type Detection
Extension from `original_name` → known extension map → fallback to ZIP path extension → fallback by message type (type 1 = `image/jpeg`, type 8 = `application/octet-stream`).

### Attachment Document Structure
- `doc_type = 'attachment'`
- `parent_id` = chat document ID (same parent-child model as email attachments)
- `thread_id` = `wa-chat-{session_id}` (same as parent chat)
- `doc_identifier` = `{CASE}_{CUST}_{SEQ}_{NNN}` (parent identifier + attachment index)
- Content hash (MD5) deduplication across all attachments

### Batch Extraction Performance
Media files are batch-extracted from ZIP in chunks of 500 (single `unzip -o -d` call per chunk) rather than individual `unzip -p` calls per file. This reduced extraction from ~14K subprocess calls to ~30 chunked calls.

## Document Grouping

Messages are grouped into documents by **session + calendar day (UTC)**:
- Each chat session × calendar day = one `doc_type='chat'` document
- `thread_id` = `wa-chat-{session_id}` groups all days of the same chat
- `email_from` = comma-separated list of senders for that day
- `email_to` = other participants (custodian excluded to avoid self-pairs in analytics)

## Phase 2: Text Extraction

After all chat documents and attachment records are created (Phase 1):

1. **Skip non-extractable**: Images, video, audio → marked `status='ready'` with empty text
2. **Skip duplicates**: `is_duplicate=1` → marked `status='ready'`
3. **Extract remaining**: PDFs, DOCX, XLSX, etc. via `extract-worker.js` subprocess
4. **OCR fallback**: PDFs that yield no text are retried with `textocr` mode
5. **Concurrency**: 4 parallel extract workers (matches CPU count)

### Performance Characteristics
- Phase 1 (messages + media copy): ~2-3 minutes for 22K messages + 14K attachments
- Phase 2 (text extraction): Dominated by OCR on image-based PDFs. Large PDFs (100+ MB) can take several minutes each.
- Source ZIP and temp files are deleted after Phase 1 to free disk space.

## Forwarded Messages

Detected via `ZFLAGS & 256`. Displayed as `[Forwarded] original text` in transcript.

## Deleted Messages

`ZMESSAGETYPE = 14` — "deleted for everyone" / revoked messages. Displayed as `[This message was deleted]` with sender attribution.

## Analytics Considerations

### Top Senders / Top Communication Pairs
- `email_from` and `email_to` are comma-separated (multiple senders per chat day)
- Dashboard queries split these into individual names before counting
- Self-pairs (sender = receiver) are filtered out
- Pair direction is normalized (A→B and B→A merge into one pair)
- Custodian is excluded from `email_to` to avoid inflated self-communication stats

## Known Limitations

- Only message types 0, 1, 8, 14 are handled. Other types (stickers, voice notes, contacts, locations) are not ingested.
- Images (type 1) are ingested as attachments but no text extraction is attempted.
- Group member names from `ZCONTACTNAME` on `ZWAGROUPMEMBER` are often empty.
- Files shared without a filename in ZTEXT (544 out of ~4,200 documents observed) fall back to UUID basename from ZIP.
