/**
 * Step 5 – Routing & Persistence Gateway
 *
 * Tier1 (final_intent_score ≥90 + contact) → Ops 热库 (SQLite main_db + Catagent)
 * Tier2 (final_intent_score ≥60)           → 主库 (Catagent push; contact → main_db)
 * Tier3 (<60 + domain)                     → enrichment_queue (待二次富化)
 *
 * Required env vars:
 *   CATAGENT_API_URL  – e.g. https://catagent.vercel.app
 *   CATAGENT_API_KEY  – internal API key / CRON_SECRET
 */
require('dotenv').config();
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const { evaluateLead } = require('./v8_quality_gate');

const [inputFile, outputFile] = process.argv.slice(2);

const CATAGENT_API_URL  = (process.env.CATAGENT_API_URL || '').replace(/\/$/, '');
const CATAGENT_API_KEY  = process.env.CATAGENT_API_KEY  || '';
const DISCOVERY_JOB_ID  = process.env.DISCOVERY_JOB_ID  || null;
const SKIP_SQLITE       = process.env.SKIP_SQLITE === 'true';
const FALLBACK_PATH     = process.env.OPS_FALLBACK_PATH  || 'ops_hot_inbox_fallback.json';
const SEED_PATH         = 'zhimao_seed_intelligence.json';
const SEED_CONFIDENCE_MIN = Number(process.env.SEED_CONFIDENCE_MIN) || 90;
if (!CATAGENT_API_URL) { console.error('[step5] CATAGENT_API_URL env var is required'); process.exit(1); }

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Budget estimation from knowledge base ─────────────────────────────────
function loadBudgetKnowledge() {
    try {
        if (fs.existsSync('zhimao_supply_chain_economics.json'))
            return JSON.parse(fs.readFileSync('zhimao_supply_chain_economics.json', 'utf8')).industries || {};
    } catch (_) {}
    return {};
}
function estimateProcurementBudget(lead, knowledge) {
    const text = `${lead.entity_role || ''} ${lead.snippet || ''}`.toLowerCase();
    for (const [, data] of Object.entries(knowledge)) {
        const bc = data.budget_calculation;
        if (!bc) continue;
        const buyMatch  = (data.make_vs_buy_triggers?.buy_signals  || []).some(s => text.includes(s.toLowerCase()));
        const makeMatch = (data.make_vs_buy_triggers?.make_signals || []).some(s => text.includes(s.toLowerCase()));
        if (buyMatch || makeMatch) {
            const employees    = 20;
            const annualRevUSD = employees * (bc.revenue_per_employee_usd || 100000);
            return Math.round(annualRevUSD * (bc.procurement_ratio_of_revenue || 0.3));
        }
    }
    return null;
}
const budgetKnowledge = loadBudgetKnowledge();

// ── Fallback inbox (API failure safety net) ───────────────────────────────
function writeFallbackInbox(items, reason) {
    if (!items?.length) return;
    let existing = [];
    try { if (fs.existsSync(FALLBACK_PATH)) existing = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8')); } catch (_) {}
    if (!Array.isArray(existing)) existing = [];
    const now = new Date().toISOString();
    existing.push(...items.map(lead => ({ reason, created_at: now, discovery_job_id: DISCOVERY_JOB_ID, lead })));
    fs.writeFileSync(FALLBACK_PATH, JSON.stringify(existing, null, 2));
    console.warn(`[step5] fallback inbox appended: +${items.length} → ${FALLBACK_PATH} (total=${existing.length})`);
}

// ── Local SQLite ──────────────────────────────────────────────────────────
let insertMain = null, insertQueue = null;
if (!SKIP_SQLITE) {
    const db = new Database('zhimao_v8_matrix.sqlite');
    db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        primary_email TEXT, primary_phone TEXT,
        confidence_score INTEGER, entity_role TEXT, source TEXT, timestamp TEXT,
        UNIQUE(company_name, country)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        score INTEGER, retries INTEGER DEFAULT 0,
        UNIQUE(company_name, country)
    )`);
    insertMain  = db.prepare(`INSERT OR IGNORE INTO main_db (company_name, domain, country, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertQueue = db.prepare(`INSERT OR IGNORE INTO enrichment_queue (company_name, domain, country, score) VALUES (?, ?, ?, ?)`);
} else {
    console.log('[step5] SKIP_SQLITE=true, local SQLite writes disabled.');
}

// ── Seed intelligence feed-back ───────────────────────────────────────────
function appendToSeedIntelligence(lead, score) {
    if (score < SEED_CONFIDENCE_MIN) return;
    try {
        let seeds = [];
        if (fs.existsSync(SEED_PATH)) seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
        if (!Array.isArray(seeds)) seeds = [];
        const exists = seeds.some(s => s.domain === lead.domain && s.country === lead.country);
        if (!exists) {
            seeds.push({ company_name: lead.company_name, domain: lead.domain, country: lead.country || '', primary_email: lead.primary_email || null, entity_role: lead.entity_role || null, inferred_bom: lead.inferred_bom || [], confidence_score: score, seeded_at: new Date().toISOString() });
            fs.writeFileSync(SEED_PATH, JSON.stringify(seeds, null, 2));
        }
    } catch (_) {}
}

const validLeads = [];

leads.forEach(lead => {
    // Budget estimation
    const budget = estimateProcurementBudget(lead, budgetKnowledge);
    if (budget) lead.estimated_procurement_budget_usd = budget;

    // Temporal decay — propagate to both score fields
    const decayPenalty = applyTemporalDecay(lead);
    if (decayPenalty > 0) {
        lead.confidence_score = Math.max((lead.confidence_score || 50) - decayPenalty, 1);
        if (lead.final_intent_score != null)
            lead.final_intent_score = Math.max(lead.final_intent_score - decayPenalty, 1);
        lead.decay_penalty = decayPenalty;
    }

    // P0 quality gate (mirrors zhimao computeQualityGrade — no point pushing unqualified)
    const { grade } = evaluateLead(lead);
    if (grade === 'unqualified') return;

    // Canonical routing score: final_intent_score (Step3) → confidence_score fallback
    const score      = lead.final_intent_score ?? lead.confidence_score ?? 50;
    const hasContact = !!(lead.primary_email || lead.primary_phone);
    const nowIso     = new Date().toISOString();
    const country    = lead.country || '';

    // Tier 1 — Hot (≥90 + contact): Ops 热库 + Catagent
    if (score >= 90 && hasContact) {
        if (insertMain) insertMain.run(lead.company_name, lead.domain, country, lead.primary_email, lead.primary_phone, score, lead.entity_role || null, lead.pillar, nowIso);
        appendToSeedIntelligence(lead, score);
        validLeads.push(lead);
    // Tier 2 — Warm (≥60): 主库 → Catagent; 有联系方式则写 main_db
    } else if (score >= 60) {
        validLeads.push(lead);
        if (insertQueue && lead.domain) insertQueue.run(lead.company_name, lead.domain, country, score);
        if (insertMain && hasContact)   insertMain.run(lead.company_name, lead.domain, country, lead.primary_email, lead.primary_phone, score, lead.entity_role || null, lead.pillar, nowIso);
    // Tier 3 — Cold (<60): 仅进待富化队列
    } else if (lead.domain) {
        if (insertQueue) insertQueue.run(lead.company_name, lead.domain, country, score);
    }
});

// ?????? Temporal Decay Factor ????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????
// Pillar ??????????????????????????????????
const PILLAR_HALF_LIFE_DAYS = {
    'Pillar 0 Seed':                60,   // ???????????
    'Pillar 1 Maps':                30,
    'Pillar 2 B2B':                 21,
    'Pillar 3 Customs/ImportYeti':  45,
    'Pillar 3 Customs/Volza':       45,
    'Pillar 3 Customs/BoL':         45,
    'Pillar 4 Social General':      14,
    'Pillar 4 Social FB-Intent':     7,   // ?????????????????????????
    'Pillar 4 Social LinkedIn-Intent': 14,
    'Pillar 4 Social WhatsApp':      7,
    'Pillar 4 Social Threads':       7,
    'Pillar 5a Tenders':            14,
    'Pillar 5b Compliance':         90,   // ????????????????
    'Pillar 6 Exhibitions':         30,
};
const DEFAULT_HALF_LIFE_DAYS = 21;
const MAX_DECAY_PENALTY      = 30;  // ?????????????????????????????

function applyTemporalDecay(lead) {
    if (!lead.source_timestamp) return 0;
    const ageMs      = Date.now() - new Date(lead.source_timestamp).getTime();
    const ageDays    = ageMs / (1000 * 60 * 60 * 24);
    const halfLife   = PILLAR_HALF_LIFE_DAYS[lead.pillar] || DEFAULT_HALF_LIFE_DAYS;
    // ????????????????decay = score * (1 - 2^(-age/halfLife))
    const decayRatio = 1 - Math.pow(2, -ageDays / halfLife);
    const penalty    = Math.round(Math.min((lead.confidence_score || 50) * decayRatio, MAX_DECAY_PENALTY));
    return penalty;
}

// ?????? Catagent API Push (BulkL1Item format) ?????????????????????????????????????????????????????????????????????????????????????????????????????????
function mapToBulkL1Item(lead) {
    return {
        name:          lead.company_name || '',
        country:       lead.country      || '',
        domain:        lead.domain       || undefined,
        primary_email: lead.primary_email || undefined,
        primary_phone: lead.primary_phone || undefined,
        categories:    lead.inferred_bom  || undefined,
        place_type:    lead.entity_role   || undefined,
        address_line:  lead.snippet?.slice(0, 200) || undefined,
        // Knowledge-base derived fields
        ...(lead.estimated_procurement_budget_usd != null && {
            quantity_hint: `est_budget_usd:${lead.estimated_procurement_budget_usd}`,
        }),
        // Scoring & provenance metadata
        ...(lead.final_intent_score != null && { final_intent_score: lead.final_intent_score }),
        ...(lead.inference_breakdown        && { inference_breakdown: lead.inference_breakdown }),
        ...(lead.source_timestamp           && { source_timestamp:   lead.source_timestamp }),
        ...(lead.decay_penalty              && { decay_penalty:      lead.decay_penalty }),
        ...(lead.intent_signal              && { intent_signal:      lead.intent_signal }),
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
        await pushToCatagent(validLeads);
    } else {
        console.log('[step5] No valid leads to push.');
    }
    fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
    console.log(`[step5] Done ??? ${outputFile}`);
})();
