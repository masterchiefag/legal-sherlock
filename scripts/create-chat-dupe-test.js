#!/usr/bin/env node
/**
 * Creates a minimal WhatsApp ChatStorage.sqlite + ZIP for testing the
 * chat-worker duplicate backfill path.
 *
 * Output: sherlock_misc/test_files/chat-dupe-test.zip containing:
 *   - ChatStorage.sqlite  (iOS WhatsApp schema with 1 session, 4 messages, 3 media)
 *   - Media/photo1.jpg    (unique file)
 *   - Media/photo2.jpg    (DUPLICATE of photo1.jpg — same content)
 *   - Media/doc1.pdf      (unique file)
 *
 * After import, the worker should:
 *   - Create 1 chat transcript document (1 day of messages)
 *   - Create 3 attachment documents (photo1, photo2, doc1)
 *   - Mark photo2 as is_duplicate=1 (same MD5 as photo1)
 *   - backfillDuplicateText() should copy text from photo1's original to photo2
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const OUTPUT_DIR = '/Users/atulgoyal/dev/sherlock_misc/test_files';
const tmpDir = path.join(os.tmpdir(), `chat-dupe-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'Media'), { recursive: true });

// CoreData epoch: seconds between 1970-01-01 and 2001-01-01
const CORE_DATA_OFFSET = 978307200;
const now = Math.floor(Date.now() / 1000) - CORE_DATA_OFFSET;

// ─── Create media files ───
// photo1 and photo2 have IDENTICAL content (will be detected as duplicates)
const photoContent = Buffer.from('FAKE-JPEG-CONTENT-FOR-TESTING-DUPLICATES-1234567890');
fs.writeFileSync(path.join(tmpDir, 'Media', 'photo1.jpg'), photoContent);
fs.writeFileSync(path.join(tmpDir, 'Media', 'photo2.jpg'), photoContent); // same content = dupe
// doc1 is unique
const pdfContent = Buffer.from('%PDF-1.4 FAKE-PDF-UNIQUE-CONTENT-9876543210');
fs.writeFileSync(path.join(tmpDir, 'Media', 'doc1.pdf'), pdfContent);

// ─── Create ChatStorage.sqlite ───
const dbPath = path.join(tmpDir, 'ChatStorage.sqlite');
const db = new Database(dbPath);

db.exec(`
    -- Minimal iOS WhatsApp schema
    CREATE TABLE ZWACHATSESSION (
        Z_PK INTEGER PRIMARY KEY,
        ZCONTACTJID TEXT,
        ZPARTNERNAME TEXT
    );

    CREATE TABLE ZWAMESSAGE (
        Z_PK INTEGER PRIMARY KEY,
        ZCHATSESSION INTEGER,
        ZTEXT TEXT,
        ZMESSAGEDATE REAL,
        ZISFROMME INTEGER DEFAULT 0,
        ZFROMJID TEXT,
        ZMESSAGETYPE INTEGER DEFAULT 0,
        ZFLAGS INTEGER DEFAULT 0,
        ZGROUPMEMBER INTEGER,
        ZMEDIAITEM INTEGER,
        FOREIGN KEY (ZCHATSESSION) REFERENCES ZWACHATSESSION(Z_PK)
    );

    CREATE TABLE ZWAMEDIAITEM (
        Z_PK INTEGER PRIMARY KEY,
        ZMESSAGE INTEGER,
        ZMEDIALOCALPATH TEXT,
        ZTITLE TEXT,
        ZFILESIZE INTEGER,
        FOREIGN KEY (ZMESSAGE) REFERENCES ZWAMESSAGE(Z_PK)
    );

    CREATE TABLE ZWAGROUPMEMBER (
        Z_PK INTEGER PRIMARY KEY,
        ZCHATSESSION INTEGER,
        ZMEMBERJID TEXT,
        ZCONTACTNAME TEXT
    );

    CREATE TABLE ZWAPROFILEPUSHNAME (
        Z_PK INTEGER PRIMARY KEY,
        ZJID TEXT,
        ZPUSHNAME TEXT
    );
`);

// Insert a 1:1 chat session
db.prepare(`INSERT INTO ZWACHATSESSION (Z_PK, ZCONTACTJID, ZPARTNERNAME)
    VALUES (1, '919876543210@s.whatsapp.net', 'John Doe')`).run();

// Insert messages — all on the same day so they merge into one transcript
// Message 1: plain text
db.prepare(`INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZTEXT, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZMEDIAITEM)
    VALUES (1, 1, 'Hello, sharing some files', ?, 1, 0, NULL)`).run(now);

// Message 2: image (photo1) — type 1 = image
db.prepare(`INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZTEXT, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZMEDIAITEM)
    VALUES (2, 1, 'Check this photo', ?, 0, 1, 1)`).run(now + 60);
db.prepare(`INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE, ZFILESIZE)
    VALUES (1, 2, 'Media/photo1.jpg', 'photo1', ?)`).run(photoContent.length);

// Message 3: image (photo2) — DUPLICATE content of photo1
db.prepare(`INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZTEXT, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZMEDIAITEM)
    VALUES (3, 1, 'Same photo again', ?, 1, 1, 2)`).run(now + 120);
db.prepare(`INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE, ZFILESIZE)
    VALUES (2, 3, 'Media/photo2.jpg', 'photo2', ?)`).run(photoContent.length);

// Message 4: document (doc1.pdf) — type 8 = document
db.prepare(`INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZTEXT, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZMEDIAITEM)
    VALUES (4, 1, 'doc1.pdf', ?, 0, 8, 3)`).run(now + 180);
db.prepare(`INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE, ZFILESIZE)
    VALUES (3, 4, 'Media/doc1.pdf', 'doc1.pdf', ?)`).run(pdfContent.length);

db.close();
console.log(`✓ Created ChatStorage.sqlite at ${dbPath}`);
console.log(`  - 1 session, 4 messages, 3 media items`);
console.log(`  - photo1.jpg and photo2.jpg have identical content (duplicate test)`);

// ─── Create ZIP ───
const zipPath = path.join(OUTPUT_DIR, 'chat-dupe-test.zip');
// Remove old ZIP if exists
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

execSync(`cd "${tmpDir}" && zip -r "${zipPath}" ChatStorage.sqlite Media/`, { stdio: 'inherit' });

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n✓ Created ${zipPath}`);
console.log(`\nTo test: upload this ZIP as a WhatsApp chat import, then verify:`);
console.log(`  1. photo2 is marked is_duplicate=1`);
console.log(`  2. backfillDuplicateText() runs and backfills text for photo2`);
