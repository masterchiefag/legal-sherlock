/**
 * End-to-end validator for the PR #66 branch.
 *
 * Exercises the production code path — the actual `listZipContents` and
 * `extractFileFromZip` exports from server/lib/container-helpers.js — against
 * the failed ZIPs from the Yesha investigation. Previously, the shell-unzip
 * code path failed on 386/386 of these (UTF-8 filename mojibake); with the
 * jszip-first branch the vast majority should now list and extract cleanly.
 *
 * Usage:  node server/scripts/validate-container-helpers-e2e.mjs <investigation_id>
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { listZipContents, extractFileFromZip } from '../lib/container-helpers.js';

const INV = process.argv[2];
if (!INV) {
    console.error('Usage: node validate-container-helpers-e2e.mjs <investigation_id>');
    process.exit(1);
}

const UPLOADS = '/Users/atulgoyal/dev/sherlock/uploads';
const db = new Database(
    `/Users/atulgoyal/dev/sherlock/data/investigations/${INV}.db`,
    { readonly: true }
);

// All ZIP attachments that never yielded children — i.e. failed under the old
// shell-unzip code path.
const failedZips = db.prepare(`
    SELECT z.id, z.filename, z.original_name, z.size_bytes
    FROM documents z
    WHERE z.file_extension = 'zip' AND z.doc_type = 'attachment'
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_id = z.id)
`).all();

console.log(`Validating ${failedZips.length} previously-failed ZIPs via container-helpers.js\n`);

const results = {
    listOk: 0,
    listFail: 0,
    extractOk: 0,
    extractFail: 0,
    extractSkippedNoCandidate: 0,
    fileMissing: 0,
    totalEntries: 0,
    totalPdfs: 0,
    listFailReasons: {},
    extractFailReasons: {},
    samplesFailingList: [],
};

const start = Date.now();
for (let i = 0; i < failedZips.length; i++) {
    const z = failedZips[i];
    const diskPath = path.join(UPLOADS, z.filename);
    if (!fs.existsSync(diskPath)) { results.fileMissing++; continue; }

    // 1) listZipContents
    let entries;
    try {
        entries = await listZipContents(diskPath);
        results.listOk++;
        results.totalEntries += entries.length;
        results.totalPdfs += entries.filter(e => e.path.toLowerCase().endsWith('.pdf')).length;
    } catch (e) {
        results.listFail++;
        const r = (e.message || '').substring(0, 80);
        results.listFailReasons[r] = (results.listFailReasons[r] || 0) + 1;
        if (results.samplesFailingList.length < 5) {
            results.samplesFailingList.push({ name: z.original_name, size: z.size_bytes, reason: r });
        }
        continue;
    }

    // 2) extractFileFromZip on the first non-empty entry
    const candidate = entries.find(e => e.size > 0);
    if (!candidate) { results.extractSkippedNoCandidate++; continue; }
    try {
        const buf = await extractFileFromZip(diskPath, candidate.path);
        if (Buffer.isBuffer(buf) && buf.length > 0) results.extractOk++;
        else { results.extractFail++; results.extractFailReasons['empty_buffer'] = (results.extractFailReasons['empty_buffer'] || 0) + 1; }
    } catch (e) {
        results.extractFail++;
        const r = (e.message || '').substring(0, 80);
        results.extractFailReasons[r] = (results.extractFailReasons[r] || 0) + 1;
    }

    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${failedZips.length}...\r`);
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\nDone in ${elapsed}s\n`);
console.log('========== RESULTS (production container-helpers.js path) ==========');
console.log(`ZIPs tested:          ${failedZips.length}`);
console.log(`File missing on disk: ${results.fileMissing}`);
console.log('');
console.log(`listZipContents:   OK=${results.listOk}   Fail=${results.listFail}`);
console.log(`extractFileFromZip: OK=${results.extractOk}  Fail=${results.extractFail}  NoCandidate=${results.extractSkippedNoCandidate}`);
console.log('');
console.log(`Total entries recoverable: ${results.totalEntries}  (PDFs=${results.totalPdfs})`);

if (Object.keys(results.listFailReasons).length) {
    console.log('\nlist failure reasons:');
    for (const [r, n] of Object.entries(results.listFailReasons).sort((a,b) => b[1]-a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${r}`);
    }
}
if (Object.keys(results.extractFailReasons).length) {
    console.log('\nextract failure reasons:');
    for (const [r, n] of Object.entries(results.extractFailReasons).sort((a,b) => b[1]-a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${r}`);
    }
}
if (results.samplesFailingList.length) {
    console.log('\nSamples where listZipContents still failed:');
    for (const s of results.samplesFailingList) {
        console.log(`  ${s.name} (${(s.size/1024/1024).toFixed(1)} MB)  reason: ${s.reason}`);
    }
}

db.close();
