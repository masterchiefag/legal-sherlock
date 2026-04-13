import { workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Worker uses its own lightweight DB connection (NOT db.js which runs migrations + WAL checkpoint and deadlocks worker threads)
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ediscovery.db');
console.log('✦ Chat Worker: opening DB at', DB_PATH);
const db = new Database(DB_PATH, { timeout: 15000 });
// Don't set journal_mode here — it's already WAL from the main process,
// and setting it again requires exclusive lock which deadlocks in worker threads.
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
console.log('✦ Chat Worker: DB connection ready');

const { jobId, filename, filepath, originalname, investigation_id, custodian, zipPath, sqliteEntry } = workerData;
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// Ensure investigation subdirectory exists
const INV_UPLOADS_DIR = path.join(UPLOADS_DIR, investigation_id);
fs.mkdirSync(INV_UPLOADS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════
// Doc identifier generation: CASE_CUST_00001 for chats
// ═══════════════════════════════════════════════════
function getCustodianInitials(name) {
    if (!name) return 'XXX';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0].substring(0, 2) + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 3).toUpperCase();
}

const investigation = db.prepare('SELECT short_code FROM investigations WHERE id = ?').get(investigation_id);
const caseCode = investigation?.short_code || 'CASE';
const custCode = getCustodianInitials(custodian);
const docIdPrefix = `${caseCode}_${custCode}`;

const maxExisting = db.prepare(
    "SELECT MAX(CAST(SUBSTR(doc_identifier, ?, 5) AS INTEGER)) as max_seq FROM documents WHERE doc_identifier LIKE ? AND doc_type IN ('email', 'chat')"
).get(docIdPrefix.length + 2, `${docIdPrefix}_%`);
let docSeq = (maxExisting?.max_seq || 0);

function nextDocIdentifier() {
    docSeq++;
    return `${docIdPrefix}_${String(docSeq).padStart(5, '0')}`;
}

// ═══════════════════════════════════════════════════
// ZIP helpers for WhatsApp media extraction
// ═══════════════════════════════════════════════════

/**
 * Extract a single file from a ZIP via `unzip -p` (pipe to stdout).
 * Returns file content as a Buffer.
 */
function extractFileFromZip(zipFilePath, internalPath) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn('unzip', ['-p', zipFilePath, internalPath]);
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', () => {}); // ignore warnings
        child.on('close', (code) => {
            if (code === 0 || code === 1) { // code 1 = minor warnings
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`unzip exited with code ${code} for ${internalPath}`));
            }
        });
        child.on('error', reject);
    });
}

/**
 * List all media file paths inside a ZIP.
 * Returns a Map<lowercase_basename, full_path> and a Set<full_path>.
 */
async function listZipMedia(zipFilePath) {
    const { stdout } = await execFileAsync('unzip', ['-l', zipFilePath], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
    });
    const mediaPathSet = new Set();
    const mediaByBasename = new Map();
    const lines = stdout.split('\n');
    for (const line of lines) {
        // unzip -l format: "  length  date  time  name"
        const match = line.match(/\s(\S+\/Media\/\S+)$/);
        if (match) {
            const p = match[1];
            if (!p.endsWith('/')) { // skip directories
                mediaPathSet.add(p);
                mediaByBasename.set(path.basename(p).toLowerCase(), p);
            }
        }
        // Also match bare Media/ paths (no parent)
        const match2 = line.match(/\s(Media\/\S+)$/);
        if (match2) {
            const p = match2[1];
            if (!p.endsWith('/')) {
                mediaPathSet.add(p);
                mediaByBasename.set(path.basename(p).toLowerCase(), p);
            }
        }
    }
    return { mediaPathSet, mediaByBasename };
}

/**
 * Resolve a ZMEDIALOCALPATH from the DB to an actual ZIP entry path.
 * Tries exact match, prefix variations, and basename fallback.
 */
function resolveMediaInZip(dbPath, mediaPathSet, mediaByBasename) {
    if (!dbPath) return null;
    // Try exact match
    if (mediaPathSet.has(dbPath)) return dbPath;
    // Try with common prefixes
    const variants = [
        `Message/${dbPath}`,
        dbPath.replace(/^Message\//, ''),
        dbPath.replace(/^Media\//, 'Message/Media/'),
    ];
    for (const v of variants) {
        if (mediaPathSet.has(v)) return v;
    }
    // Basename fallback (least reliable)
    const basename = path.basename(dbPath).toLowerCase();
    if (basename && mediaByBasename.has(basename)) return mediaByBasename.get(basename);
    return null;
}

/**
 * Guess MIME type from file extension and WhatsApp message type.
 */
function guessMimeType(filePath, msgType) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
        '.txt': 'text/plain', '.csv': 'text/csv',
    };
    if (mimeMap[ext]) return mimeMap[ext];
    // Fallback by message type
    if (msgType === 1) return 'image/jpeg';
    if (msgType === 8) return 'application/octet-stream';
    return 'application/octet-stream';
}

// CoreData epoch offset (seconds between Jan 1 1970 and Jan 1 2001)
const CORE_DATA_OFFSET = 978307200;

function convertCoreDataTimestamp(ts) {
    if (!ts) return null;
    return new Date((ts + CORE_DATA_OFFSET) * 1000);
}

/**
 * Extract phone number from a JID string.
 * e.g., "919876543210@s.whatsapp.net" → "919876543210"
 *       "919876543210@g.us" → "919876543210"
 */
function extractPhone(jid) {
    if (!jid) return null;
    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
}

/**
 * Format a participant as "Name <phone>" (mirrors email "Name <email>" convention).
 * - Known contact with phone: "Atul <919876543210>"
 * - Unknown contact (no name): "919876543210"
 * - Name but no phone (shouldn't happen): "Atul"
 */
function formatParticipant(name, phone) {
    if (name && phone) return `${name} <${phone}>`;
    if (name) return name;
    if (phone) return phone;
    return 'Unknown';
}

const updateProgress = db.prepare(
    "UPDATE import_jobs SET total_emails = ?, progress_percent = ?, phase = ? WHERE id = ?"
);

const insertChat = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, email_from, email_to, email_subject, email_date, investigation_id, custodian,
        text_content_size, doc_identifier, recipient_count
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'ready', 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function main() {
    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);
        const timers = { start: Date.now() };

        // ── Resolve SQLite path (bare file or extract from ZIP) ──
        let sqlitePath = filepath;
        let tempSqlitePath = null;
        let mediaPathSet = null;
        let mediaByBasename = null;
        const isZipMode = !!zipPath;

        if (isZipMode) {
            console.log(`✦ Chat Import: ZIP mode — extracting ${sqliteEntry} from ${zipPath}`);
            // Extract ChatStorage.sqlite to temp file
            tempSqlitePath = path.join(os.tmpdir(), `chat-import-${jobId}.sqlite`);
            const sqliteBuffer = await extractFileFromZip(zipPath, sqliteEntry);
            fs.writeFileSync(tempSqlitePath, sqliteBuffer);
            sqlitePath = tempSqlitePath;
            console.log(`✦ Chat Import: extracted SQLite to ${tempSqlitePath} (${Math.round(sqliteBuffer.length / 1024 / 1024)}MB)`);

            // List all media files in ZIP
            const mediaIndex = await listZipMedia(zipPath);
            mediaPathSet = mediaIndex.mediaPathSet;
            mediaByBasename = mediaIndex.mediaByBasename;
            console.log(`✦ Chat Import: found ${mediaPathSet.size} media files in ZIP`);
        } else {
            console.log(`✦ Chat Import: opening ${filepath} for investigation ${investigation_id}`);
        }

        // Open the uploaded/extracted WhatsApp DB (read-only)
        const chatDb = new Database(sqlitePath, { readonly: true });

        try {
            // Verify it's an iOS WhatsApp ChatStorage.sqlite
            chatDb.prepare("SELECT 1 FROM ZWACHATSESSION LIMIT 1").get();
        } catch (e) {
            throw new Error("Invalid format: Not a recognized iOS WhatsApp ChatStorage database.");
        }

        // ── Build JID → display name map from all available sources ──

        const jidNameMap = new Map(); // JID → contact name

        // Source 1: Group member table (most comprehensive for group chats)
        try {
            const groupMembers = chatDb.prepare(`
                SELECT ZMEMBERJID as jid, ZCONTACTNAME as name
                FROM ZWAGROUPMEMBER
                WHERE ZMEMBERJID IS NOT NULL AND ZCONTACTNAME IS NOT NULL AND ZCONTACTNAME != ''
            `).all();
            for (const gm of groupMembers) {
                jidNameMap.set(gm.jid, gm.name);
            }
            console.log(`✦ Chat Import: loaded ${groupMembers.length} group member names`);
        } catch (e) {
            console.log(`✦ Chat Import: ZWAGROUPMEMBER not available (${e.message})`);
        }

        // Source 2: Session partner names (device owner's contact book — most authoritative)
        try {
            const partners = chatDb.prepare(`
                SELECT ZCONTACTJID as jid, ZPARTNERNAME as name
                FROM ZWACHATSESSION
                WHERE ZCONTACTJID IS NOT NULL AND ZPARTNERNAME IS NOT NULL AND ZPARTNERNAME != ''
                  AND ZCONTACTJID NOT LIKE '%@status'
            `).all();
            for (const p of partners) {
                if (!jidNameMap.has(p.jid)) {
                    jidNameMap.set(p.jid, p.name);
                }
            }
            console.log(`✦ Chat Import: loaded ${partners.length} session partner names`);
        } catch (e) { /* non-fatal */ }

        // Source 3: Push names (user-set display names — fallback when contact name unavailable)
        try {
            const pushNames = chatDb.prepare(`
                SELECT ZJID as jid, ZPUSHNAME as name
                FROM ZWAPROFILEPUSHNAME
                WHERE ZJID IS NOT NULL AND ZPUSHNAME IS NOT NULL AND ZPUSHNAME != ''
            `).all();
            for (const pn of pushNames) {
                if (!jidNameMap.has(pn.jid)) {
                    jidNameMap.set(pn.jid, pn.name);
                }
            }
            console.log(`✦ Chat Import: loaded ${pushNames.length} push names`);
        } catch (e) {
            console.log(`✦ Chat Import: ZWAPROFILEPUSHNAME not available (${e.message})`);
        }

        console.log(`✦ Chat Import: JID name map has ${jidNameMap.size} entries`);

        /**
         * Resolve a JID to formatted "Name <phone>" string.
         * Falls back to phone number if no name mapping exists.
         */
        function resolveJid(jid) {
            if (!jid) return null;
            const phone = extractPhone(jid);
            const name = jidNameMap.get(jid);
            return formatParticipant(name, phone);
        }

        // Custodian identity — resolve "Me" to custodian name
        // We don't have the custodian's own JID from the DB, so we can't pair a phone number
        const custodianLabel = custodian || 'Me';

        // ── Pre-load session metadata (group detection) ──

        const sessionMeta = new Map();
        const sessionRows = chatDb.prepare(`
            SELECT Z_PK as session_id, ZCONTACTJID as jid,
                   COALESCE(ZPARTNERNAME, ZCONTACTJID, 'Unknown Chat') as name
            FROM ZWACHATSESSION
        `).all();
        for (const s of sessionRows) {
            sessionMeta.set(s.session_id, {
                isGroup: s.jid ? s.jid.endsWith('@g.us') : false,
                name: s.name,
                jid: s.jid
            });
        }

        // For group chats, pre-load all known members so email_to is comprehensive
        const groupParticipantsMap = new Map(); // session_id → Set of formatted participant strings
        try {
            const memberRows = chatDb.prepare(`
                SELECT s.Z_PK as session_id, gm.ZMEMBERJID as jid, gm.ZCONTACTNAME as name
                FROM ZWAGROUPMEMBER gm
                JOIN ZWACHATSESSION s ON gm.ZCHATSESSION = s.Z_PK
                WHERE gm.ZMEMBERJID IS NOT NULL
            `).all();
            for (const row of memberRows) {
                if (!groupParticipantsMap.has(row.session_id)) {
                    groupParticipantsMap.set(row.session_id, new Set());
                }
                const phone = extractPhone(row.jid);
                const name = row.name || jidNameMap.get(row.jid);
                groupParticipantsMap.get(row.session_id).add(formatParticipant(name, phone));
            }
        } catch (e) {
            console.log(`✦ Chat Import: Could not load group participants (${e.message})`);
        }

        // ── Query media metadata (ZIP mode only) ──
        // Build a map of message PK → media info for attachment creation
        const mediaMap = new Map(); // msg_pk → { media_path, media_title, media_size, msg_type }
        const seenHashes = new Map(); // content_hash → filename (for dedup)

        if (isZipMode) {
            try {
                const mediaRows = chatDb.prepare(`
                    SELECT m.Z_PK as msg_pk, mi.ZMEDIALOCALPATH as media_path,
                           mi.ZTITLE as media_title, mi.ZFILESIZE as media_size,
                           m.ZMESSAGETYPE as msg_type, m.ZMESSAGEDATE as msg_date,
                           m.ZTEXT as msg_text
                    FROM ZWAMESSAGE m
                    JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK
                    WHERE mi.ZMEDIALOCALPATH IS NOT NULL AND mi.ZMEDIALOCALPATH != ''
                      AND m.ZMESSAGETYPE IN (1, 8)
                `).all();
                for (const row of mediaRows) {
                    // Only include if the file actually exists in the ZIP
                    const resolved = resolveMediaInZip(row.media_path, mediaPathSet, mediaByBasename);
                    if (resolved) {
                        mediaMap.set(row.msg_pk, { ...row, resolvedPath: resolved });
                    }
                }
                console.log(`✦ Chat Import: found ${mediaMap.size} media items with matching files in ZIP (of ${mediaRows.length} total)`);
            } catch (e) {
                console.log(`✦ Chat Import: media query failed (${e.message}), skipping media`);
            }
        }

        // ── Batch extract all media files from ZIP to temp directory ──
        // Single `unzip` call instead of 14K+ individual `unzip -p` calls
        let mediaTempDir = null;
        if (isZipMode && mediaMap.size > 0) {
            mediaTempDir = path.join(os.tmpdir(), `chat-media-${jobId}`);
            fs.mkdirSync(mediaTempDir, { recursive: true });

            // Collect unique resolved paths
            const pathsToExtract = [...new Set([...mediaMap.values()].map(m => m.resolvedPath))];
            console.log(`✦ Chat Import: batch extracting ${pathsToExtract.length} media files to ${mediaTempDir}...`);
            const startMs = Date.now();

            try {
                // unzip with full paths preserved (no -j) to avoid basename collisions
                // Process in chunks to avoid exceeding arg length limits
                const CHUNK_SIZE = 500;
                for (let c = 0; c < pathsToExtract.length; c += CHUNK_SIZE) {
                    const chunk = pathsToExtract.slice(c, c + CHUNK_SIZE);
                    await new Promise((resolve, reject) => {
                        execFile('unzip', ['-o', '-d', mediaTempDir, zipPath, ...chunk], {
                            timeout: 300000, // 5 min
                            maxBuffer: 10 * 1024 * 1024,
                        }, (err) => {
                            // code 0 = success, code 1 = warnings (OK)
                            if (err && err.code !== 1) reject(err);
                            else resolve();
                        });
                    });
                    if (c % 2000 === 0 && c > 0) {
                        console.log(`✦ Chat Import: extracted ${c}/${pathsToExtract.length} media files...`);
                    }
                }
                console.log(`✦ Chat Import: batch extraction complete in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
            } catch (e) {
                console.error(`✦ Chat Import: batch extraction failed (${e.message}), falling back to per-file extraction`);
                // Clean up and fall back — mediaTempDir = null triggers per-file extraction
                try { fs.rmSync(mediaTempDir, { recursive: true, force: true }); } catch (_) {}
                mediaTempDir = null;
            }
        }

        // ── Query all messages ──
        // Join ZGROUPMEMBER to resolve sender when ZFROMJID is NULL (common in group messages)

        let messages;
        timers.preQuery = Date.now();
        console.log(`✦ Chat Import: querying messages...`);
        // Include media-only messages (no text) when in ZIP mode so they appear in transcript
        const mediaOnlyClause = isZipMode
            ? 'OR (m.ZMEDIAITEM IS NOT NULL AND m.ZMESSAGETYPE IN (1, 8))'
            : '';

        try {
            const stmt = chatDb.prepare(`
                SELECT
                    m.Z_PK as msg_pk,
                    s.Z_PK as session_id,
                    COALESCE(s.ZPARTNERNAME, s.ZCONTACTJID, 'Unknown Chat') as session_name,
                    s.ZCONTACTJID as session_jid,
                    m.ZTEXT as text,
                    m.ZMESSAGEDATE as date_ts,
                    m.ZISFROMME as is_from_me,
                    m.ZFROMJID as from_jid,
                    m.ZMESSAGETYPE as msg_type,
                    m.ZFLAGS as flags,
                    gm.ZMEMBERJID as member_jid,
                    gm.ZCONTACTNAME as member_name
                FROM ZWACHATSESSION s
                JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK
                LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK
                WHERE (m.ZTEXT IS NOT NULL AND m.ZTEXT != '') OR m.ZMESSAGETYPE = 14 ${mediaOnlyClause}
                ORDER BY s.Z_PK, m.ZMESSAGEDATE ASC
            `);
            messages = stmt.all();
        } catch (e) {
            // Fallback if ZGROUPMEMBER column doesn't exist on ZWAMESSAGE
            console.log(`✦ Chat Import: ZGROUPMEMBER join failed (${e.message}), falling back`);
            const stmt = chatDb.prepare(`
                SELECT
                    m.Z_PK as msg_pk,
                    s.Z_PK as session_id,
                    COALESCE(s.ZPARTNERNAME, s.ZCONTACTJID, 'Unknown Chat') as session_name,
                    s.ZCONTACTJID as session_jid,
                    m.ZTEXT as text,
                    m.ZMESSAGEDATE as date_ts,
                    m.ZISFROMME as is_from_me,
                    m.ZFROMJID as from_jid,
                    m.ZMESSAGETYPE as msg_type,
                    m.ZFLAGS as flags,
                    NULL as member_jid,
                    NULL as member_name
                FROM ZWACHATSESSION s
                JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK
                WHERE (m.ZTEXT IS NOT NULL AND m.ZTEXT != '') OR m.ZMESSAGETYPE = 14 ${mediaOnlyClause}
                ORDER BY s.Z_PK, m.ZMESSAGEDATE ASC
            `);
            messages = stmt.all();
        }
        console.log(`✦ Chat Import: found ${messages.length} text messages`);

        let currentSessionId = null;
        let currentDayString = null;
        let currentDayTranscript = [];
        let currentDayMedia = [];             // media items for this day (for attachment creation)
        let totalChatDocs = 0;
        let totalAttachments = 0;
        let currentSessionName = "Unknown";
        let currentDayDate = null;
        let currentSenders = new Set();       // who sent messages this day (for email_from)
        let currentParticipants = new Set();  // all participants in current session (for email_to)

        const insertAttachment = db.prepare(`
            INSERT INTO documents (
                id, filename, original_name, mime_type, size_bytes, text_content, status,
                doc_type, parent_id, thread_id, email_date,
                content_hash, is_duplicate, investigation_id, custodian, doc_identifier, recipient_count
            ) VALUES (?, ?, ?, ?, ?, NULL, 'processing', 'attachment', ?, ?, ?,
                ?, ?, ?, ?, ?, 0)
        `);

        const flushTranscript = async () => {
            if (currentDayTranscript.length > 0) {
                const docId = uuidv4();
                const sessionThreadId = `wa-chat-${currentSessionId}`;
                const content = currentDayTranscript.join('\n');

                const meta = sessionMeta.get(currentSessionId);
                const isGroup = meta?.isGroup || false;

                // email_from = all people who actually sent messages this day
                const fromList = [...currentSenders].join(', ');

                // email_to = other participants (excludes custodian — mirrors email To: field)
                let toList;
                if (isGroup) {
                    // Merge message-observed participants with pre-loaded group members
                    const allParticipants = new Set(currentParticipants);
                    const preloaded = groupParticipantsMap.get(currentSessionId);
                    if (preloaded) {
                        for (const p of preloaded) allParticipants.add(p);
                    }
                    // Remove custodian from participants list
                    allParticipants.delete(custodianLabel);
                    toList = [...allParticipants].join(', ');
                } else {
                    // 1:1 chat: other party only
                    const otherParty = resolveJid(meta?.jid) || currentSessionName;
                    toList = otherParty;
                }

                const subject = `WhatsApp${isGroup ? ' Group' : ''}: ${currentSessionName} (${currentDayString})`;
                const chatDocName = `Chat_${currentSessionName.replace(/[^a-zA-Z0-9]/g, '_')}_${currentDayString}.txt`;

                const chatDocIdentifier = nextDocIdentifier();
                const recipientCount = toList ? toList.split(',').filter(a => a.trim()).length : 0;
                insertChat.run(
                    docId, chatDocName, chatDocName, Buffer.byteLength(content, 'utf8'), content,
                    sessionThreadId, fromList, toList, subject, currentDayDate.toISOString(),
                    investigation_id, custodian || null,
                    content.length, chatDocIdentifier, recipientCount
                );

                totalChatDocs++;

                // ── Create attachment documents for media in this day's messages ──
                if (isZipMode && currentDayMedia.length > 0) {
                    for (let j = 0; j < currentDayMedia.length; j++) {
                        const media = currentDayMedia[j];
                        try {
                            const attId = uuidv4();
                            // Resolve original filename:
                            // - Type 8 (documents): ZTEXT has the real filename (e.g. "Report.pdf")
                            // - Type 1 (images): no filename available, use ZIP path basename
                            // - ZTITLE is a caption/message text, NOT a filename — never use it
                            let rawName;
                            if (media.msg_type === 8 && media.msg_text) {
                                rawName = media.msg_text.trim();
                            } else {
                                rawName = path.basename(media.resolvedPath);
                            }
                            const ext = path.extname(rawName) || path.extname(media.resolvedPath) ||
                                (media.msg_type === 1 ? '.jpg' : '');
                            const safeExt = ext.split(/[?#\s]/)[0].substring(0, 10); // strip query params, cap length
                            const originalName = rawName.length > 200 ? rawName.substring(0, 200) : rawName;
                            const attFilename = `${investigation_id}/${attId}${safeExt}`;
                            const attDiskPath = path.join(UPLOADS_DIR, attFilename);

                            // Read from pre-extracted temp dir or fall back to per-file extraction
                            let fileBuffer;
                            const preExtractedPath = mediaTempDir ? path.join(mediaTempDir, media.resolvedPath) : null;
                            if (preExtractedPath && fs.existsSync(preExtractedPath)) {
                                fileBuffer = fs.readFileSync(preExtractedPath);
                            } else {
                                fileBuffer = await extractFileFromZip(zipPath, media.resolvedPath);
                            }
                            fs.writeFileSync(attDiskPath, fileBuffer);

                            // Content hash for dedup
                            const contentHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
                            const isDuplicate = seenHashes.has(contentHash) ? 1 : 0;
                            if (!isDuplicate) seenHashes.set(contentHash, attFilename);

                            // Try original name first, fall back to ZIP path for extension detection
                            const mime = guessMimeType(originalName, media.msg_type) !== 'application/octet-stream'
                                ? guessMimeType(originalName, media.msg_type)
                                : guessMimeType(media.resolvedPath, media.msg_type);
                            const attDocIdentifier = `${chatDocIdentifier}_${String(j + 1).padStart(3, '0')}`;

                            const msgDate = convertCoreDataTimestamp(media.msg_date);
                            insertAttachment.run(
                                attId, attFilename, originalName, mime,
                                media.media_size || fileBuffer.length,
                                docId,              // parent_id = chat document
                                sessionThreadId,    // thread_id
                                msgDate ? msgDate.toISOString() : currentDayDate.toISOString(),
                                contentHash, isDuplicate,
                                investigation_id, custodian || null, attDocIdentifier
                            );
                            totalAttachments++;
                        } catch (e) {
                            console.warn(`✦ Chat Import: failed to extract media ${media.resolvedPath}: ${e.message}`);
                        }
                    }
                }

                currentDayTranscript = [];
                currentDayMedia = [];
                currentSenders = new Set();
                // Don't reset currentParticipants — accumulate across days within a session
            }
        };

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const msgDate = convertCoreDataTimestamp(msg.date_ts);

            if (!msgDate) continue;

            const dayString = msgDate.toISOString().split('T')[0]; // YYYY-MM-DD
            // Format time as 12-hour with AM/PM and UTC indicator
            const hours = msgDate.getUTCHours();
            const minutes = msgDate.getUTCMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const hour12 = hours % 12 || 12;
            const timeString = `${hour12}:${String(minutes).padStart(2, '0')} ${ampm} UTC`;

            // If session changed, flush and reset participants
            if (currentSessionId !== null && currentSessionId !== msg.session_id) {
                await flushTranscript();
                currentParticipants = new Set(); // Reset for new session
            } else if (currentSessionId !== null && currentDayString !== dayString) {
                // Day changed within same session — flush but keep participants
                await flushTranscript();
            }

            currentSessionId = msg.session_id;
            currentSessionName = msg.session_name;
            currentDayString = dayString;
            if (!currentDayDate || currentDayDate.toISOString().split('T')[0] !== dayString) {
                currentDayDate = msgDate;
            }

            // Resolve sender identity
            let sender;
            const meta = sessionMeta.get(msg.session_id);
            const isGroup = meta?.isGroup || false;

            if (msg.is_from_me) {
                sender = custodianLabel;
            } else if (msg.member_jid) {
                // ZGROUPMEMBER FK resolved — most reliable for group chats
                const phone = extractPhone(msg.member_jid);
                const name = msg.member_name || jidNameMap.get(msg.member_jid);
                sender = formatParticipant(name, phone);
            } else if (msg.from_jid && !msg.from_jid.endsWith('@g.us')) {
                // Individual JID (1:1 chats have sender JID here; skip group JIDs)
                sender = resolveJid(msg.from_jid);
            } else if (!isGroup && meta?.jid) {
                // 1:1 chat with no from_jid: sender is the chat partner
                sender = resolveJid(meta.jid);
            }
            if (!sender) sender = currentSessionName;

            currentSenders.add(sender);
            currentParticipants.add(sender);

            // Check for media attachment on this message
            const mediaInfo = mediaMap.get(msg.msg_pk);
            if (mediaInfo) {
                currentDayMedia.push(mediaInfo);
            }

            // Build transcript line with deleted/forwarded/media annotations
            let displayText;
            if (msg.msg_type === 14) {
                displayText = '[This message was deleted]';
            } else if (mediaInfo) {
                const mediaFilename = (mediaInfo.msg_type === 8 && mediaInfo.msg_text) ? mediaInfo.msg_text.trim() : path.basename(mediaInfo.resolvedPath);
                const mediaLabel = `[Attachment: ${mediaFilename}]`;
                if (msg.text) {
                    displayText = `${msg.text} ${mediaLabel}`;
                } else {
                    displayText = mediaLabel;
                }
            } else if (msg.flags && (msg.flags & 256) !== 0) {
                displayText = `[Forwarded] ${msg.text}`;
            } else {
                displayText = msg.text || '';
            }

            if (displayText) {
                currentDayTranscript.push(`[${timeString}] ${sender}: ${displayText}`);
            }

            // Periodically update progress
            if (i % 10000 === 0) {
                const pct = Math.round((i / messages.length) * 100);
                updateProgress.run(totalChatDocs, pct, 'importing', jobId);
            }
        }

        // Flush last transcript
        await flushTranscript();

        chatDb.close();

        timers.phase1Done = Date.now();
        console.log(`✦ Chat Import: ingested ${totalChatDocs} daily chat transcripts, ${totalAttachments} media attachments.`);

        // Record Phase 1 completion and attachment count
        db.prepare("UPDATE import_jobs SET phase1_completed_at = datetime('now'), total_attachments = ? WHERE id = ?").run(totalAttachments, jobId);

        // Free disk immediately — Phase 2 only reads from uploads/, not the source ZIP/sqlite
        try {
            if (tempSqlitePath) { fs.unlinkSync(tempSqlitePath); tempSqlitePath = null; }
            if (mediaTempDir) { fs.rmSync(mediaTempDir, { recursive: true, force: true }); mediaTempDir = null; console.log(`✦ Chat Import: cleaned up temp media directory`); }
            const sourceFile = zipPath || filepath;
            if (sourceFile && fs.existsSync(sourceFile)) {
                const sizeMB = Math.round(fs.statSync(sourceFile).size / 1024 / 1024);
                fs.unlinkSync(sourceFile);
                console.log(`✦ Chat Import: deleted source file ${path.basename(sourceFile)} (${sizeMB}MB) after Phase 1`);
            }
        } catch (e) { console.warn(`✦ Chat Import: cleanup warning: ${e.message}`); }

        // ═══════════════════════════════════════════
        // Phase 2: Extract text from media attachments
        // ═══════════════════════════════════════════
        if (totalAttachments > 0) {
            updateProgress.run(totalChatDocs, 50, 'extracting', jobId);

            const EXTRACT_WORKER = path.join(__dirname, '..', 'lib', 'extract-worker.js');
            const EXTRACT_TIMEOUT = 15000;
            const OCR_TIMEOUT = 120000;
            const NODE_BIN = process.execPath;
            const PHASE2_CONCURRENCY = 4;

            function extractViaSubprocess(filePath, mimeType, mode = 'text') {
                const timeout = mode === 'textocr' ? OCR_TIMEOUT : EXTRACT_TIMEOUT;
                return new Promise((resolve, reject) => {
                    const child = execFile(NODE_BIN, [EXTRACT_WORKER, filePath, mimeType, mode], {
                        timeout,
                        maxBuffer: 50 * 1024 * 1024,
                        killSignal: 'SIGKILL',
                    }, (err, stdout, stderr) => {
                        if (err) {
                            if (err.killed) return reject(new Error('Extraction timed out (killed)'));
                            return reject(new Error(stderr || err.message));
                        }
                        resolve(stdout);
                    });
                });
            }

            // Skip media types that can't yield useful text (images, video, audio)
            const SKIP_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
            const EXTRACTABLE_IMAGE_MIMES = []; // could add image/pdf etc. in future
            const skippedMedia = db.prepare(
                "UPDATE documents SET status = 'ready', text_content = '' WHERE status = 'processing' AND doc_type = 'attachment' AND is_duplicate = 0 AND investigation_id = ? AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%' OR mime_type LIKE 'audio/%')"
            ).run(investigation_id);
            if (skippedMedia.changes > 0) {
                console.log(`✦ Phase 2: skipped ${skippedMedia.changes} image/video/audio attachments (no text to extract)`);
            }

            // Skip duplicates — backfill from originals later
            const pendingDocs = db.prepare(
                "SELECT id, filename, original_name, mime_type FROM documents WHERE status = 'processing' AND doc_type = 'attachment' AND is_duplicate = 0 AND investigation_id = ?"
            ).all(investigation_id);

            const dupeCount = db.prepare(
                "UPDATE documents SET status = 'ready' WHERE status = 'processing' AND doc_type = 'attachment' AND is_duplicate = 1 AND investigation_id = ?"
            ).run(investigation_id);
            if (dupeCount.changes > 0) {
                console.log(`✦ Phase 2: skipped ${dupeCount.changes} duplicate attachments`);
            }

            const updateDocText = db.prepare(
                "UPDATE documents SET text_content = ?, text_content_size = ?, status = 'ready', ocr_applied = ?, ocr_time_ms = ? WHERE id = ?"
            );
            const updateDocMeta = db.prepare(
                "UPDATE documents SET doc_author = ?, doc_title = ?, doc_created_at = ?, doc_modified_at = ?, doc_creator_tool = ?, doc_keywords = ? WHERE id = ?"
            );

            console.log(`✦ Phase 2: extracting text from ${pendingDocs.length} attachments (concurrency=${PHASE2_CONCURRENCY})...`);
            let extracted = 0;
            let ocrCount = 0, ocrSuccess = 0;

            // Simple concurrency limiter
            const queue = [...pendingDocs];
            async function processNext() {
                while (queue.length > 0) {
                    const doc = queue.shift();
                    const filePath = path.join(UPLOADS_DIR, doc.filename);
                    const isPdf = path.extname(doc.filename).toLowerCase() === '.pdf';
                    let text = '';
                    let ocrApplied = 0;
                    let docOcrTimeMs = null;

                    try {
                        if (isPdf) {
                            const raw = await extractViaSubprocess(filePath, doc.mime_type, 'textocr');
                            try {
                                const jsonStart = raw.indexOf('{"text":');
                                const jsonStr = jsonStart >= 0 ? raw.substring(jsonStart) : raw;
                                const result = JSON.parse(jsonStr);
                                text = result.text || '';
                                if (result.ocr && result.ocr.attempted) {
                                    ocrCount++;
                                    docOcrTimeMs = result.ocr.timeMs || null;
                                    if (result.ocr.succeeded) {
                                        ocrSuccess++;
                                        ocrApplied = 1;
                                    }
                                }
                            } catch (_) {
                                text = raw || '';
                            }
                        } else {
                            text = await extractViaSubprocess(filePath, doc.mime_type, 'text');
                        }
                    } catch (e) {
                        text = `[Could not extract text: ${e.message}]`;
                        console.warn(`✦ Phase 2 FAILED: ${doc.original_name || doc.filename} — ${e.message}`);
                    }

                    updateDocText.run(text, text ? text.length : 0, ocrApplied, docOcrTimeMs, doc.id);

                    // Extract metadata (best effort)
                    try {
                        const metaJson = await extractViaSubprocess(filePath, doc.mime_type, 'meta');
                        if (metaJson) {
                            const meta = JSON.parse(metaJson);
                            updateDocMeta.run(meta.author, meta.title, meta.createdAt, meta.modifiedAt, meta.creatorTool, meta.keywords, doc.id);
                        }
                    } catch (_) { /* best effort */ }

                    extracted++;
                    if (extracted % 20 === 0 || extracted === pendingDocs.length) {
                        const pct = Math.round((extracted / pendingDocs.length) * 100);
                        console.log(`✦ Phase 2: ${extracted}/${pendingDocs.length} (${pct}%)`);
                        updateProgress.run(totalChatDocs, pct, 'extracting', jobId);
                    }
                }
            }

            // Run concurrent workers
            const workers = [];
            for (let w = 0; w < Math.min(PHASE2_CONCURRENCY, pendingDocs.length); w++) {
                workers.push(processNext());
            }
            await Promise.all(workers);

            // Backfill text from originals into duplicates
            if (dupeCount.changes > 0) {
                db.prepare(`
                    UPDATE documents SET
                        text_content = (SELECT d2.text_content FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 AND d2.text_content IS NOT NULL LIMIT 1),
                        text_content_size = (SELECT d2.text_content_size FROM documents d2 WHERE d2.content_hash = documents.content_hash AND d2.is_duplicate = 0 AND d2.text_content IS NOT NULL LIMIT 1)
                    WHERE is_duplicate = 1 AND doc_type = 'attachment' AND investigation_id = ? AND text_content IS NULL
                `).run(investigation_id);
            }

            console.log(`✦ Phase 2 complete: extracted text from ${extracted} attachments` +
                (ocrCount > 0 ? `, OCR: ${ocrSuccess}/${ocrCount} succeeded` : ''));
        }

        timers.done = Date.now();
        const sec = (a, b) => ((b - a) / 1000).toFixed(1);
        console.log(`\n✦ ═══ TIMING SUMMARY ═══`);
        console.log(`✦ Setup + metadata:  ${sec(timers.start, timers.preQuery)}s`);
        console.log(`✦ Phase 1 (messages + media copy): ${sec(timers.preQuery, timers.phase1Done)}s`);
        console.log(`✦ Phase 2 (text extraction):       ${sec(timers.phase1Done, timers.done)}s`);
        console.log(`✦ Total:             ${sec(timers.start, timers.done)}s`);
        console.log(`✦ Counts: ${totalChatDocs} chats, ${totalAttachments} attachments\n`);

        db.prepare(`
            UPDATE import_jobs
            SET status = 'completed',
                phase = 'completed',
                total_emails = ?,
                progress_percent = 100,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(totalChatDocs, jobId);

        // Refresh precomputed investigation counts
        db.prepare(`
            UPDATE investigations SET
                document_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id),
                email_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'email'),
                attachment_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'attachment'),
                chat_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'chat'),
                file_count = (SELECT COUNT(*) FROM documents WHERE investigation_id = @id AND doc_type = 'file')
            WHERE id = @id
        `).run({ id: investigation_id });
        console.log('✦ Investigation counts refreshed');

    } catch (err) {
        console.error("Chat worker fatal error:", err);
        db.prepare(`
            UPDATE import_jobs
            SET status = 'failed',
                error_log = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify([{ error: err.message, fatal: true }]), jobId);
    } finally {
        // Safety net — clean up anything not already deleted after Phase 1
        try {
            if (tempSqlitePath && fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);
            if (mediaTempDir && fs.existsSync(mediaTempDir)) fs.rmSync(mediaTempDir, { recursive: true, force: true });
            const sourceFile = zipPath || filepath;
            if (sourceFile && fs.existsSync(sourceFile)) {
                fs.unlinkSync(sourceFile);
                console.log(`✦ Chat Import: deleted source file ${path.basename(sourceFile)} (finally block)`);
            }
        } catch (_) { /* Best effort */ }
    }
}

main();
