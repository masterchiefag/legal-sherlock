import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const INV = process.argv[2];
const UPLOADS = '/Users/atulgoyal/dev/sherlock/uploads';

const db = new Database(`/Users/atulgoyal/dev/sherlock/data/investigations/${INV}.db`, { readonly: true });

// Get all failed ZIPs (no extracted children)
const failedZips = db.prepare(`
    SELECT z.id, z.filename, z.original_name, z.size_bytes
    FROM documents z
    WHERE z.file_extension = 'zip' AND z.doc_type = 'attachment'
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_id = z.id)
`).all();

console.log(`Total failed ZIPs to test: ${failedZips.length}\n`);

const results = {
    jszipOk: 0,
    jszipFail: 0,
    unzipOk: 0,
    unzipFail: 0,
    bothFail: 0,
    fileMissing: 0,
    totalEntries: 0,
    totalPdfs: 0,
    totalDocs: 0,
    totalOther: 0,
    jszipFailReasons: {},
    unzipFailReasons: {},
    samplesFailingBoth: [],
};

async function tryJszip(diskPath) {
    try {
        // Stream-friendlier: only read file if size reasonable
        const stat = fs.statSync(diskPath);
        if (stat.size > 500 * 1024 * 1024) return { ok: false, reason: 'size_too_large_for_mem' };
        const data = fs.readFileSync(diskPath);
        const zip = await JSZip.loadAsync(data);
        const entries = Object.keys(zip.files).filter(n => !zip.files[n].dir);
        return { ok: true, entries };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function tryUnzip(diskPath) {
    try {
        const { stdout } = await execFileAsync('zipinfo', [diskPath], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
        const entries = [];
        for (const line of stdout.split('\n')) {
            const m = line.match(/^[\w-]+\s+\d+\.\d+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
            if (m && !m[2].endsWith('/')) entries.push(m[2]);
        }
        return { ok: true, entries };
    } catch (e) {
        return { ok: false, reason: (e.message || '').substring(0, 200) };
    }
}

console.log(`Running... (may take 1-2 min)\n`);
const start = Date.now();

for (let i = 0; i < failedZips.length; i++) {
    const z = failedZips[i];
    const diskPath = path.join(UPLOADS, z.filename);
    if (!fs.existsSync(diskPath)) {
        results.fileMissing++;
        continue;
    }
    
    const js = await tryJszip(diskPath);
    const un = await tryUnzip(diskPath);
    
    if (js.ok) {
        results.jszipOk++;
        for (const name of js.entries) {
            results.totalEntries++;
            const lower = name.toLowerCase();
            if (lower.endsWith('.pdf')) results.totalPdfs++;
            else if (lower.match(/\.(docx?|xlsx?|pptx?)$/)) results.totalDocs++;
            else results.totalOther++;
        }
    } else {
        results.jszipFail++;
        const reason = js.reason.substring(0, 60);
        results.jszipFailReasons[reason] = (results.jszipFailReasons[reason] || 0) + 1;
    }
    
    if (un.ok) results.unzipOk++;
    else {
        results.unzipFail++;
        const reason = un.reason.substring(0, 80);
        results.unzipFailReasons[reason] = (results.unzipFailReasons[reason] || 0) + 1;
    }
    
    if (!js.ok && !un.ok) {
        results.bothFail++;
        if (results.samplesFailingBoth.length < 5) {
            results.samplesFailingBoth.push({
                name: z.original_name,
                size: z.size_bytes,
                jszipReason: js.reason.substring(0, 100),
                unzipReason: un.reason.substring(0, 100),
            });
        }
    }
    
    if ((i + 1) % 50 === 0) {
        process.stdout.write(`  ${i + 1}/${failedZips.length}...\r`);
    }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s\n`);

console.log('========== RESULTS ==========');
console.log(`Failed ZIPs tested:     ${failedZips.length}`);
console.log(`File missing on disk:    ${results.fileMissing}`);
console.log('');
console.log('With jszip:');
console.log(`  OK:   ${results.jszipOk}`);
console.log(`  Fail: ${results.jszipFail}`);
console.log('With unzip (shell):');
console.log(`  OK:   ${results.unzipOk}`);
console.log(`  Fail: ${results.unzipFail}`);
console.log('');
console.log(`BOTH fail: ${results.bothFail}`);
console.log(`Coverage improvement (jszip or unzip succeeds): ${failedZips.length - results.bothFail - results.fileMissing} / ${failedZips.length - results.fileMissing}`);
console.log('');
console.log('Content inside jszip-succeeded ZIPs:');
console.log(`  Total entries: ${results.totalEntries}`);
console.log(`  PDFs:          ${results.totalPdfs}`);
console.log(`  Docs/sheets:   ${results.totalDocs}`);
console.log(`  Other:         ${results.totalOther}`);
console.log('');

if (Object.keys(results.jszipFailReasons).length > 0) {
    console.log('jszip failure reasons:');
    for (const [r, n] of Object.entries(results.jszipFailReasons).sort((a,b) => b[1]-a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${r}`);
    }
    console.log('');
}
if (Object.keys(results.unzipFailReasons).length > 0) {
    console.log('unzip failure reasons (top 5):');
    const sorted = Object.entries(results.unzipFailReasons).sort((a,b) => b[1]-a[1]).slice(0, 5);
    for (const [r, n] of sorted) {
        console.log(`  ${String(n).padStart(4)}  ${r}`);
    }
    console.log('');
}

if (results.samplesFailingBoth.length > 0) {
    console.log('=== Samples where BOTH fail ===');
    for (const s of results.samplesFailingBoth) {
        console.log(`  ${s.name} (${(s.size/1024/1024).toFixed(1)} MB)`);
        console.log(`    jszip: ${s.jszipReason}`);
        console.log(`    unzip: ${s.unzipReason}`);
    }
}

db.close();
