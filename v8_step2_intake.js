require('dotenv').config();
const fs = require('fs');
const { pMap, callGeminiJson, preFilterRawLeads } = require('./v8_lib_concurrency');
const { isJunkName } = require('./v8_quality_gate');

const [inputFile, outputFile] = process.argv.slice(2);

const GEMINI_KEY = process.env.GEMINI_KEY;
// Step2 ??????????????????? ? Flash-Lite?? 5-10x?????
const GEMINI_MODEL      = process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_KEY        = process.env.OPENAI_API_KEY || '';
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';
if (!GEMINI_KEY) { console.error('[step2] GEMINI_KEY env var is required'); process.exit(1); }

const BATCH_SIZE    = parseInt(process.env.INTAKE_BATCH_SIZE || '50', 10);
const LLM_CONCURRENCY = Math.max(1, parseInt(process.env.INTAKE_LLM_CONCURRENCY || '3', 10));

// ?? Industry knowledge injection (unchanged) ??????????????????????????????
function loadKnowledge() {
    try {
        if (fs.existsSync('zhimao_supply_chain_economics.json'))
            return JSON.parse(fs.readFileSync('zhimao_supply_chain_economics.json', 'utf8')).industries || {};
    } catch (_) {}
    return {};
}
function getIndustryContext(knowledge, pillarSample) {
    if (!pillarSample) return null;
    for (const [name, data] of Object.entries(knowledge)) {
        if (pillarSample.toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase()))
            return { name, ...data };
    }
    return null;
}

async function run() {
    const rawAll = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (rawAll.length === 0) { fs.writeFileSync(outputFile, '[]'); return; }

    // ?? P0: ??????????? 30-50% Gemini ???????????????????????????
    const { kept, dropped, reasons } = preFilterRawLeads(rawAll);
    if (dropped > 0)
        console.log(`[step2] Pre-filter: dropped ${dropped} (listicle=${reasons.listicle}, platform=${reasons.platform}, cn_supplier=${reasons.cn_supplier}, no_signal=${reasons.no_signal})`);

    const raw = kept;
    console.log(`[step2] Gemini strict entity extraction ? ${raw.length} items in batches of ${BATCH_SIZE} (concurrency=${LLM_CONCURRENCY})...`);

    // Industry context for buyer/seller classification
    const knowledge    = loadKnowledge();
    const samplePillar = raw.find(r => r.pillar)?.pillar || '';
    const industryCtx  = getIndustryContext(knowledge, samplePillar);
    const triggerBlock = industryCtx?.make_vs_buy_triggers
        ? `\nINDUSTRY CONTEXT (${industryCtx.name}):
- BUY signals (these companies ARE buyers/importers ? accept): ${industryCtx.make_vs_buy_triggers.buy_signals.join(', ')}
- MAKE signals (these are manufacturers ? still accept, but note): ${industryCtx.make_vs_buy_triggers.make_signals.join(', ')}`
        : '';
    if (industryCtx) console.log(`[step2] Knowledge injected: ${industryCtx.name}`);

    // Split into batches
    const batches = [];
    for (let i = 0; i < raw.length; i += BATCH_SIZE) batches.push({ idx: Math.floor(i / BATCH_SIZE) + 1, items: raw.slice(i, i + BATCH_SIZE) });

    const intakeData = [];

    await pMap(batches, async ({ idx, items }) => {
        const prompt = `Extract exact formal Company Name from each item.
[CRITICAL RULES]
1. ANTI-POLLUTION: If the snippet indicates the company is based in China, or is a Chinese exporter/supplier selling abroad, YOU MUST return null.
2. ANTI-BLOG: If the title/snippet is a listicle, article, review, or guide (e.g. "Top 10 ...", "Best ... for ...", "How to ...", "Guide to ...", "X things you should ...", "Review:", "vs."), YOU MUST return null ? we only want real buyer company entities.
3. ANTI-PLATFORM: If the result is a known marketplace, directory platform, or aggregator (Alibaba, Amazon, Thomasnet, etc.) rather than an end-buyer company, return null.${triggerBlock}
Format: {"results": [{"company_name": "Exact Name or null"}]}
Input: ${JSON.stringify(items.map(r => ({ t: r.title, s: r.snippet })))}`;

        try {
            const content = await callGeminiJson(prompt, {
                apiKey:    GEMINI_KEY,
                model:     GEMINI_MODEL,
                openaiApiKey: OPENAI_KEY,
                openaiModel:  OPENAI_FAST_MODEL,
                label:     `step2-batch-${idx}`,
            });
            const results = content.results || [];
            let accepted = 0;
            items.forEach((r, i) => {
                const name = results[i]?.company_name;
                if (name && name !== 'null' && !isJunkName(name)) {
                    intakeData.push({
                        company_name: name,
                        domain:       r.link,
                        snippet:      r.snippet,
                        phone:        r.phone,
                        pillar:       r.pillar,
                        intent_signal: r.intent_signal,
                        source_timestamp: r.source_timestamp,
                        country:      r.country,
                    });
                    accepted++;
                }
            });
            console.log(`[step2] Batch ${idx}: ${accepted} accepted`);
        } catch (e) {
            console.warn(`[step2] Batch ${idx} failed: ${e.message}`);
        }
    }, { concurrency: LLM_CONCURRENCY });

    fs.writeFileSync(outputFile, JSON.stringify(intakeData, null, 2));
    console.log(`[step2] Done ? ${intakeData.length} valid entities ? ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
