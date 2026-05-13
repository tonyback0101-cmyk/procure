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

// Load knowledge base for bom_components anchor
function loadKnowledgeForStep3() {
    try {
        if (fs.existsSync('zhimao_supply_chain_economics.json')) {
            return JSON.parse(fs.readFileSync('zhimao_supply_chain_economics.json', 'utf8')).industries || {};
        }
    } catch (_) {}
    return {};
}

function findBomAnchor(knowledge, leads) {
    // Infer industry from pillar tags or company snippets
    const pillarText = leads.map(l => l.pillar || '').join(' ');
    for (const [name, data] of Object.entries(knowledge)) {
        if (pillarText.toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase())) {
            return { name, bom: data.bom_components || [] };
        }
    }
    return null;
}

async function inferBOMGraph(leads) {
    if (leads.length === 0) return leads;
    console.log(`[step3] BOM deduction for ${leads.length} entities in batches of ${BOM_BATCH_SIZE}...`);

    const knowledge  = loadKnowledgeForStep3();
    const bomAnchor  = findBomAnchor(knowledge, leads);
    const anchorHint = bomAnchor?.bom.length
        ? `\nINDUSTRY BOM ANCHOR (${bomAnchor.name}): Known upstream components for this industry: ${bomAnchor.bom.join(', ')}. Use these as the primary candidates when deducing BOM; add others only if clearly warranted.`
        : '';
    if (bomAnchor) console.log(`[step3] BOM anchor loaded: ${bomAnchor.name} (${bomAnchor.bom.length} components)`);

    for (let i = 0; i < leads.length; i += BOM_BATCH_SIZE) {
        const batch  = leads.slice(i, i + BOM_BATCH_SIZE);
        const prompt = `As a Supply Chain Analyst, analyze these companies based on their name and snippet.
1. Determine entity_role: "Manufacturer", "Wholesaler", "Retailer", or "Service".
2. If Manufacturer/Assembler, deduce 3-5 upstream raw materials/components they procure (BOM). If Retailer/Wholesaler, deduce finished goods they procure.${anchorHint}
Format: {"results": [{"name": "Exact Name", "role": "...", "pre_procurement_bom": ["item1", "item2"]}]}
Input: ${JSON.stringify(batch.map(l => ({ name: l.company_name, snip: l.snippet })))}`;

        try {
            const resData = await callGemini(prompt);
            const bomData = JSON.parse(JSON.parse(resData).candidates[0].content.parts[0].text).results;
            bomData.forEach(bom => {
                const lead = batch.find(l => l.company_name === bom.name);
                if (lead) {
                    lead.entity_role  = bom.role;
                    lead.inferred_bom = bom.pre_procurement_bom;
                    if (bom.role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
                }
            });
            console.log(`[step3] BOM batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} done`);
        } catch (e) {
            console.warn(`[step3] BOM batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} failed: ${e.message}`);
        }
    }
    return leads;
}

// ?? Email cleaner: strip fake/exhibition/platform addresses ?????????????????
const EMAIL_DOMAIN_BLACKLIST = new Set([
    // Exhibition organizers
    'messefrankfurt.com','cantonfair.org.cn','globalsources.com','alibaba.com',
    'amazon.com','aliexpress.com','made-in-china.com','thomasnet.com',
    'indiamart.com','tradefair.com','messe.de','koelnmesse.de','reed.co.uk',
    // Generic invalid
    'example.com','test.com','domain.com','email.com','mail.com','tempmail.com',
]);
const EMAIL_ROLE_PREFIXES = new Set([
    'noreply','no-reply','donotreply','do-not-reply','webmaster','postmaster',
    'mailer-daemon','bounce','unsubscribe','admin','support','info',
]);

function cleanEmail(raw) {
    if (!raw) return null;
    const em = raw.toLowerCase().trim();
    if (!em.includes('@')) return null;
    const [local, domain] = em.split('@');
    if (!domain) return null;
    // Reject image/asset false positives
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|css|js)$/i.test(em)) return null;
    // Reject blacklisted domains
    if (EMAIL_DOMAIN_BLACKLIST.has(domain)) {
        console.log(`[step3] ? Stripped exhibition/platform email: ${em}`);
        return null;
    }
    // Reject role-based addresses that are never real contacts
    const prefix = local.split('+')[0].split('.')[0];
    if (EMAIL_ROLE_PREFIXES.has(prefix)) return null;
    return em;
}

const extractFromHTML = (html, emails, phones) => {
    const $ = cheerio.load(html);
    $('a[href^="mailto:"]').each((_, el) => {
        const raw = $(el).attr('href').replace('mailto:', '').split('?')[0].trim();
        const clean = cleanEmail(raw);
        if (clean) emails.add(clean);
    });
    $('a[href^="tel:"]').each((_, el) => phones.add($(el).attr('href').replace('tel:', '').trim()));
    $('a[href*="wa.me/"]').each((_, el) => phones.add($(el).attr('href')));
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g;
    let match;
    while ((match = emailRegex.exec($('body').text())) !== null) {
        const clean = cleanEmail(match[1]);
        if (clean) emails.add(clean);
    }
};

async function run() {
    let leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    leads = await inferBOMGraph(leads);

    const launchOptions = { headless: true };
    if (USE_PROXY) {
        if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
        console.log(`[step3] Proxy enabled: ${BRD_PROXY}`);
        launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
    }

    const browser        = await chromium.launch(launchOptions);
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

        // ── final_intent_score: confidence_score + intent/pillar quality bonuses ──
        let intentScore = l.confidence_score;
        // Intent signal boosts (set by Step 1 Pillar 4/5 probes)
        if      (l.intent_signal === 'ACTIVE_SOURCING')       intentScore += 10;
        else if (l.intent_signal === 'PROCUREMENT_ROLE')      intentScore += 8;
        else if (l.intent_signal === 'WHATSAPP_CONTACT')      intentScore += 7;
        else if (l.intent_signal === 'COMPLIANCE_REGISTRANT') intentScore += 5;
        // High-trust pillar bonus
        if (l.pillar?.includes('Customs') || l.pillar?.includes('B2B'))  intentScore += 5;
        // Rich BOM deduction indicates verified manufacturer
        if (Array.isArray(l.inferred_bom) && l.inferred_bom.length >= 3) intentScore += 5;
        l.final_intent_score = Math.min(intentScore, 100);

        enriched.push(l);
    }

    await browser.close();
    fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
    console.log(`[step3] Done ??${enriched.length} enriched leads ??${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
