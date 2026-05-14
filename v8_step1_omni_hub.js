require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const { isJunkDomain } = require('./v8_quality_gate');

const [inputFile, outputFile, countryCode] = process.argv.slice(2);

const API_KEY = process.env.SERPER_API_KEY;
if (!API_KEY) { console.error('[step1] SERPER_API_KEY env var is required'); process.exit(1); }

// Deep paging: sweep N → page N (results 1-20, 21-40, … 81-100)
// Same [category × country] grid mines new data each cron run
const SWEEP_COUNT = Math.max(1, parseInt(process.env.SWEEP_COUNT || '1', 10));
const SEARCH_PAGE = SWEEP_COUNT;

function isJunkLead(lead) {
    if (!lead || !lead.link) return false;
    try { return isJunkDomain(lead.link); } catch (_) {}
    return false;
}

async function fetchPlaces(query, gl) {
    return new Promise(resolve => {
        const req = https.request({ hostname: 'google.serper.dev', path: '/places', method: 'POST', headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' } }, r => {
            let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(JSON.parse(body || '{}').places || []));
        });
        req.on('error', () => resolve([])); req.write(JSON.stringify({ q: query, gl })); req.end();
    });
}

async function searchOrganic(query, gl, num = 20, page = SEARCH_PAGE) {
    return new Promise(resolve => {
        const req = https.request({ hostname: 'google.serper.dev', path: '/search', method: 'POST', headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' } }, r => {
            let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(JSON.parse(body || '{}').organic || []));
        });
        req.on('error', () => resolve([])); req.write(JSON.stringify({ q: query, gl, num, page })); req.end();
    });
}

async function run() {
    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { baseQuery, countryName, category, tld } = data;
    const allLeads = [];
    const currentYear = new Date().getFullYear();

    // Pillar 0: Seed DB Activation
    console.log(`[step1] Pillar 0: Seed DB Activation...`);
    try {
        if (fs.existsSync('zhimao_seed_intelligence.json')) {
            const seeds = JSON.parse(fs.readFileSync('zhimao_seed_intelligence.json', 'utf8'));
            const matched = seeds.filter(s => s.country?.toLowerCase() === countryCode?.toLowerCase() && s.category?.toLowerCase().includes(category.toLowerCase()));
            matched.forEach(s => allLeads.push({ title: s.company_name, link: s.domain, snippet: 'Seed DB Verified Buyer', pillar: 'Pillar 0 Seed' }));
            console.log(`[step1] Activated ${matched.length} seed entities.`);
        }
    } catch (e) { console.log(`[step1] Seed DB unavailable, skipping.`); }

    // Pillar 1: LBS Maps
    console.log(`[step1] Pillar 1: LBS Maps...`);
    const places = await fetchPlaces(`${category} wholesaler OR distributor in ${countryName}`, countryCode);
    places.forEach(p => { if (p.website || p.phoneNumber) allLeads.push({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS' }); });

    // Pillar 2: Local B2B Directory
    console.log(`[step1] Pillar 2: Local B2B Directory...`);
    const b2b = await searchOrganic(`"${category}" ("b2b" OR "directory" OR "suppliers" OR "manufacturers") ${tld} -site:alibaba.com -site:globalsources.com -site:made-in-china.com`, countryCode);
    b2b.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 2 Local B2B' }));

    // Pillar 3: Customs / Import Trade Records
    // Strategy: query public import-data aggregators (ImportYeti, Volza, Panjiva public pages)
    // and generic BoL-signal searches. All three paths degrade gracefully on 0 results.
    console.log(`[step1] Pillar 3: Customs / Import Trade Records...`);
    try {
        // Path A: ImportYeti — free public importer profiles
        const importyeti = await searchOrganic(
            `site:importyeti.com "${category}" "${countryName}"`,
            countryCode
        );
        importyeti.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/ImportYeti',
        }));

        // Path B: Volza / Panjiva public pages
        const volza = await searchOrganic(
            `(site:volza.com OR site:panjiva.com) "${category}" importer "${countryName}"`,
            countryCode
        );
        volza.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/Volza',
        }));

        // Path C: Generic BoL / customs declaration signal
        const bol = await searchOrganic(
            `"${category}" ("bill of lading" OR "customs importer" OR "import record" OR "HS code") "${countryName}" -site:alibaba.com`,
            countryCode
        );
        bol.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/BoL',
        }));

        const p3count = importyeti.length + volza.length + bol.length;
        console.log(`[step1] Pillar 3: ${p3count} customs/trade signals found${p3count === 0 ? ' (no public records for this query — skipping gracefully)' : ''}.`);
    } catch (e) {
        console.warn(`[step1] Pillar 3 failed (non-fatal): ${e.message}`);
    }

    // Pillar 4: Deep Social — 5路并发意图词探针
    console.log(`[step1] Pillar 4: Deep Social Penetration...`);
    const [socialGeneral, socialFbGroups, socialLinkedIn, socialWhatsApp, socialThreads] = await Promise.all([
        // ① 通用公司主页（保留原逻辑）
        searchOrganic(`${baseQuery} "${countryName}" site:linkedin.com/company OR site:facebook.com/groups`, countryCode),
        // ② Facebook Groups 主动采购意图
        searchOrganic(`"${category}" ("need supplier" OR "sourcing" OR "looking for supplier" OR "buying" OR "RFQ") site:facebook.com/groups "${countryName}"`, countryCode),
        // ③ LinkedIn 采购个人/企业
        searchOrganic(`"${category}" ("procurement manager" OR "sourcing manager" OR "purchasing" OR "import") site:linkedin.com/in "${countryName}"`, countryCode),
        // ④ WhatsApp 商业群/联系
        searchOrganic(`"${category}" ("whatsapp group" OR "wa.me" OR "whatsapp business") "${countryName}" buyer OR importer`, countryCode),
        // ⑤ Threads/Instagram 采购意图
        searchOrganic(`"${category}" ("looking for supplier" OR "where to buy" OR "need" OR "sourcing") "${countryName}" (site:threads.net OR site:instagram.com)`, countryCode),
    ]);
    socialGeneral.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social General' }));
    socialFbGroups.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social FB-Intent', intent_signal: 'ACTIVE_SOURCING' }));
    socialLinkedIn.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social LinkedIn-Intent', intent_signal: 'PROCUREMENT_ROLE' }));
    socialWhatsApp.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social WhatsApp', intent_signal: 'WHATSAPP_CONTACT' }));
    socialThreads.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social Threads', intent_signal: 'ACTIVE_SOURCING' }));
    console.log(`[step1] Pillar 4 total: ${socialGeneral.length + socialFbGroups.length + socialLinkedIn.length + socialWhatsApp.length + socialThreads.length} signals`);

    // Pillar 5a: Tenders & Procurement（政府招标）
    console.log(`[step1] Pillar 5a: Tenders & Procurement...`);
    const tenders = await searchOrganic(`"${category}" (tender OR RFP OR "request for proposal" OR procurement) ${tld} OR site:.gov.${countryCode}`, countryCode);
    tenders.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 5a Tenders', intent_signal: 'TENDER_ISSUER' }));

    // Pillar 5b: Compliance Registries（认证申请库 — 正在生产/采购的前端信号）
    // 申请 FCC/TUV/CE/UL 认证 = 确认该公司正在制造或采购该品类产品
    console.log(`[step1] Pillar 5b: Compliance Registries...`);
    try {
        const compliance = await searchOrganic(
            `"${category}" ("Applicant" OR "Grantee" OR "certificate holder" OR "registered manufacturer") (site:fccid.io OR site:tuv.com OR site:ul.com OR site:ce-check.eu OR site:intertek.com)`,
            countryCode
        );
        compliance.forEach(o => allLeads.push({
            title:         o.title,
            link:          o.link,
            snippet:       o.snippet,
            pillar:        'Pillar 5b Compliance',
            intent_signal: 'COMPLIANCE_REGISTRANT',
        }));
        console.log(`[step1] Pillar 5b: ${compliance.length} compliance signals found.`);
    } catch (e) {
        console.warn(`[step1] Pillar 5b failed (non-fatal): ${e.message}`);
    }

    // Pillar 6: Exhibitions
    console.log(`[step1] Pillar 6: Exhibitions...`);
    const exhibitions = await searchOrganic(`"${category}" ("exhibitor list" OR "exhibitors directory") ${currentYear} "${countryName}"`, countryCode);
    exhibitions.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 6 Exhibitions' }));

    // 统一注入 source_timestamp，供 Step5 时间衰减使用
    const nowIso = new Date().toISOString();
    allLeads.forEach(l => { l.source_timestamp = l.source_timestamp || nowIso; });

    // P0 垃圾域名过滤（与 zhimao JUNK_DOMAIN_HOSTS 单源同步）
    const beforeFilter = allLeads.length;
    const filtered = allLeads.filter(l => !isJunkLead(l));
    if (beforeFilter - filtered.length > 0)
        console.log(`[step1] Junk filter: dropped ${beforeFilter - filtered.length} leads (wiki/social/marketplace noise)`);

    fs.writeFileSync(outputFile, JSON.stringify(filtered, null, 2));
    console.log(`[step1] Done — ${filtered.length} raw leads written → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
