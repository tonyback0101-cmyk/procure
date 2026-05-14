require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const TAXONOMY_PATH  = 'zhimao_global_taxonomy.json';
const STATE_PATH     = 'zhimao_matrix_state_v8.json';
const GEMINI_KEY     = process.env.GEMINI_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const MIN_SUBCATS    = 5;   // 品类少于此值的行业触发 LLM 扩充

// ── Gemini 品类自动扩充 ──────────────────────────────────────────────────────
async function expandSparseIndustries(taxonomy) {
    if (!GEMINI_KEY) return;
    const sparse = Object.entries(taxonomy.industries)
        .filter(([, d]) => (d.subcategories || []).length < MIN_SUBCATS)
        .slice(0, 3);  // 每轮最多处理 3 个行业，避免阻塞调度
    if (sparse.length === 0) return;

    for (const [industry, data] of sparse) {
        const existing = (data.subcategories || []).join(', ') || 'none';
        const prompt   = `You are a B2B trade expert. For the industry "${industry}", list 8 specific product subcategories that overseas buyers import from China. These should be concrete, searchable product names (not vague categories). Existing subcategories to avoid duplicating: ${existing}. Return ONLY a JSON array of strings, no explanation. Example: ["LED Strip Lights","Solar Panels","Lithium Batteries"]`;
        try {
            const body = await new Promise(resolve => {
                const data = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
                const req  = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
                    let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
                });
                req.on('error', () => resolve(null)); req.write(data); req.end();
            });
            if (!body) continue;
            const newCats = JSON.parse(JSON.parse(body).candidates[0].content.parts[0].text);
            if (!Array.isArray(newCats)) continue;
            let added = 0;
            newCats.forEach(cat => {
                if (cat && !taxonomy.industries[industry].subcategories.includes(cat)) {
                    taxonomy.industries[industry].subcategories.push(cat);
                    added++;
                }
            });
            if (added > 0) console.log(`[V8 Taxonomy] ${industry}: +${added} new subcategories via Gemini`);
        } catch (e) {
            console.warn(`[V8 Taxonomy] Expand failed for "${industry}": ${e.message}`);
        }
    }
    taxonomy.last_updated = new Date().toISOString();
    fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2));
}

/**
 * 全球战场地图 — 9大区域 / 54个国家
 * 设计原则：
 *   - 按地缘分区，每区独立 LRU 游标（防止某区长期饥饿）
 *   - tier 1 = 核心战场（出货量大、B2B生态成熟）
 *   - tier 2 = 战略扩张（快速增长 or 新兴制造业基地）
 *   - tier 3 = 前沿探测（有潜力但信息密度较低）
 */
const REGIONS = [
    {
        code: 'SEA',
        name: 'Southeast Asia',
        countries: [
            { gl: 'sg', name: 'Singapore',   lang: 'English',    tier: 1 },
            { gl: 'my', name: 'Malaysia',     lang: 'Malay',      tier: 1 },
            { gl: 'th', name: 'Thailand',     lang: 'Thai',       tier: 1 },
            { gl: 'vn', name: 'Vietnam',      lang: 'Vietnamese', tier: 1 },
            { gl: 'id', name: 'Indonesia',    lang: 'Indonesian', tier: 1 },
            { gl: 'ph', name: 'Philippines',  lang: 'Filipino',   tier: 2 },
            { gl: 'kh', name: 'Cambodia',     lang: 'Khmer',      tier: 2 },
        ],
    },
    {
        code: 'MENA',
        name: 'Middle East & North Africa',
        countries: [
            { gl: 'ae', name: 'UAE',           lang: 'Arabic',     tier: 1 },
            { gl: 'sa', name: 'Saudi Arabia',  lang: 'Arabic',     tier: 1 },
            { gl: 'qa', name: 'Qatar',         lang: 'Arabic',     tier: 1 },
            { gl: 'kw', name: 'Kuwait',        lang: 'Arabic',     tier: 2 },
            { gl: 'om', name: 'Oman',          lang: 'Arabic',     tier: 2 },
            { gl: 'eg', name: 'Egypt',         lang: 'Arabic',     tier: 2 },
            { gl: 'ma', name: 'Morocco',       lang: 'Arabic',     tier: 2 },
            { gl: 'jo', name: 'Jordan',        lang: 'Arabic',     tier: 3 },
        ],
    },
    {
        code: 'SA',
        name: 'South Asia',
        countries: [
            { gl: 'in', name: 'India',         lang: 'Hindi',      tier: 1 },
            { gl: 'pk', name: 'Pakistan',      lang: 'Urdu',       tier: 2 },
            { gl: 'bd', name: 'Bangladesh',    lang: 'Bengali',    tier: 2 },
            { gl: 'lk', name: 'Sri Lanka',     lang: 'Sinhala',    tier: 3 },
        ],
    },
    {
        code: 'EAP',
        name: 'East Asia & Pacific',
        countries: [
            { gl: 'jp', name: 'Japan',         lang: 'Japanese',   tier: 1 },
            { gl: 'kr', name: 'South Korea',   lang: 'Korean',     tier: 1 },
            { gl: 'au', name: 'Australia',     lang: 'English',    tier: 1 },
            { gl: 'nz', name: 'New Zealand',   lang: 'English',    tier: 2 },
            { gl: 'hk', name: 'Hong Kong',     lang: 'Cantonese',  tier: 2 },
        ],
    },
    {
        code: 'EUW',
        name: 'Europe West',
        countries: [
            { gl: 'de', name: 'Germany',       lang: 'German',     tier: 1 },
            { gl: 'gb', name: 'UK',            lang: 'English',    tier: 1 },
            { gl: 'fr', name: 'France',        lang: 'French',     tier: 1 },
            { gl: 'it', name: 'Italy',         lang: 'Italian',    tier: 1 },
            { gl: 'nl', name: 'Netherlands',   lang: 'Dutch',      tier: 1 },
            { gl: 'es', name: 'Spain',         lang: 'Spanish',    tier: 1 },
            { gl: 'be', name: 'Belgium',       lang: 'French',     tier: 2 },
            { gl: 'pt', name: 'Portugal',      lang: 'Portuguese', tier: 2 },
            { gl: 'se', name: 'Sweden',        lang: 'Swedish',    tier: 2 },
            { gl: 'dk', name: 'Denmark',       lang: 'Danish',     tier: 2 },
            { gl: 'at', name: 'Austria',       lang: 'German',     tier: 2 },
            { gl: 'ch', name: 'Switzerland',   lang: 'German',     tier: 2 },
        ],
    },
    {
        code: 'EUE',
        name: 'Europe East & Turkey',
        countries: [
            { gl: 'tr', name: 'Turkey',        lang: 'Turkish',    tier: 1 },
            { gl: 'pl', name: 'Poland',        lang: 'Polish',     tier: 2 },
            { gl: 'cz', name: 'Czech Republic',lang: 'Czech',      tier: 2 },
            { gl: 'ro', name: 'Romania',       lang: 'Romanian',   tier: 2 },
            { gl: 'hu', name: 'Hungary',       lang: 'Hungarian',  tier: 2 },
            { gl: 'gr', name: 'Greece',        lang: 'Greek',      tier: 2 },
            { gl: 'ua', name: 'Ukraine',       lang: 'Ukrainian',  tier: 3 },
        ],
    },
    {
        code: 'LATAM',
        name: 'Latin America',
        countries: [
            { gl: 'mx', name: 'Mexico',        lang: 'Spanish',    tier: 1 },
            { gl: 'br', name: 'Brazil',        lang: 'Portuguese', tier: 1 },
            { gl: 'co', name: 'Colombia',      lang: 'Spanish',    tier: 1 },
            { gl: 'cl', name: 'Chile',         lang: 'Spanish',    tier: 2 },
            { gl: 'ar', name: 'Argentina',     lang: 'Spanish',    tier: 2 },
            { gl: 'pe', name: 'Peru',          lang: 'Spanish',    tier: 2 },
            { gl: 'ec', name: 'Ecuador',       lang: 'Spanish',    tier: 3 },
            { gl: 'pa', name: 'Panama',        lang: 'Spanish',    tier: 3 },
        ],
    },
    {
        code: 'NA',
        name: 'North America',
        countries: [
            { gl: 'us', name: 'United States', lang: 'English',    tier: 1 },
            { gl: 'ca', name: 'Canada',        lang: 'English',    tier: 1 },
        ],
    },
    {
        code: 'AF',
        name: 'Africa',
        countries: [
            { gl: 'ng', name: 'Nigeria',       lang: 'English',    tier: 2 },
            { gl: 'za', name: 'South Africa',  lang: 'English',    tier: 2 },
            { gl: 'ke', name: 'Kenya',         lang: 'Swahili',    tier: 2 },
            { gl: 'gh', name: 'Ghana',         lang: 'English',    tier: 3 },
            { gl: 'et', name: 'Ethiopia',      lang: 'Amharic',    tier: 3 },
        ],
    },
];

// 大型市场城市下钻（可选）
const GEO_CITIES = {
    us: ['Texas', 'Florida', 'California', 'New York', 'Illinois', 'Ohio', 'Pennsylvania', 'Georgia'],
    de: ['Munich', 'Hamburg', 'Frankfurt', 'Berlin', 'Dusseldorf', 'Stuttgart'],
    br: ['Sao Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Porto Alegre'],
    in: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Hyderabad', 'Pune'],
    jp: ['Tokyo', 'Osaka', 'Nagoya', 'Yokohama', 'Fukuoka'],
    kr: ['Seoul', 'Busan', 'Incheon', 'Daegu'],
    au: ['Sydney', 'Melbourne', 'Brisbane', 'Perth'],
};

function buildTaskPool(taxonomy, state) {
    const tasks = [];
    for (const region of REGIONS) {
        for (const country of region.countries) {
            // Tier 3 国家降低权重：给 state 注入一个虚拟的"近期扫过"时间，使其后于 tier1/2 被选中
            const tierPenaltyMs = (country.tier - 1) * 7 * 24 * 60 * 60 * 1000; // tier1=0, tier2=7天, tier3=14天

            for (const [, industryData] of Object.entries(taxonomy.industries)) {
                const cats = Array.isArray(industryData.subcategories) && industryData.subcategories.length > 0
                    ? industryData.subcategories
                    : [industryData.name];

                for (const category of cats) {
                    const taskKey  = `${category}|${country.gl}`;
                    const rawSwept = state[taskKey] ? new Date(state[taskKey].last_swept).getTime() : 0;
                    // 用 tierPenalty 偏置：tier2/3 即使是"从未扫过"，也排在 tier1 完整扫完之后
                    const lastSwept = rawSwept > 0 ? rawSwept : tierPenaltyMs;
                    tasks.push({ category, country, region: region.code, lastSwept, taskKey });
                }
            }
        }
    }
    // LRU：最久未扫的排最前
    tasks.sort((a, b) => a.lastSwept - b.lastSwept);
    return tasks;
}

async function run() {
    console.log(`\n======================================================`);
    console.log(`[V8 CRON WORKER] 9区域 / 54国 全球轮转调度器`);
    console.log(`======================================================`);

    if (!fs.existsSync(TAXONOMY_PATH)) {
        console.error('[V8 Cron Worker] Taxonomy missing! Cannot proceed.');
        return;
    }
    const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    const state    = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};

    // Gemini 驱动品类自动扩充（异步，优先填充稀疏行业）
    await expandSparseIndustries(taxonomy);
    // 扩充后重新加载（expandSparseIndustries 已写盘）
    const freshTaxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));

    const tasks = buildTaskPool(freshTaxonomy, state);
    if (tasks.length === 0) {
        console.log('[V8 Cron Worker] No tasks generated.');
        return;
    }

    const next = tasks[0];
    const sweepCount = state[next.taskKey]?.sweep_count || 0;
    console.log(`>>> 选中任务: [${next.category}] @ [${next.country.name} (${next.country.gl})] [区域: ${next.region}] [Tier ${next.country.tier}]`);
    console.log(`    上次扫描: ${sweepCount === 0 ? '从未' : new Date(state[next.taskKey].last_swept).toISOString()}  累计: ${sweepCount} 次`);

    // sweepCount 传给 Step1，让同一网格每次 cron 运行都取不同翻页（深度挖掘）
    const nextSweep = (sweepCount % 5) + 1; // 1-5 循环，取 Serper 第 1-5 页
    try {
        execSync(
            `node zhimao_v8_ultimate_master.js ${next.country.gl} "${next.category}"`,
            { stdio: 'inherit', env: { ...process.env, SWEEP_COUNT: String(nextSweep) } }
        );
        // 成功后写入状态
        state[next.taskKey] = {
            last_swept:  new Date().toISOString(),
            sweep_count: sweepCount + 1,
            country_name: next.country.name,
            region:       next.region,
            tier:         next.country.tier,
        };
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        console.log(`\n[V8 Cron Worker] 任务完成.`);
    } catch (e) {
        console.error(`\n[V8 Cron Worker] 任务失败: ${e.message}`);
    }
}

run().catch(e => { console.error('[V8 Cron Worker] Fatal:', e.message); process.exit(1); });
