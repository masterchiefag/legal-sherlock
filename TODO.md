# Future Tasks

## Attachment search by sender/recipient
Attachments (email and WhatsApp) don't have `email_from`/`email_to` fields. Simple inheritance won't work because dedup means the same file can be sent by different people. Need parent-aware search — join through `parent_id` to get the parent's from/to when filtering.

**Files to change:**
- `server/routes/search.js` — SQL joins through parent_id for from/to filters on attachments
- `src/pages/Search.jsx` — ensure from/to filters apply to attachments via parent
