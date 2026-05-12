require('dotenv').config();
const fs      = require('fs');
const https   = require('https');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const [inputFile, outputFile] = process.argv.slice(2);

const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step3] GEMINI_KEY env var is required'); process.exit(1); }

// BrightData proxy ??optional; set USE_PROXY=true in .env to enable
const BRD_USER  = process.env.BRD_USER  || '';
const BRD_PASS  = process.env.BRD_PASS  || '';
const BRD_PROXY = process.env.BRD_PROXY || 'http://brd.superproxy.io:22225';
const USE_PROXY = process.env.USE_PROXY === 'true';
const USE_BRD_SB = process.env.USE_BRD_SB === 'true';
const BRD_SB_WSS = process.env.BRD_SB_WSS || '';

const PLAYWRIGHT_TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '15000', 10);
const BOM_BATCH_SIZE     = parseInt(process.env.BOM_BATCH_SIZE || '20', 10);

async function callGemini(promptText) {
    const reqData = JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
    return new Promise(resolve => {
        const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
        });
        req.on('error', () => resolve(null)); req.write(reqData); req.end();
    });
}

/**
 * L3 Supply Chain Inference (replaces legacy inferBOMGraph).
 *
 * Each lead gets a structured `inference_breakdown` (mirrors data_intel_l3_inferred schema)
 * plus the flat fields kept for backwards compatibility:
 *   lead.entity_role      — "Manufacturer" | "Wholesaler" | "Retailer" | "Service"
 *   lead.inferred_bom     — string[] of top procurement materials (for L1 semantic_intent)
 *   lead.inference_breakdown — full L3 JSON written to data_intel_l3_inferred
 */
async function inferL3SupplyChain(leads) {
    if (leads.length === 0) return leads;
    console.log(`[step3] L3 supply-chain inference for ${leads.length} entities (batch=${BOM_BATCH_SIZE})...`);

    for (let i = 0; i < leads.length; i += BOM_BATCH_SIZE) {
        const batch  = leads.slice(i, i + BOM_BATCH_SIZE);
        const prompt = `You are a Supply Chain Intelligence AI. Analyze each company and produce a structured L3 procurement inference.

Rules:
1. entity_role: "Manufacturer" (makes goods), "Wholesaler" (bulk buys/resells), "Retailer" (end-consumer facing), "Service" (services only).
2. primary_materials_top3: exactly 3 upstream raw materials or finished goods they must procure. Use short English snake_case keys (e.g. "memory_foam", "pocket_springs", "fabric_ticking").
3. procurement_items: array of {category, priority(1-3), source:"bom", type:"explicit"}.
4. confidence_tier: "High" (role is unambiguous), "Medium" (probable), "Low" (guessed).
5. intent_summary: one English sentence — "<Name> is a <role> that procures <top materials> from upstream suppliers."
6. purchase_cycle: "weekly" | "monthly" | "quarterly" | "annual" — best estimate.
7. reason_codes: non-empty array from ["BOM_INFERENCE","ENTITY_ROLE_MANUFACTURER","ENTITY_ROLE_WHOLESALER","ENTITY_ROLE_RETAILER","ENTITY_ROLE_SERVICE","SUPPLY_CHAIN_GRAPH"].

Output strict JSON only:
{"results":[{"name":"Exact Company Name","entity_role":"...","confidence_tier":"...","primary_materials_top3":["...","...","..."],"procurement_items":[{"category":"...","priority":1,"source":"bom","type":"explicit"}],"intent_summary":"...","purchase_cycle":"...","reason_codes":["..."]}]}

Input: ${JSON.stringify(batch.map(l => ({ name: l.company_name, snip: (l.snippet || '').slice(0, 120) })))}`;

        try {
            const resData = await callGemini(prompt);
            const parsed  = JSON.parse(resData);
            const results = JSON.parse(parsed.candidates[0].content.parts[0].text).results;
            const now = new Date().toISOString();
            results.forEach(r => {
                const lead = batch.find(l => l.company_name === r.name);
                if (!lead) return;
                lead.entity_role  = r.entity_role || 'Service';
                lead.inferred_bom = Array.isArray(r.primary_materials_top3) ? r.primary_materials_top3 : [];
                // Boost confidence score for clear buyer roles
                if (r.entity_role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
                else if (r.entity_role === 'Wholesaler' || r.entity_role === 'Retailer') lead.confidence_score = (lead.confidence_score || 50) + 10;
                // Attach full L3 breakdown for later persistence
                lead.inference_breakdown = {
                    category:              lead.inferred_bom[0] || null,
                    entity_role:           r.entity_role,
                    confidence_tier:       r.confidence_tier || 'Medium',
                    primary_materials_top3: lead.inferred_bom,
                    procurement_items:     Array.isArray(r.procurement_items) ? r.procurement_items : [],
                    intent_summary:        r.intent_summary || '',
                    purchase_cycle:        r.purchase_cycle || 'quarterly',
                    reason_codes:          Array.isArray(r.reason_codes) ? r.reason_codes : ['BOM_INFERENCE'],
                    model_version:         'v8-gemini-l3-v1',
                    demand_source:         'inferred',
                    graph_snapshot_version:'v1',
                    created_at:            now,
                    rfq_draft: {
                        title:        r.intent_summary || '',
                        description:  r.intent_summary || '',
                        status:       'open',
                        visibility:   'public',
                        source_type:  'l3_inferred',
                        currency:     'USD',
                        published_at: now,
                    },
                };
            });
            console.log(`[step3] L3 batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} done`);
        } catch (e) {
            console.warn(`[step3] L3 batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} failed: ${e.message}`);
        }
    }
    return leads;
}

const extractFromHTML = (html, emails, phones) => {
    const $ = cheerio.load(html);
    $('a[href^="mailto:"]').each((_, el) => emails.add($(el).attr('href').replace('mailto:', '').split('?')[0].trim()));
    $('a[href^="tel:"]').each((_, el) => phones.add($(el).attr('href').replace('tel:', '').trim()));
    $('a[href*="wa.me/"]').each((_, el) => phones.add($(el).attr('href')));
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g;
    let match;
    while ((match = emailRegex.exec($('body').text())) !== null) {
        const em = match[1].toLowerCase();
        if (!em.endsWith('.png') && !em.endsWith('.jpg') && !em.endsWith('.jpeg')) emails.add(em);
    }
};

async function run() {
    let leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    leads = await inferL3SupplyChain(leads);

    let browser;
    if (USE_BRD_SB) {
        if (!BRD_SB_WSS) {
            console.error('[step3] USE_BRD_SB=true but BRD_SB_WSS not set');
            process.exit(1);
        }
        console.log('[step3] Using BrightData Scraping Browser via CDP');
        browser = await chromium.connectOverCDP(BRD_SB_WSS);
    } else {
        const launchOptions = { headless: true };
        if (USE_PROXY) {
            if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
            console.log(`[step3] Proxy enabled: ${BRD_PROXY}`);
            launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
        }
        // Self-heal: if chromium binary is missing (e.g. Render ephemeral filesystem),
        // install it on the spot then retry once.
        try {
            browser = await chromium.launch(launchOptions);
        } catch (launchErr) {
            if (String(launchErr.message).includes("Executable doesn't exist")) {
                console.log("[step3] Chromium not found — installing now (first-run on this host)...");
                require('child_process').execSync(
                    'node ' + require('path').join(__dirname, 'node_modules', '.bin', 'playwright') + ' install chromium',
                    { stdio: 'inherit' }
                );
                console.log("[step3] Chromium install complete — retrying launch...");
                browser = await chromium.launch(launchOptions);
            } else {
                throw launchErr;
            }
        }
    }
    const context        = await browser.newContext({ ignoreHTTPSErrors: true });
    const mobileContext  = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' });

    const enriched = [];
    for (const l of leads) {
        let score = l.confidence_score || 50;
        l.primary_email = l.primary_email || l.email || null;
        l.primary_phone = l.primary_phone || l.phone || null;

        if (l.domain && l.domain.startsWith('http')) {
            const isFb   = l.domain.includes('facebook.com');
            const emails = new Set();
            const phones = new Set();
            let page;
            try {
                if (isFb) {
                    page = await mobileContext.newPage();
                    let fbUrl = l.domain.replace('www.facebook.com', 'mbasic.facebook.com');
                    if (!fbUrl.includes('/groups/') && !fbUrl.includes('/share/') && !fbUrl.includes('/about')) fbUrl = fbUrl.replace(/\/$/, '') + '/about';
                    await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                    extractFromHTML(await page.content(), emails, phones);
                } else {
                    page = await context.newPage();
                    await page.goto(l.domain, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                    extractFromHTML(await page.content(), emails, phones);

                    // Auto-find and visit /contact page for richer contact data
                    try {
                        // Prefer exact href match first, then partial-text anchor
                        const contactHref = await page.evaluate(() => {
                            const anchors = Array.from(document.querySelectorAll('a[href]'));
                            const exact   = anchors.find(a => /\/(contact|contacts|contact-us|contactus)(\/|$|\?)/i.test(a.getAttribute('href')));
                            const loose   = exact || anchors.find(a => /contact/i.test(a.textContent.trim()));
                            return loose ? loose.getAttribute('href') : null;
                        });
                        if (contactHref) {
                            const contactUrl = contactHref.startsWith('http') ? contactHref : new URL(contactHref, l.domain).href;
                            await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                            extractFromHTML(await page.content(), emails, phones);
                        }
                    } catch (_) { /* contact page unreachable ??ignore */ }
                }
            } catch (e) { /* timeout / network error ??continue */ } finally { if (page) await page.close().catch(() => {}); }

            if (emails.size > 0) l.primary_email = Array.from(emails)[0];
            const cleanPhones = Array.from(phones).filter(p => p.length < 20);
            if (cleanPhones.length > 0) l.primary_phone = cleanPhones[0];

            if (l.primary_email || l.primary_phone) console.log(`[step3] Enriched: ${l.company_name} | ${l.primary_email || ''}`);
        }

        if (l.primary_email || l.primary_phone) {
            score += 30;
            if (l.pillar?.includes('LBS')) score += 15;
        } else {
            score = Math.min(score, 85);
        }
        l.confidence_score = Math.min(score, 100);
        enriched.push(l);
    }

    await browser.close();
    fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
    console.log(`[step3] Done ??${enriched.length} enriched leads ??${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
