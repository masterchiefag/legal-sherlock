/**
 * NL2SQL test runner — hits the local Ollama endpoint directly (no server needed).
 * Usage: node test-nl2sql.js
 * Requires Ollama running with gemma3:4b loaded.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';

// Build the same system prompt used in server/routes/search.js
function buildPrompt(query) {
    return `You are a strict JSON-only API that translates natural language into search parameters for an eDiscovery tool.
Do not output markdown. Do not wrap in \`\`\`json. Just output the raw JSON object.

IMPORTANT RULES:
- "q" is for full-text content search ONLY. If the user is NOT searching for specific text/keywords, omit "q" entirely or set it to "".
- "documents" means ALL types — do NOT set docType for generic document queries.
- Only set "docType" when the user explicitly asks for a specific type (emails, chats, files, attachments).
- For single keyword searches, do NOT quote the word: "q": "cost" not "q": "\\"cost\\"".
- Only use quotes for exact multi-word phrases: "q": "\\"secret project\\"".
- Use column prefixes when filtering on specific fields. Available FTS columns: original_name, email_subject, email_from, email_to.
  - email_from/email_to for sender/recipient filtering.
  - original_name for file type/extension filtering, e.g. original_name:pdf, original_name:docx.
- SQLite FTS5 uses NOT instead of !. For 1-to-1 emails, approximate by excluding cc: e.g. email_from:"Sandeep" AND email_to:"Manoj" NOT "cc"
- Use parentheses to group OR clauses when combining with AND: e.g. (original_name:xlsx OR original_name:xls) AND revenue

The parameters you can output:
- "q": FTS5 search string. Omit or "" if no text search needed.
- "docType": Optional. ONLY these exact values: "email", "chat", "file", "attachment". Omit entirely for all types. NEVER use "documents" or any other value.
- "dateFrom": Optional. YYYY-MM-DD format.
- "dateTo": Optional. YYYY-MM-DD format.

Example 1: "Find emails from Atul to John sent in January 2022"
{"q":"email_from:\\"Atul\\" AND email_to:\\"John\\"","docType":"email","dateFrom":"2022-01-01","dateTo":"2022-01-31"}

Example 2: "Find chats about the secret project"
{"q":"\\"secret project\\"","docType":"chat"}

Example 3: "show emails having text cost"
{"q":"cost","docType":"email"}

Example 4: "all documents having text cost"
{"q":"cost"}

Example 5: "all whatsapp chats"
{"docType":"chat"}

Example 6: "emails from last week"
{"docType":"email","dateFrom":"2024-03-25","dateTo":"2024-03-31"}

Example 7: "files about budget"
{"q":"budget","docType":"file"}

Example 8: "show pdf attachments"
{"q":"original_name:pdf","docType":"attachment"}

Example 9: "excel files"
{"q":"original_name:xlsx OR original_name:xls"}

Example 10: "excel attachments about revenue"
{"q":"(original_name:xlsx OR original_name:xls) AND revenue","docType":"attachment"}

Example 11: "pdf files mentioning contract"
{"q":"original_name:pdf AND contract"}

Draft a response for the user's input.
Input: ${JSON.stringify(query)}`;
}

const VALID_DOC_TYPES = ['email', 'chat', 'file', 'attachment'];

const TEST_CASES = [
    {
        input: 'all documents having text "cost"',
        expect: { q: 'cost', docType: undefined },
        check: (r) => r.q && r.q.includes('cost') && !r.docType
    },
    {
        input: 'all whatsapp chats',
        expect: { q: '', docType: 'chat' },
        check: (r) => (!r.q || r.q === '') && r.docType === 'chat'
    },
    {
        input: 'show 1to1 emails between Sandeep and Manoj',
        expect: { q: 'email_from:"Sandeep" AND email_to:"Manoj" NOT cc', docType: 'email' },
        check: (r) => r.docType === 'email' && r.q && r.q.includes('Sandeep') && r.q.includes('Manoj')
    },
    {
        input: 'show whatsapps from 2025',
        expect: { docType: 'chat', dateFrom: '2025-01-01' },
        check: (r) => r.docType === 'chat' && r.dateFrom && r.dateFrom.startsWith('2025')
    },
    {
        input: 'all documents having text "cost" or "exception and approval"',
        expect: { q: 'cost OR "exception and approval"' },
        check: (r) => r.q && r.q.includes('cost') && !r.docType
    },
    {
        input: 'show pdf attachments',
        expect: { q: 'original_name:pdf', docType: 'attachment' },
        check: (r) => r.docType === 'attachment' && r.q && r.q.includes('original_name') && r.q.includes('pdf')
    },
    {
        input: 'excel attachments about revenue',
        expect: { q: '(original_name:xlsx OR original_name:xls) AND revenue', docType: 'attachment' },
        check: (r) => r.docType === 'attachment' && r.q && r.q.includes('revenue') && r.q.includes('original_name')
    },
    {
        input: 'excel files about revenue',
        expect: { q: '(original_name:xlsx OR original_name:xls) AND revenue', docType: 'file' },
        check: (r) => r.q && r.q.includes('revenue') && r.q.includes('original_name')
    },
    {
        input: 'emails from Atul about budget',
        expect: { q: 'email_from:"Atul" AND budget', docType: 'email' },
        check: (r) => r.docType === 'email' && r.q && r.q.includes('Atul') && r.q.includes('budget')
    },
    {
        input: 'emails with subject containing urgent',
        expect: { q: 'email_subject:urgent', docType: 'email' },
        check: (r) => r.docType === 'email' && r.q && r.q.includes('email_subject') && r.q.includes('urgent')
    },
    {
        input: 'documents about contract but not renewal',
        expect: { q: 'contract NOT renewal' },
        check: (r) => r.q && r.q.includes('contract') && r.q.toUpperCase().includes('NOT') && r.q.includes('renewal') && !r.docType
    },
    {
        input: 'chats mentioning secret project',
        expect: { q: '"secret project"', docType: 'chat' },
        check: (r) => r.docType === 'chat' && r.q && r.q.includes('secret') && r.q.includes('project')
    },
    {
        input: 'files about budget',
        expect: { q: 'budget', docType: 'file' },
        check: (r) => r.docType === 'file' && r.q && r.q.includes('budget')
    },
    {
        input: 'emails from January 2024',
        expect: { docType: 'email', dateFrom: '2024-01-01', dateTo: '2024-01-31' },
        check: (r) => r.docType === 'email' && r.dateFrom && r.dateFrom.startsWith('2024-01') && r.dateTo && r.dateTo.startsWith('2024-01')
    },
];

async function callOllama(query) {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            prompt: buildPrompt(query),
            stream: false,
            format: 'json'
        })
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();

    let parsed;
    try {
        parsed = JSON.parse(data.response);
    } catch {
        const match = data.response.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : {};
    }

    // Apply same frontend validation
    if (parsed.docType && !VALID_DOC_TYPES.includes(parsed.docType)) {
        parsed.docType = undefined;
    }

    return parsed;
}

async function runTests() {
    console.log(`\nNL2SQL Test Suite — Model: ${MODEL}\n${'='.repeat(60)}\n`);

    let passed = 0;
    let failed = 0;

    for (const tc of TEST_CASES) {
        process.stdout.write(`"${tc.input}" ... `);
        try {
            const result = await callOllama(tc.input);
            const ok = tc.check(result);

            if (ok) {
                console.log(`PASS`);
                console.log(`  Got: ${JSON.stringify(result)}`);
                passed++;
            } else {
                console.log(`FAIL`);
                console.log(`  Expected: ${JSON.stringify(tc.expect)}`);
                console.log(`  Got:      ${JSON.stringify(result)}`);
                failed++;
            }
        } catch (err) {
            console.log(`ERROR: ${err.message}`);
            failed++;
        }
        console.log();
    }

    console.log('='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed out of ${TEST_CASES.length}`);
    console.log();

    if (failed > 0) process.exit(1);
}

runTests();
