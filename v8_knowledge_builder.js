/**
 * v8_knowledge_builder.js — 行业知识库自动补全引擎
 *
 * 运行逻辑：
 *   1. 读 zhimao_global_taxonomy.json → 展开所有 [industry] 条目
 *   2. 读 zhimao_supply_chain_economics.json → 找出哪些行业尚无知识
 *   3. 对每个缺口调用 Gemini，生成标准 JSON 知识结构，增量写盘
 *   4. 同步更新 zhimao_l3_coefficients_v2.json（精确 baseline_intensity）
 *
 * 幂等：已存在的行业跳过，只填补缺口
 * 用法：node v8_knowledge_builder.js [--force]
 *        --force  重新生成所有行业（覆盖现有条目）
 */

require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const TAXONOMY_PATH   = 'zhimao_global_taxonomy.json';
const ECONOMICS_PATH  = 'zhimao_supply_chain_economics.json';
const COEFF_PATH      = 'zhimao_l3_coefficients_v2.json';
const GEMINI_KEY      = process.env.GEMINI_KEY;
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const FORCE           = process.argv.includes('--force');
const DELAY_MS        = parseInt(process.env.BUILDER_DELAY_MS || '2000', 10);

if (!GEMINI_KEY) { console.error('[builder] GEMINI_KEY is required'); process.exit(1); }

// ── NAICS3 mapping for coefficient table ────────────────────────────────────
const NAICS3_MAP = {
    'Consumer Electronics':  '334',
    'Industrial Machinery':  '333',
    'Automotive Parts':      '336',
    'Medical & Health':      '339',
    'Building Materials':    '327',
    'Home Appliances':       '335',
    'Apparel & Textiles':    '315',
    'Renewable Energy':      '335',
    'Agriculture & Food':    '311',
    'Chemicals':             '325',
};

// ── Gemini helper (with retry for 503/429) ──────────────────────────────────
const GEMINI_RETRIES  = 4;
const GEMINI_RETRY_MS = 8000;

async function callGemini(prompt, attempt = 1) {
    const reqData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    });
    const raw = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path:     `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json' },
        }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(reqData);
        req.end();
    });

    // Retry on transient server errors (503 overload, 429 rate limit)
    if ((raw.status === 503 || raw.status === 429) && attempt <= GEMINI_RETRIES) {
        const wait = GEMINI_RETRY_MS * attempt;
        console.log(`[builder]   ↻ HTTP ${raw.status}, retry ${attempt}/${GEMINI_RETRIES} in ${wait}ms...`);
        await sleep(wait);
        return callGemini(prompt, attempt + 1);
    }

    const parsed = JSON.parse(raw.body);
    if (!parsed.candidates) {
        throw new Error(`Gemini error: ${JSON.stringify(parsed.error || raw.body.slice(0, 200))}`);
    }
    return JSON.parse(parsed.candidates[0].content.parts[0].text);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Build prompt for one industry ────────────────────────────────────────────
function buildPrompt(industryName, subcategories) {
    return `You are a supply chain economist. Generate a detailed industry knowledge entry for:
Industry: "${industryName}"
Subcategories: ${JSON.stringify(subcategories)}

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "name": "<industry display name in Chinese>",
  "bom_components": ["<5-8 upstream components/materials this industry typically procures>"],
  "cost_structure": {
    "<cost_bucket_1>": <0.0-1.0 fraction>,
    "<cost_bucket_2>": <fraction>,
    "<cost_bucket_3>": <fraction>,
    "<cost_bucket_4>": <fraction>
  },
  "make_vs_buy_triggers": {
    "buy_signals": ["<6-10 keywords/phrases indicating this company is a buyer/importer>"],
    "make_signals": ["<4-6 keywords indicating this company is a manufacturer>"]
  },
  "budget_calculation": {
    "revenue_per_employee_usd": <integer, industry benchmark annual revenue per employee in USD>,
    "procurement_ratio_of_revenue": <0.0-1.0, fraction of revenue spent on procurement>,
    "traffic_to_revenue_multiplier": <integer, estimated annual revenue USD per monthly website visitor>
  },
  "intent_modifiers": {
    "<event_signal_1>": <integer score boost 10-30>,
    "<event_signal_2>": <integer score boost>,
    "<event_signal_3>": <integer score boost>
  }
}

Rules:
- cost_structure values must sum to 1.0
- bom_components should be specific (e.g. "lithium_18650_cell" not "battery")
- buy_signals should reflect real procurement buyer language (importer, distributor, wholesaler etc.)
- make_signals should reflect manufacturing keywords
- intent_modifiers should capture real business events that signal imminent procurement need`;
}

// ── Update coefficients file ─────────────────────────────────────────────────
function updateCoefficients(industryName, knowledge, subcategories) {
    let coeffData = { coefficient_v2: [] };
    if (fs.existsSync(COEFF_PATH)) {
        coeffData = JSON.parse(fs.readFileSync(COEFF_PATH, 'utf8'));
    }

    const naics3    = NAICS3_MAP[industryName] || '';
    const baseRatio = knowledge.budget_calculation?.procurement_ratio_of_revenue || 0.3;

    // Remove stale entries for this naics3 (we'll re-add fresh ones)
    if (FORCE) {
        coeffData.coefficient_v2 = coeffData.coefficient_v2.filter(
            c => c.industry_naics3 !== naics3 || c.source === 'global_default' || c.source === 'category_default'
        );
    }

    const existingKeys = new Set(
        coeffData.coefficient_v2.map(c => `${c.industry_naics3}|${c.category}`)
    );

    // Add per-subcategory precise entries
    for (const sub of subcategories) {
        const key = `${naics3}|${sub}`;
        if (!existingKeys.has(key)) {
            coeffData.coefficient_v2.push({
                industry_naics3: naics3,
                category:        sub,
                metric_name:     'baseline_intensity',
                value:           Math.min(0.95, Math.round((baseRatio + 0.1) * 100) / 100),
                unit:            'ratio',
                source:          'exact_match',
                version:         'coefficient_v2',
                source_of_truth: 'gemini_generated',
                industry:        industryName,
            });
        }
    }

    // Add industry-level default
    const industryDefaultKey = `${naics3}|*`;
    if (!existingKeys.has(industryDefaultKey)) {
        coeffData.coefficient_v2.push({
            industry_naics3: naics3,
            category:        '*',
            metric_name:     'baseline_intensity',
            value:           Math.round(baseRatio * 100) / 100,
            unit:            'ratio',
            source:          'industry_default',
            version:         'coefficient_v2',
            source_of_truth: 'gemini_generated',
            industry:        industryName,
        });
    }

    fs.writeFileSync(COEFF_PATH, JSON.stringify(coeffData, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`  V8 Knowledge Builder — ${FORCE ? 'FORCE REBUILD' : 'Incremental Fill'}`);
    console.log(`  Model: ${GEMINI_MODEL}`);
    console.log(`═══════════════════════════════════════════════════\n`);

    const taxonomy  = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    const industries = Object.entries(taxonomy.industries);

    // Load existing economics
    let economics = { version: '4.0', description: 'Auto-generated by v8_knowledge_builder.js', industries: {} };
    if (fs.existsSync(ECONOMICS_PATH)) {
        const existing = JSON.parse(fs.readFileSync(ECONOMICS_PATH, 'utf8'));
        // Normalise: merge old keys (snake_case V7 keys) into fresh structure
        economics.industries = existing.industries || {};
    }

    const total   = industries.length;
    let built     = 0;
    let skipped   = 0;
    let failed    = 0;

    for (const [industryName, industryData] of industries) {
        const subcategories = Array.isArray(industryData.subcategories)
            ? industryData.subcategories
            : typeof industryData.subcategories === 'string'
                ? industryData.subcategories.split(' ').filter(Boolean)
                : [industryName];

        const alreadyExists = !FORCE && (industryName in economics.industries);

        if (alreadyExists) {
            console.log(`[builder] ⏭  SKIP  ${industryName} (already exists)`);
            skipped++;
            continue;
        }

        console.log(`[builder] ⚙  BUILD  ${industryName} (${subcategories.length} subcategories)...`);

        try {
            const knowledge = await callGemini(buildPrompt(industryName, subcategories));
            economics.industries[industryName] = {
                ...knowledge,
                _meta: {
                    generated_at:  new Date().toISOString(),
                    model:         GEMINI_MODEL,
                    subcategories: subcategories,
                },
            };

            // Write economics incrementally (safe on interrupt)
            fs.writeFileSync(ECONOMICS_PATH, JSON.stringify(economics, null, 2));

            // Update coefficients
            updateCoefficients(industryName, knowledge, subcategories);

            built++;
            console.log(`[builder] ✓  DONE   ${industryName} | BOM: ${knowledge.bom_components?.length} items | procurement_ratio: ${knowledge.budget_calculation?.procurement_ratio_of_revenue}`);
        } catch (e) {
            console.error(`[builder] ✗  FAIL   ${industryName}: ${e.message}`);
            failed++;
        }

        if (built + failed < total - skipped) {
            await sleep(DELAY_MS);
        }
    }

    // Ensure global fallback entries exist in coefficients
    const coeffData = JSON.parse(fs.readFileSync(COEFF_PATH, 'utf8'));
    const hasGlobal = coeffData.coefficient_v2.some(c => c.source === 'global_default');
    if (!hasGlobal) {
        coeffData.coefficient_v2.push({
            industry_naics3: '', category: '', metric_name: 'baseline_intensity',
            value: 0.1, unit: 'ratio', source: 'global_default', version: 'coefficient_v2',
            source_of_truth: 'global_benchmark',
        });
        fs.writeFileSync(COEFF_PATH, JSON.stringify(coeffData, null, 2));
    }

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`  完成：built=${built}  skipped=${skipped}  failed=${failed}`);
    console.log(`  ${ECONOMICS_PATH} → ${Object.keys(economics.industries).length} 个行业`);
    console.log(`  ${COEFF_PATH}     → ${JSON.parse(fs.readFileSync(COEFF_PATH,'utf8')).coefficient_v2.length} 条系数`);
    console.log(`═══════════════════════════════════════════════════\n`);
}

run().catch(e => { console.error(e); process.exit(1); });
