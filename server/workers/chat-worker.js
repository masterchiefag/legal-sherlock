import { workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { jobId, filename, filepath, originalname, investigation_id, custodian } = workerData;

// TODO (Feature Request): Add support for WhatsApp media attachments.
// This requires a mechanism to upload a ZIP containing both ChatStorage.sqlite
// and the Message/Media folder. The worker would then extract images to the
// uploads directory and link them via parent_id to the created chat document.

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
        doc_type, thread_id, email_from, email_to, email_subject, email_date, investigation_id, custodian
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'ready', 'chat', ?, ?, ?, ?, ?, ?, ?)
`);

async function main() {
    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);

        console.log(`✦ Chat Import: opening ${filepath} for investigation ${investigation_id}`);
        // Open the uploaded WhatsApp DB (read-only)
        const chatDb = new Database(filepath, { readonly: true });

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

        // Source 2: Session partner names (covers 1:1 chats)
        try {
            const partners = chatDb.prepare(`
                SELECT ZCONTACTJID as jid, ZPARTNERNAME as name
                FROM ZWACHATSESSION
                WHERE ZCONTACTJID IS NOT NULL AND ZPARTNERNAME IS NOT NULL AND ZPARTNERNAME != ''
            `).all();
            for (const p of partners) {
                if (!jidNameMap.has(p.jid)) {
                    jidNameMap.set(p.jid, p.name);
                }
            }
        } catch (e) { /* non-fatal */ }

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

        // ── Query all messages ──

        const stmt = chatDb.prepare(`
            SELECT
                s.Z_PK as session_id,
                COALESCE(s.ZPARTNERNAME, s.ZCONTACTJID, 'Unknown Chat') as session_name,
                m.ZTEXT as text,
                m.ZMESSAGEDATE as date_ts,
                m.ZISFROMME as is_from_me,
                m.ZFROMJID as from_jid
            FROM ZWACHATSESSION s
            JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK
            WHERE m.ZTEXT IS NOT NULL AND m.ZTEXT != ''
            ORDER BY s.Z_PK, m.ZMESSAGEDATE ASC
        `);

        console.log(`✦ Chat Import: querying messages...`);
        const messages = stmt.all();
        console.log(`✦ Chat Import: found ${messages.length} text messages`);

        let currentSessionId = null;
        let currentDayString = null;
        let currentDayTranscript = [];
        let totalChatDocs = 0;
        let currentSessionName = "Unknown";
        let currentDayDate = null;
        let currentSenders = new Set();       // who sent messages this day (for email_from)
        let currentParticipants = new Set();  // all participants in current session (for email_to)

        const flushTranscript = () => {
            if (currentDayTranscript.length > 0) {
                const docId = uuidv4();
                const sessionThreadId = `wa-chat-${currentSessionId}`;
                const content = currentDayTranscript.join('\n');

                const meta = sessionMeta.get(currentSessionId);
                const isGroup = meta?.isGroup || false;

                // email_from = all people who actually sent messages this day
                const fromList = [...currentSenders].join(', ');

                // email_to = all participants of the conversation
                let toList;
                if (isGroup) {
                    // Merge message-observed participants with pre-loaded group members
                    const allParticipants = new Set(currentParticipants);
                    const preloaded = groupParticipantsMap.get(currentSessionId);
                    if (preloaded) {
                        for (const p of preloaded) allParticipants.add(p);
                    }
                    allParticipants.add(custodianLabel); // custodian is always a participant
                    toList = [...allParticipants].join(', ');
                } else {
                    // 1:1 chat: both parties are participants
                    const otherParty = resolveJid(meta?.jid) || currentSessionName;
                    const participants = new Set([custodianLabel, otherParty]);
                    toList = [...participants].join(', ');
                }

                const subject = `WhatsApp${isGroup ? ' Group' : ''}: ${currentSessionName} (${currentDayString})`;
                const chatDocName = `Chat_${currentSessionName.replace(/[^a-zA-Z0-9]/g, '_')}_${currentDayString}.txt`;

                insertChat.run(
                    docId, chatDocName, chatDocName, Buffer.byteLength(content, 'utf8'), content,
                    sessionThreadId, fromList, toList, subject, currentDayDate.toISOString(),
                    investigation_id, custodian || null
                );

                totalChatDocs++;
                currentDayTranscript = [];
                currentSenders = new Set();
                // Don't reset currentParticipants — accumulate across days within a session
            }
        };

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const msgDate = convertCoreDataTimestamp(msg.date_ts);

            if (!msgDate) continue;

            const dayString = msgDate.toISOString().split('T')[0]; // YYYY-MM-DD
            const timeString = msgDate.toISOString().split('T')[1].substring(0, 5); // HH:MM

            // If session changed, flush and reset participants
            if (currentSessionId !== null && currentSessionId !== msg.session_id) {
                flushTranscript();
                currentParticipants = new Set(); // Reset for new session
            } else if (currentSessionId !== null && currentDayString !== dayString) {
                // Day changed within same session — flush but keep participants
                flushTranscript();
            }

            currentSessionId = msg.session_id;
            currentSessionName = msg.session_name;
            currentDayString = dayString;
            if (!currentDayDate || currentDayDate.toISOString().split('T')[0] !== dayString) {
                currentDayDate = msgDate;
            }

            // Resolve sender identity
            let sender;
            if (msg.is_from_me) {
                sender = custodianLabel;
            } else {
                sender = resolveJid(msg.from_jid) || currentSessionName;
            }

            currentSenders.add(sender);
            currentParticipants.add(sender);

            currentDayTranscript.push(`[${timeString}] ${sender}: ${msg.text}`);

            // Periodically update progress
            if (i % 10000 === 0) {
                const pct = Math.round((i / messages.length) * 100);
                updateProgress.run(totalChatDocs, pct, 'importing', jobId);
            }
        }

        // Flush last transcript
        flushTranscript();

        chatDb.close();

        db.prepare(`
            UPDATE import_jobs
            SET status = 'completed',
                phase = 'completed',
                total_emails = ?,
                progress_percent = 100,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(totalChatDocs, jobId);

        console.log(`✦ Chat Import: complete. Ingested ${totalChatDocs} daily chat transcripts.`);

        try {
            fs.unlinkSync(filepath);
        } catch (_) { /* Best effort */ }

    } catch (err) {
        console.error("Chat worker fatal error:", err);
        db.prepare(`
            UPDATE import_jobs
            SET status = 'failed',
                error_log = ?,
                completed_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify([{ error: err.message, fatal: true }]), jobId);
    }
}

main();
