require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { pMap, callGeminiJson } = require('./v8_lib_concurrency');

const [inputFile, outputFile] = process.argv.slice(2);

// SKIP_L3_INFERENCE=true ? enrichment_queue_worker ?????????????? BOM/L3
const SKIP_L3_INFERENCE = process.env.SKIP_L3_INFERENCE === 'true';

const GEMINI_KEY   = process.env.GEMINI_KEY;
// Step3 L3 ?????????? LLM ?? ? Pro ????
const GEMINI_MODEL = process.env.GEMINI_MODEL      || 'gemini-3.1-pro-preview';
const OPENAI_KEY   = process.env.OPENAI_API_KEY    || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL      || 'gpt-5.5';
if (!GEMINI_KEY) { console.error('[step3] GEMINI_KEY env var is required'); process.exit(1); }

// BrightData proxy
const BRD_USER   = process.env.BRD_USER   || '';
const BRD_PASS   = process.env.BRD_PASS   || '';
const BRD_PROXY  = process.env.BRD_PROXY  || 'http://brd.superproxy.io:22225';
const USE_PROXY  = process.env.USE_PROXY  === 'true';
const USE_BRD_SB = process.env.USE_BRD_SB === 'true';
const BRD_SB_WSS = process.env.BRD_SB_WSS || '';

// Tuning knobs
const PLAYWRIGHT_TIMEOUT  = parseInt(process.env.PLAYWRIGHT_TIMEOUT  || '10000', 10);
const BOM_BATCH_SIZE      = Math.max(1, parseInt(process.env.BOM_BATCH_SIZE       || '10', 10));
const L3_CONCURRENCY      = Math.max(1, parseInt(process.env.L3_CONCURRENCY       || '3',  10));
const L3_TIMEOUT_MS       = Math.max(5000, parseInt(process.env.L3_TIMEOUT_MS     || '30000', 10));
const L3_MAX_RETRIES      = Math.max(0, parseInt(process.env.L3_MAX_RETRIES       || '3', 10));
const PAGE_CONCURRENCY    = Math.max(1, parseInt(process.env.STEP3_PAGE_CONCURRENCY || '8', 10));

// ?? Domain contact cache?30?????????????? Playwright?????????????
const DOMAIN_CACHE_FILE    = 'zhimao_domain_contact_cache.json';
const DOMAIN_CACHE_TTL_DAYS = parseInt(process.env.DOMAIN_CACHE_TTL_DAYS || '30', 10);
let domainContactCache = {};
try {
    if (fs.existsSync(DOMAIN_CACHE_FILE))
        domainContactCache = JSON.parse(fs.readFileSync(DOMAIN_CACHE_FILE, 'utf8'));
} catch (_) {}

function saveDomainCache() {
    try { fs.writeFileSync(DOMAIN_CACHE_FILE, JSON.stringify(domainContactCache, null, 2)); }
    catch (_) {}
}

function getCachedContact(domain) {
    const entry = domainContactCache[domain];
    if (!entry) return null;
    const ageDays = (Date.now() - new Date(entry.ts).getTime()) / 86400000;
    return ageDays <= DOMAIN_CACHE_TTL_DAYS ? entry : null;
}

// ?? Knowledge base ????????????????????????????????????????????????????????
function loadKnowledgeForStep3() {
    try {
        if (fs.existsSync('zhimao_supply_chain_economics.json'))
            return JSON.parse(fs.readFileSync('zhimao_supply_chain_economics.json', 'utf8')).industries || {};
    } catch (_) {}
    return {};
}
function findBomAnchor(knowledge, leads) {
    const pillarText = leads.map(l => l.pillar || '').join(' ');
    for (const [name, data] of Object.entries(knowledge)) {
        if (pillarText.toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase()))
            return { name, bom: data.bom_components || [] };
    }
    return null;
}

// ?? BOM + L3 inference ????????????????????????????????????????????????????
async function inferBOMGraph(leads) {
    if (leads.length === 0 || SKIP_L3_INFERENCE) return leads;
    console.log(`[step3] BOM deduction for ${leads.length} entities in batches of ${BOM_BATCH_SIZE} (L3_CONCURRENCY=${L3_CONCURRENCY})...`);

    const knowledge  = loadKnowledgeForStep3();
    const bomAnchor  = findBomAnchor(knowledge, leads);
    const anchorHint = bomAnchor?.bom.length
        ? `\nINDUSTRY BOM ANCHOR (${bomAnchor.name}): Known upstream components: ${bomAnchor.bom.join(', ')}. Use these as primary candidates.`
        : '';
    if (bomAnchor) console.log(`[step3] BOM anchor loaded: ${bomAnchor.name} (${bomAnchor.bom.length} components)`);

    const batches = [];
    for (let i = 0; i < leads.length; i += BOM_BATCH_SIZE)
        batches.push({ batchIdx: Math.floor(i / BOM_BATCH_SIZE) + 1, items: leads.slice(i, i + BOM_BATCH_SIZE) });

    await pMap(batches, async ({ batchIdx, items }) => {
        const prompt = `As a Supply Chain Analyst, analyze these companies.
1. entity_role: "Manufacturer", "Wholesaler", "Retailer", or "Service".
2. If Manufacturer/Assembler, deduce 3-5 upstream raw materials (BOM). If Retailer/Wholesaler, deduce finished goods they procure.${anchorHint}
3. confidence_tier: "High" (clear evidence of procurement role), "Medium", or "Low".
4. procurement_items: top 3 specific items they likely procure.
Format: {"results": [{"name": "Exact Name", "role": "...", "pre_procurement_bom": [], "confidence_tier": "High|Medium|Low", "procurement_items": []}]}
Input: ${JSON.stringify(items.map(l => ({ name: l.company_name, snip: l.snippet })))}`;

        try {
            const data = await callGeminiJson(prompt, {
                apiKey:      GEMINI_KEY,
                model:       GEMINI_MODEL,
                openaiApiKey: OPENAI_KEY,
                openaiModel:  OPENAI_MODEL,
                timeoutMs:   L3_TIMEOUT_MS,
                maxRetries:  L3_MAX_RETRIES,
                label:       `step3-bom-${batchIdx}`,
            });
            (data.results || []).forEach(bom => {
                const lead = items.find(l => l.company_name === bom.name);
                if (lead) {
                    lead.entity_role  = bom.role;
                    lead.inferred_bom = bom.pre_procurement_bom || [];
                    lead.inference_breakdown = {
                        confidence_tier:   bom.confidence_tier   || 'Medium',
                        procurement_items: bom.procurement_items || [],
                    };
                    if (bom.role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
                }
            });
            console.log(`[step3] BOM batch ${batchIdx} done`);
        } catch (e) {
            console.warn(`[step3] BOM batch ${batchIdx} failed: ${e.message}`);
        }
    }, { concurrency: L3_CONCURRENCY });

    return leads;
}

// ?? Email cleaner ?????????????????????????????????????????????????????????
const EMAIL_DOMAIN_BLACKLIST = new Set([
    'messefrankfurt.com','cantonfair.org.cn','globalsources.com','alibaba.com',
    'amazon.com','aliexpress.com','made-in-china.com','thomasnet.com',
    'indiamart.com','tradefair.com','messe.de','koelnmesse.de','reed.co.uk',
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
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|css|js)$/i.test(em)) return null;
    if (EMAIL_DOMAIN_BLACKLIST.has(domain)) return null;
    const prefix = local.split('+')[0].split('.')[0];
    if (EMAIL_ROLE_PREFIXES.has(prefix)) return null;
    return em;
}

const extractFromHTML = (html, emails, phones) => {
    const $ = cheerio.load(html);
    $('a[href^="mailto:"]').each((_, el) => {
        const clean = cleanEmail($(el).attr('href').replace('mailto:', '').split('?')[0].trim());
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

    // ?? Launch Playwright ?????????????????????????????????????????????????
    let browser;
    if (USE_BRD_SB && BRD_SB_WSS) {
        browser = await chromium.connectOverCDP(BRD_SB_WSS);
        console.log('[step3] Connected to BrightData Scraping Browser');
    } else {
        const launchOptions = { headless: true };
        if (USE_PROXY) {
            if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
            console.log(`[step3] Proxy enabled: ${BRD_PROXY}`);
            launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
        }
        browser = await chromium.launch(launchOptions);
    }

    const context       = await browser.newContext({ ignoreHTTPSErrors: true });
    const mobileContext = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' });

    // ?? Parallel Playwright enrichment ????????????????????????????????????
    const enriched = [];
    await pMap(leads, async (l) => {
        let score = l.confidence_score || 50;
        l.primary_email = l.primary_email || l.email || null;
        l.primary_phone = l.primary_phone || l.phone || null;

        if (l.domain && l.domain.startsWith('http')) {
            // Check domain cache first
            const cached = getCachedContact(l.domain);
            if (cached) {
                if (cached.email) l.primary_email = l.primary_email || cached.email;
                if (cached.phone) l.primary_phone = l.primary_phone || cached.phone;
            } else {
                const isFb   = l.domain.includes('facebook.com');
                const emails = new Set();
                const phones = new Set();
                let page;
                try {
                    if (isFb) {
                        page = await mobileContext.newPage();
                        let fbUrl = l.domain.replace('www.facebook.com', 'mbasic.facebook.com');
                        if (!fbUrl.includes('/groups/') && !fbUrl.includes('/share/') && !fbUrl.includes('/about'))
                            fbUrl = fbUrl.replace(/\/$/, '') + '/about';
                        await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                        extractFromHTML(await page.content(), emails, phones);
                    } else {
                        page = await context.newPage();
                        await page.goto(l.domain, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                        extractFromHTML(await page.content(), emails, phones);
                        // Auto-find /contact page
                        try {
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
                        } catch (_) {}
                    }
                } catch (_) {} finally { if (page) await page.close().catch(() => {}); }

                const email = Array.from(emails)[0] || null;
                const phone = Array.from(phones).filter(p => p.length < 20)[0] || null;
                // Write to cache
                domainContactCache[l.domain] = { email, phone, ts: new Date().toISOString() };

                if (email) l.primary_email = email;
                if (phone) l.primary_phone = phone;
            }

            if (l.primary_email || l.primary_phone)
                console.log(`[step3] Enriched: ${l.company_name} | ${l.primary_email || ''}`);
        }

        if (l.primary_email || l.primary_phone) {
            score += 30;
            if (l.pillar?.includes('LBS')) score += 15;
        } else {
            score = Math.min(score, 85);
        }
        l.confidence_score = Math.min(score, 100);

        // ?? final_intent_score: confidence_score + intent/pillar quality bonuses ??
        let intentScore = l.confidence_score;
        if      (l.intent_signal === 'ACTIVE_SOURCING')       intentScore += 10;
        else if (l.intent_signal === 'PROCUREMENT_ROLE')      intentScore += 8;
        else if (l.intent_signal === 'WHATSAPP_CONTACT')      intentScore += 7;
        else if (l.intent_signal === 'COMPLIANCE_REGISTRANT') intentScore += 5;
        if (l.pillar?.includes('Customs') || l.pillar?.includes('B2B')) intentScore += 5;
        if (Array.isArray(l.inferred_bom) && l.inferred_bom.length >= 3) intentScore += 5;
        // L3 inference_breakdown ????????
        if (l.inference_breakdown?.confidence_tier === 'High') intentScore += 8;
        l.final_intent_score = Math.min(intentScore, 100);

        enriched.push(l);
    }, { concurrency: PAGE_CONCURRENCY });

    await browser.close();
    saveDomainCache();

    fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
    console.log(`[step3] Done ? ${enriched.length} enriched leads ? ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
