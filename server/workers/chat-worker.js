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

const updateProgress = db.prepare(
    "UPDATE import_jobs SET total_emails = ?, progress_percent = ?, phase = ? WHERE id = ?"
);

const insertChat = db.prepare(`
    INSERT INTO documents (
        id, filename, original_name, mime_type, size_bytes, text_content, status,
        doc_type, thread_id, email_from, email_subject, email_date, investigation_id, custodian
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'ready', 'chat', ?, ?, ?, ?, ?, ?)
`);

async function main() {
    try {
        db.prepare("UPDATE import_jobs SET status = 'processing', phase = 'reading' WHERE id = ?").run(jobId);

        console.log(`✦ Chat Import: opening ${filepath} for investigation ${investigation_id}`);
        // Open the uploaded WhatsApp DB (read-only)
        const chatDb = new Database(filepath, { readonly: true });
        
        let chatsQuery;
        try {
            // Verify it's an iOS WhatsApp ChatStorage.sqlite
            chatDb.prepare("SELECT 1 FROM ZWACHATSESSION LIMIT 1").get();
        } catch (e) {
            throw new Error("Invalid format: Not a recognized iOS WhatsApp ChatStorage database.");
        }

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
        let currentDayDate = null; // Stored to set as email_date

        const flushTranscript = () => {
            if (currentDayTranscript.length > 0) {
                const docId = uuidv4();
                const sessionThreadId = `wa-chat-${currentSessionId}`; // Group all days of a chat into a single thread
                const content = currentDayTranscript.join('\n');
                const subject = `WhatsApp: ${currentSessionName} (${currentDayString})`;
                
                // Construct a fake original name so it displays nicely
                const chatDocName = `Chat_${currentSessionName.replace(/[^a-zA-Z0-9]/g, '_')}_${currentDayString}.txt`;

                insertChat.run(
                    docId, chatDocName, chatDocName, Buffer.byteLength(content, 'utf8'), content,
                    sessionThreadId, currentSessionName, subject, currentDayDate.toISOString(), investigation_id, custodian || null
                );
                
                totalChatDocs++;
                currentDayTranscript = [];
            }
        };

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const msgDate = convertCoreDataTimestamp(msg.date_ts);
            
            if (!msgDate) continue;

            const dayString = msgDate.toISOString().split('T')[0]; // YYYY-MM-DD
            const timeString = msgDate.toISOString().split('T')[1].substring(0, 5); // HH:MM
            
            // If session or day changed, flush previous transcript to DB
            if (currentSessionId !== null && (currentSessionId !== msg.session_id || currentDayString !== dayString)) {
                flushTranscript();
            }

            currentSessionId = msg.session_id;
            currentSessionName = msg.session_name;
            currentDayString = dayString;
            if (!currentDayDate || currentDayDate.toISOString().split('T')[0] !== dayString) {
                currentDayDate = msgDate; 
            }

            // Append message to transcript
            let sender = msg.is_from_me ? "Me" : (msg.from_jid || currentSessionName);
            // Replace full JID suffix to make it readable (e.g., 123456789@s.whatsapp.net -> 123456789)
            sender = sender.replace('@s.whatsapp.net', '').replace('@g.us', '');

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
