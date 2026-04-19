/**
 * Manually finalize a stuck PST import.
 *
 * Usage: node server/scripts/finalize-stuck-import.mjs <investigation_id>
 *
 * Runs the same 5-step finalization the worker does on success:
 *   1. Mark import_jobs row as completed
 *   2. refreshInvestigationCounts
 *   3. Re-enable FTS triggers
 *   4. Rebuild FTS index
 *   5. WAL checkpoint
 *
 * Caller should stop the server first so the worker thread's unclosed
 * DB handle doesn't fight ours. After running, restart the server.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { enableFtsTriggers, rebuildFtsIndex, refreshInvestigationCounts, walCheckpoint, replicateChildrenToDuplicates } from '../lib/worker-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const investigationId = process.argv[2];
if (!investigationId) {
    console.error('Usage: node finalize-stuck-import.mjs <investigation_id>');
    process.exit(1);
}

const mainDbPath = path.join(DATA_DIR, 'ediscovery.db');
const invDbPath = path.join(DATA_DIR, 'investigations', `${investigationId}.db`);

console.log(`✦ Opening main DB:          ${mainDbPath}`);
const mainDb = new Database(mainDbPath);
mainDb.pragma('journal_mode = WAL');
mainDb.pragma('busy_timeout = 15000');

console.log(`✦ Opening investigation DB: ${invDbPath}`);
const db = new Database(invDbPath);
db.pragma('busy_timeout = 15000');

// Get the latest stuck job
const job = db.prepare(`
    SELECT id, status, phase, total_emails, total_attachments
    FROM import_jobs
    WHERE investigation_id = ?
    ORDER BY started_at DESC LIMIT 1
`).get(investigationId);

if (!job) {
    console.error(`No import job found for ${investigationId}`);
    process.exit(1);
}

console.log(`✦ Found job ${job.id}  status=${job.status}  phase=${job.phase}`);
console.log(`  total_emails=${job.total_emails}  total_attachments=${job.total_attachments}`);

// Recompute current totals from the documents table (more accurate than stale import_job counters)
const emailCount = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE doc_type='email'`).get().n;
const attCount = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE doc_type='attachment'`).get().n;
console.log(`  (live counts): email=${emailCount}  attachment=${attCount}`);

console.log('\n✦ Finalization [1/6]: marking job completed...');
db.prepare(`
    UPDATE import_jobs
    SET status = 'completed',
        phase = 'completed',
        total_emails = ?,
        total_attachments = ?,
        progress_percent = 100,
        error_log = COALESCE(error_log, '[]'),
        completed_at = datetime('now')
    WHERE id = ?
`).run(emailCount, attCount, job.id);
console.log('  done');

// GitHub issue #73: replicate canonical extracted children under duplicate parents.
// Idempotent — re-runs on already-replicated DBs insert zero rows.
console.log('✦ Finalization [2/6]: replicating children across duplicate parents (issue #73)...');
const replRes = replicateChildrenToDuplicates(db, investigationId);
console.log(`  done — ${replRes.totalInserted.toLocaleString()} rows across ${replRes.passes} pass(es)`);

console.log('✦ Finalization [3/6]: refreshing investigation counts...');
refreshInvestigationCounts(mainDb, db, investigationId);
console.log('  done');

console.log('✦ Finalization [4/6]: re-enabling FTS triggers...');
enableFtsTriggers(db);
console.log('  done');

console.log('✦ Finalization [5/6]: rebuilding FTS index (may take ~60s on large investigations)...');
const ftsStart = Date.now();
rebuildFtsIndex(db);
console.log(`  done in ${((Date.now() - ftsStart) / 1000).toFixed(1)}s`);

console.log('✦ Finalization [6/6]: WAL checkpoint...');
walCheckpoint(db);
console.log('  done');

db.close();
mainDb.close();
console.log('\n✓ Finalization complete. Investigation is ready for use.');
