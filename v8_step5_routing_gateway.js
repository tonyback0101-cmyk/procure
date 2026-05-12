/**
 * Step 5 — Routing & Persistence Gateway
 *
 * 1. Writes hot leads (score >= 90 with contact) to local SQLite main_db
 * 2. Queues lower-score leads for future enrichment
 * 3. Pushes all leads with contact info to the Catagent API (BulkL1Item format)
 *
 * Required env vars:
 *   CATAGENT_API_URL   — e.g. https://catagent.vercel.app
 *   CATAGENT_API_KEY   — internal API key / CRON_SECRET
 */
require('dotenv').config();
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const crypto   = require('crypto');

const [inputFile, outputFile] = process.argv.slice(2);

const CATAGENT_API_URL = (process.env.CATAGENT_API_URL || '').replace(/\/$/, '');
const CATAGENT_API_KEY = process.env.CATAGENT_API_KEY || '';
const DISCOVERY_JOB_ID = process.env.DISCOVERY_JOB_ID || null;
const SKIP_SQLITE = process.env.SKIP_SQLITE === 'true';
if (!CATAGENT_API_URL) { console.error('[step5] CATAGENT_API_URL env var is required'); process.exit(1); }

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Local SQLite ────────────────────────────────────────────────────────────
let insertMain = null;
let insertQueue = null;
if (!SKIP_SQLITE) {
    const db = new Database('zhimao_v8_matrix.sqlite');
    db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT UNIQUE, domain TEXT, country TEXT,
        primary_email TEXT, primary_phone TEXT,
        confidence_score INTEGER, entity_role TEXT, source TEXT, timestamp TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT UNIQUE, domain TEXT, score INTEGER, retries INTEGER DEFAULT 0
    )`);
    insertMain = db.prepare(`INSERT OR IGNORE INTO main_db (company_name, domain, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertQueue = db.prepare(`INSERT OR IGNORE INTO enrichment_queue (company_name, domain, score) VALUES (?, ?, ?)`);
} else {
    console.log('[step5] SKIP_SQLITE=true, local sqlite writes disabled.');
}

// Push ALL enriched leads to Catagent — contact info is optional.
// Hot leads (score>=90 + contact) are also written to local SQLite for fast lookup.
const validLeads = leads.filter(l => !!l.company_name);

leads.forEach(lead => {
    const hasContact = !!(lead.primary_email || lead.primary_phone);
    const isHot      = lead.confidence_score >= 90 && hasContact;
    if (isHot && insertMain) {
        insertMain.run(lead.company_name, lead.domain, lead.primary_email, lead.primary_phone, lead.confidence_score, lead.entity_role || null, lead.pillar, new Date().toISOString());
    } else if (lead.domain && insertQueue) {
        insertQueue.run(lead.company_name, lead.domain, lead.confidence_score);
    }
});

// ── Catagent API Push (BulkL1Item format) ───────────────────────────────────
function mapToBulkL1Item(lead) {
    return {
        name:                 lead.company_name || '',
        country:              lead.country      || '',
        domain:               lead.domain       || undefined,
        primary_email:        lead.primary_email || undefined,
        primary_phone:        lead.primary_phone || undefined,
        categories:           lead.inferred_bom  || undefined,
        place_type:           lead.entity_role   || undefined,
        // snippet used as address hint when no structured address available
        address_line:         lead.snippet?.slice(0, 200) || undefined,
        // L3 supply-chain inference (written to data_intel_l3_inferred by the bulk API)
        inference_breakdown:  lead.inference_breakdown || undefined,
    };
}

function pushToCatagent(items) {
    return new Promise(resolve => {
        const mappedItems = items.map(mapToBulkL1Item);
        // Support both payload shapes:
        //   - Legacy production format: { batch_id, timestamp, target_database, workflow_used, total_imported, data }
        //   - Current API format:       { items }
        // We send the legacy shape first (matches the deployed Vercel version).
        const payload = JSON.stringify({
            batch_id:        `v8_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            timestamp:       new Date().toISOString(),
            target_database: 'Zhimao Main DB',
            workflow_used:   'v8-pipeline',
            total_imported:  mappedItems.length,
            data:            mappedItems,
            // Also include the current-schema key so the route accepts either shape
            items:           mappedItems,
            discovery_job_id: DISCOVERY_JOB_ID,
        });
        const url      = new URL(`${CATAGENT_API_URL}/api/data-intel/l1/procurement/bulk`);
        const headers  = {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
        };
        if (CATAGENT_API_KEY) headers['Authorization'] = `Bearer ${CATAGENT_API_KEY}`;

        const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers }, res => {
            let body = ''; res.on('data', c => body += c);
            res.on('end', () => {
                console.log(`[step5] Catagent response: ${res.statusCode}`);
                try { console.log('[step5]', JSON.parse(body)); } catch { console.log('[step5]', body.slice(0, 200)); }
                resolve(res.statusCode);
            });
        });
        req.on('error', e => { console.error(`[step5] Catagent push failed: ${e.message}`); resolve(0); });
        req.write(payload); req.end();
    });
}

(async () => {
    if (validLeads.length > 0) {
        console.log(`[step5] Pushing ${validLeads.length} leads to Catagent...`);
        const statusCode = await pushToCatagent(validLeads);
        if (statusCode < 200 || statusCode >= 300) {
            console.error(`[step5] Catagent push failed with HTTP ${statusCode} — aborting.`);
            process.exit(1);
        }
    } else {
        console.log('[step5] No valid leads to push.');
    }
    fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
    console.log(`[step5] Done → ${outputFile}`);
})();
