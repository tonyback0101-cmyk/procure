require('dotenv').config();
const fs    = require('fs');
const { callGeminiJson } = require('./v8_lib_concurrency');
const { sanitizeDiscoveryCategory } = require('./v8_lib_category_sanitize');

const [inputFile, outputFile, countryCode, ...catArgs] = process.argv.slice(2);
const category = catArgs.join(' ') || 'Industrial';

const GEMINI_KEY   = process.env.GEMINI_KEY    || '';
// Step0 仅做语言翻译和意图词生成，是简单任务 → 用 Flash-Lite（快 5-10x，省 10x 费用）
const GEMINI_MODEL = process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_KEY   = process.env.OPENAI_API_KEY  || '';
// 翻译是简单任务，用快速低成本模型兜底
const OPENAI_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL   || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
// 无 Gemini/Claude/OpenAI 三家全空才退出
if (!GEMINI_KEY && !CLAUDE_KEY && !OPENAI_KEY) {
    console.error('[step0] GEMINI_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY at least one required');
    process.exit(1);
}
if (!GEMINI_KEY) {
    console.warn('[step0] GEMINI_KEY not set — will use Claude/OpenAI fallback for translation.');
}

// 国家名称映射（与 zhimao apps/web/lib/search/v8DiscoveryCountrySupport.ts 同步）
const COUNTRY_NAMES = {
  // 亚洲
  vn: 'Vietnam', th: 'Thailand', id: 'Indonesia', my: 'Malaysia', sg: 'Singapore',
  ph: 'Philippines', mm: 'Myanmar', kh: 'Cambodia', bd: 'Bangladesh', pk: 'Pakistan',
  in: 'India', lk: 'Sri Lanka', np: 'Nepal', jp: 'Japan', kr: 'South Korea', tw: 'Taiwan',
  cn: 'China', hk: 'Hong Kong', mo: 'Macau', ru: 'Russia',
  // 中东
  ae: 'UAE', sa: 'Saudi Arabia', qa: 'Qatar', kw: 'Kuwait', bh: 'Bahrain', om: 'Oman',
  tr: 'Turkey', il: 'Israel', jo: 'Jordan', eg: 'Egypt',
  // 美洲
  us: 'United States', mx: 'Mexico', br: 'Brazil', co: 'Colombia', cl: 'Chile',
  pe: 'Peru', ar: 'Argentina', ca: 'Canada',
  // 欧洲
  de: 'Germany', gb: 'United Kingdom', fr: 'France', it: 'Italy', es: 'Spain',
  nl: 'Netherlands', pl: 'Poland', se: 'Sweden', no: 'Norway', dk: 'Denmark',
  pt: 'Portugal', ie: 'Ireland', ch: 'Switzerland', at: 'Austria', be: 'Belgium',
  fi: 'Finland', cz: 'Czech Republic', hu: 'Hungary', ro: 'Romania', bg: 'Bulgaria',
  sk: 'Slovakia', hr: 'Croatia', si: 'Slovenia', ee: 'Estonia', lv: 'Latvia', lt: 'Lithuania',
  lu: 'Luxembourg', is: 'Iceland', mt: 'Malta', cy: 'Cyprus',
  // 非洲
  ng: 'Nigeria', za: 'South Africa', ke: 'Kenya', gh: 'Ghana', et: 'Ethiopia',
  // 大洋洲
  au: 'Australia', nz: 'New Zealand',
};

// 语言映射（用于 Gemini 翻译品类意图词）
const LANGUAGE_MAP  = {
  vn: 'Vietnamese', th: 'Thai', id: 'Indonesian', my: 'Malay', ph: 'Filipino',
  mm: 'Burmese', kh: 'Khmer', bd: 'Bengali', pk: 'Urdu', in: 'Hindi', lk: 'Sinhala',
  jp: 'Japanese', kr: 'Korean', tw: 'Traditional Chinese',
  cn: 'Simplified Chinese', hk: 'Traditional Chinese', mo: 'Traditional Chinese', ru: 'Russian',
  ae: 'Arabic', sa: 'Arabic', qa: 'Arabic', kw: 'Arabic', bh: 'Arabic', om: 'Arabic',
  tr: 'Turkish', il: 'Hebrew', jo: 'Arabic', eg: 'Arabic',
  us: 'English', ca: 'English', gb: 'English', au: 'English', nz: 'English', sg: 'English',
  mx: 'Spanish', co: 'Spanish', cl: 'Spanish', pe: 'Spanish', ar: 'Spanish',
  br: 'Portuguese',
  de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch',
  pl: 'Polish', se: 'Swedish', no: 'Norwegian', dk: 'Danish',
  pt: 'Portuguese', ie: 'English', ch: 'German', at: 'German', be: 'Dutch',
  fi: 'Finnish', cz: 'Czech', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian',
  sk: 'Slovak', hr: 'Croatian', si: 'Slovenian', ee: 'Estonian', lv: 'Latvian', lt: 'Lithuanian',
  lu: 'French', is: 'Icelandic', mt: 'English', cy: 'Greek',
  ng: 'English', za: 'English', ke: 'English', gh: 'English', et: 'Amharic',
};

async function run() {
    // 无国家门槛根治（2026-07，双仓镜像 zhimao GLOBAL 哨兵）：GLOBAL = 内贸/全域搜索。
    // 不做 tld 站点限制、不拼国家名后缀、gl 交给 Serper 默认（英文层召回国际买家）。
    const isGlobal = String(countryCode || '').trim().toUpperCase() === 'GLOBAL';
    const cc = isGlobal ? '' : (String(countryCode || '').trim().slice(0, 2).toLowerCase() || 'us');
    const isoUpper = isGlobal ? 'GLOBAL' : cc.toUpperCase();
    const targetLang  = isGlobal ? 'English' : (LANGUAGE_MAP[cc]  || 'English');
    const countryName = isGlobal ? '' : (COUNTRY_NAMES[cc] || isoUpper);
    const tld         = isGlobal ? '' : `site:.${cc} OR site:.com.${cc}`;

    /**
     * 品类词净化：口语查询 + 买家后缀 + 国家前缀。
     * 原词保留在 category 里用于 DB 记录；搜索全程用 categoryClean。
     *
     * 例：
     *   "新加坡有没有电视机" → "电视机"
     *   "居銮红酒买家"       → "居銮红酒"
     *   "LED lighting buyers in Singapore" → "LED lighting"
     */
    const categoryClean = sanitizeDiscoveryCategory(category);

    if (categoryClean !== category) {
        console.log(`[step0] category cleaned: "${category}" → "${categoryClean}"`);
    }

    // ── Pillar 0：读取产业链扩展结果（由 zhimao interpret→expand-query 生成） ──
    let pillar0Keywords = [];
    let pillar0Personas = [];
    let pillar0BooleanQueries = [];
    let procurementQueries = [];
    // P1 本地化（2026-05-21）：从 PILLAR0_PAYLOAD 读取 zhimao 已生成的目标国母语字段，
    // 优先级高于 step0 自己 LLM 翻译路径（zhimao LLM 一次推理得出的本地词更精准）。
    let pillar0LocalKeywords = [];
    let pillar0LocalPersonas = [];
    let pillar0LocalBooleanQueries = [];
    let pillar0TargetLanguage = '';
    try {
        const raw = process.env.PILLAR0_PAYLOAD;
        if (raw && raw.trim().startsWith('{')) {
            const p0 = JSON.parse(raw);
            if (Array.isArray(p0.expanded_keywords) && p0.expanded_keywords.length > 0) {
                pillar0Keywords = p0.expanded_keywords.slice(0, 20); // 最多 20 个扩展词
            }
            if (Array.isArray(p0.buyer_personas) && p0.buyer_personas.length > 0) {
                pillar0Personas = p0.buyer_personas
                    .map((p) => p.industry_en || p.industry_zh || p.industry || p.name)
                    .filter(Boolean)
                    .slice(0, 8);
                // 本地语 personas（如日文 industry_local）
                pillar0LocalPersonas = p0.buyer_personas
                    .map((p) => p.industry_local)
                    .filter((s) => typeof s === 'string' && s.trim())
                    .slice(0, 8);
            }
            if (Array.isArray(p0.boolean_queries) && p0.boolean_queries.length > 0) {
                pillar0BooleanQueries = p0.boolean_queries.slice(0, 5);
            }
            if (Array.isArray(p0.boolean_queries_local) && p0.boolean_queries_local.length > 0) {
                pillar0LocalBooleanQueries = p0.boolean_queries_local.slice(0, 5);
            }
            if (Array.isArray(p0.expanded_keywords_local) && p0.expanded_keywords_local.length > 0) {
                pillar0LocalKeywords = p0.expanded_keywords_local.slice(0, 20);
            }
            if (Array.isArray(p0.procurement_queries) && p0.procurement_queries.length > 0) {
                procurementQueries = p0.procurement_queries.slice(0, 6);
            }
            if (typeof p0.target_language === 'string' && p0.target_language.trim()) {
                pillar0TargetLanguage = p0.target_language.trim();
            }
            if (pillar0Keywords.length > 0 || pillar0Personas.length > 0) {
                console.log(`[step0] Pillar 0 payload loaded: ${pillar0Keywords.length} keywords, ${pillar0Personas.length} personas`);
                if (pillar0LocalKeywords.length > 0 || pillar0LocalPersonas.length > 0) {
                    console.log(`[step0] Pillar 0 LOCAL (${pillar0TargetLanguage || targetLang || 'unknown'}) loaded: ${pillar0LocalKeywords.length} keywords, ${pillar0LocalPersonas.length} personas, ${pillar0LocalBooleanQueries.length} boolean`);
                }
            }
        }
    } catch (e) {
        console.warn('[step0] PILLAR0_PAYLOAD parse failed, continuing without expansion:', e.message);
    }

    let baseQuery = '';
    // 本地语翻译产物（jp/de/es/...）；P0 修复后会与英文 pillar0 并联到最终 query，
    // 而不是被 pillar0 覆盖。
    let translatedCategory = '';
    let nativeIntents = [];

    // 判断净化后的品类是否已是纯英文（无中文/日文/韩文/阿拉伯文等 Unicode 区段），
    // 若是则跳过 LLM 翻译直接用英文模板——避免 LLM 误改导致 exit(1) + 节省费用。
    const hasNonLatin = /[\u0080-\uFFFF]/.test(categoryClean);
    const isAlreadyEnglish = !hasNonLatin;

    // P1 优先级（2026-05-21）：如果 zhimao 已经给了本地化字段（pillar0LocalPersonas
     // 至少 1 条 + pillar0LocalBoolean 至少 1 条），跳过 step0 自己 LLM 翻译，
     // 直接用 zhimao 输出的本地词构建 baseQuery —— 减少 LLM 调用 + 避免双重翻译漂移。
    const hasZhimaoLocal = pillar0LocalPersonas.length > 0 && pillar0LocalBooleanQueries.length > 0;
    if (hasZhimaoLocal) {
        translatedCategory = pillar0LocalPersonas[0]; // 用第一个本地 persona 作为本地品类
        // 从 boolean_queries_local 抽取 4 个最高频的本地意图词（最简方法：split AND/OR 取前 4 个 quoted token）
        const intentSet = new Set();
        for (const bq of pillar0LocalBooleanQueries) {
            const matches = String(bq).match(/"([^"]+)"/g) || [];
            for (const m of matches) {
                const w = m.replace(/"/g, '').trim();
                if (w && !intentSet.has(w)) {
                    intentSet.add(w);
                    if (intentSet.size >= 6) break;
                }
            }
            if (intentSet.size >= 6) break;
        }
        nativeIntents = Array.from(intentSet).slice(0, 4);
        if (translatedCategory && nativeIntents.length > 0) {
            const nativeStr = nativeIntents.map(i => `"${i}"`).join(' OR ');
            baseQuery = `"${translatedCategory}" (${nativeStr})`;
            console.log(`[step0] zhimao-local baseQuery: "${translatedCategory}" + ${nativeIntents.length} intent words (${pillar0TargetLanguage || targetLang})`);
        }
    } else if (targetLang !== 'English' && !isAlreadyEnglish) {
        // 生成 3 类买家意图词：进口/批发渠道词 + 采购行为词 + 本地行业身份词
        // 使用净化后的 categoryClean 而非原始 category，避免"买家/buyers in X"干扰翻译
        const prompt = `You are a B2B procurement data expert.
Translate the industrial category "${categoryClean}" to ${targetLang} and provide buyer intent keywords.
Return ONLY valid JSON with this exact structure:
{
  "translated_category": "...",
  "buyer_channel_words": ["importer equivalent", "wholesaler equivalent"],
  "buying_intent_words": ["looking for supplier equivalent", "sourcing equivalent"],
  "company_type_words": ["trading company equivalent", "distributor equivalent"]
}`;
        // 与 zhimao apps/web 业态画像树工程对齐：统一走 callGeminiJson
        // 三家级联：Gemini (flash-lite) → Claude (sonnet-4-6) → OpenAI (gpt-4.1-mini)
        let content = null;
        try {
            content = await callGeminiJson(prompt, {
                apiKey: GEMINI_KEY,
                model: GEMINI_MODEL,
                temperature: 0.1,
                timeoutMs: 15_000,
                maxRetries: 2,
                label: 'step0/translate',
                openaiApiKey: OPENAI_KEY,
                openaiModel: OPENAI_MODEL,
                claudeApiKey: CLAUDE_KEY,
                claudeModel: CLAUDE_MODEL,
            });
        } catch (e) {
            console.warn(`[step0] callGeminiJson failed: ${e.message.slice(0, 120)}`);
            content = null;
        }

        if (content) {
            const allIntents = [
                ...(content.buyer_channel_words || []),
                ...(content.buying_intent_words || []),
                ...(content.company_type_words  || []),
            ].slice(0, 4); // 最多 4 个，避免 query 过长
            translatedCategory = String(content.translated_category || '').trim();
            nativeIntents = allIntents.map(i => String(i || '').trim()).filter(Boolean);
            const nativeStr = nativeIntents.map(i => `"${i}"`).join(' OR ');
            if (translatedCategory && nativeStr) {
                baseQuery = `"${translatedCategory}" (${nativeStr})`;
                console.log(`[step0] native baseQuery: "${translatedCategory}" + ${nativeIntents.length} intent words (${targetLang})`);
            }
        }
    }

    if (!baseQuery) {
        // 英语市场 或 品类词已是英文：多样化买家意图词（不只是 importer/wholesaler）
        // 使用净化后的 categoryClean 避免把"buyers in Singapore"再套进 query
        if (isAlreadyEnglish && targetLang !== 'English') {
            console.log(`[step0] category already English, skipping LLM translation for ${targetLang} market`);
        }
        baseQuery = `"${categoryClean}" ("importer" OR "wholesaler" OR "distributor" OR "buyer" OR "procurement" OR "sourcing")`;
    }

    // ── Pillar 0 注入：将产业链扩展词追加到搜索策略 ──────────────────────────
    // 例：搜"电池"时扩展为"drone manufacturer OR e-bike assembler OR energy storage brand"
    //
    // P0 修复（2026-05-21）：原来的逻辑是 baseQuery = ... 整个覆盖，导致
    // step0 LLM 刚翻译好的日文/西文/... baseQuery 被英文 pillar0 完全替换，
    // 失去本地化优势（日本本地买家网站 90% 用日文，搜不到）。
    // 新策略：把英文 pillar0 层与本地语 baseQuery 并联——优先生成
    //   `(本地品类 OR (英文行业层)) AND (本地意图 OR 英文意图)`
    // 让 SERP 同时命中本地买家网站 + 国际化大品牌。
    let englishLayer = '';
    if (pillar0Personas.length > 0 || pillar0Keywords.length > 0) {
        const intentTerms = [
            ...pillar0Personas.slice(0, 5).map(p => `"${p}"`),
            ...pillar0Keywords.slice(0, 8).map(k => `"${k}"`),
        ];
        if (intentTerms.length > 0) {
            englishLayer = intentTerms.join(' OR ');
        }
    }

    if (englishLayer) {
        const englishIntent = '"importer" OR "buyer" OR "procurement" OR "sourcing" OR "supplier"';
        if (translatedCategory) {
            // 本地语 + 英文行业层并联（最完整：日本本地连锁 + 国际化大品牌）
            const subjectClause = `"${translatedCategory}" OR ${englishLayer}`;
            const nativeStr = nativeIntents.length > 0
                ? nativeIntents.map(i => `"${i}"`).join(' OR ') + ' OR '
                : '';
            const intentClause = nativeStr + englishIntent;
            baseQuery = `(${subjectClause}) AND (${intentClause})`;
            console.log(`[step0] bilingual baseQuery: native + en-pillar0 merged (${targetLang} + English)`);
        } else {
            // 没有本地翻译（英语市场 / 翻译失败），退化为原英文 pillar0 query
            baseQuery = `(${englishLayer}) AND (${englishIntent})`;
            console.log('[step0] english-only baseQuery: en-pillar0 only');
        }
    }

    // 写出 step0 结果（含 Pillar 0 扩展词 + P1 本地化字段，供 step1+ 使用）
    fs.writeFileSync(outputFile, JSON.stringify({
        baseQuery,
        tld,
        countryName,
        countryCode: isoUpper,
        targetLang,                                    // 本地化语种（供 step1 multi-lang rotation 用）
        targetLanguageHint: pillar0TargetLanguage || targetLang,
        category,                                      // 保留原始品类词供 DB 记录展示
        categoryClean,                                 // 净化后的搜索品类词，step1 用于构建 query
        translatedCategory: translatedCategory || undefined,  // 本地语品类（如 "メガネ"）
        nativeIntents: nativeIntents.length > 0 ? nativeIntents : undefined,
        // 传递 Pillar 0 原始数据给后续步骤备用
        pillar0Keywords: pillar0Keywords.length > 0 ? pillar0Keywords : undefined,
        pillar0BooleanQueries: pillar0BooleanQueries.length > 0 ? pillar0BooleanQueries : undefined,
        // P1 本地化（2026-05-21）：transparently pass-through 给 step1 multi-lang rotation
        pillar0LocalKeywords: pillar0LocalKeywords.length > 0 ? pillar0LocalKeywords : undefined,
        pillar0LocalPersonas: pillar0LocalPersonas.length > 0 ? pillar0LocalPersonas : undefined,
        pillar0LocalBooleanQueries: pillar0LocalBooleanQueries.length > 0 ? pillar0LocalBooleanQueries : undefined,
        procurementQueries: procurementQueries.length > 0 ? procurementQueries : undefined,
    }, null, 2));
    console.log(`[step0] Orchestration written → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
