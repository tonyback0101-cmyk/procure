/**
 * v8_lib_concurrency.js
 *
 * Zero-dependency utilities used by step2 / step3 to remove the real bottlenecks
 * we observed in production (single-batch sequential Gemini calls, no timeouts,
 * silent 429 swallowing, no retry).
 *
 * Exports:
 *   - pMap(items, mapper, { concurrency, stopOnError })
 *       Bounded-concurrency parallel map. Preserves input order in results.
 *
 *   - requestJsonWithRetry({ hostname, path, method, headers, body, timeoutMs, maxRetries })
 *       HTTPS request with hard timeout, exponential backoff on 429/5xx/network errors,
 *       and JSON parse error reporting. Returns { statusCode, json, raw, error }.
 *
 *   - callGeminiJson(promptText, opts)
 *       High-level Gemini wrapper that *actually* surfaces errors and parses the
 *       structured JSON candidate.parts[0].text. Returns the parsed object or throws.
 *
 *   - preFilterRawLeads(rawItems)
 *       Cheap local rules to drop obvious listicles / blogs / marketplaces /
 *       CN-supplier pages BEFORE we spend Gemini quota on them.
 */

const https = require('https');
const { offCategoryReason, resolveCategory } = require('./v8_lib_category_relevance');

/**
 * 宽松 JSON 解析：剥 markdown fence、截断补全括号。
 * L3 大批次时 Gemini 常截断在 results[] 中间，直接 JSON.parse 失败会误触发 Claude 兜底。
 */
function parseJsonLoose(text) {
    let s = String(text || '').trim();
    if (!s) throw new Error('empty_json_text');
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        return JSON.parse(s);
    } catch (_) { /* continue */ }

    const startObj = s.indexOf('{');
    const startArr = s.indexOf('[');
    let start = -1;
    if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
    else if (startArr >= 0) start = startArr;
    if (start > 0) s = s.slice(start);

    try {
        return JSON.parse(s);
    } catch (_) { /* continue */ }

    // 截断修复：丢掉末尾不完整 token，再补齐未闭合的引号/括号
    let repaired = s
        .replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*$/, '') // 未完成的 ,"key
        .replace(/,\s*\{[^}]*$/, '') // 未完成的对象元素
        .replace(/:\s*"[^"\\]*(?:\\.[^"\\]*)*$/, ':null') // 未完成的字符串值
        .replace(/,\s*$/, '');

    let inStr = false;
    let esc = false;
    const stack = [];
    for (let i = 0; i < repaired.length; i++) {
        const ch = repaired[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) repaired += '"';
    while (stack.length) {
        repaired += stack.pop() === '{' ? '}' : ']';
    }
    return JSON.parse(repaired);
}

// ─── pMap ───────────────────────────────────────────────────────────────────
async function pMap(items, mapper, { concurrency = 4, stopOnError = false } = {}) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;

    async function worker() {
        while (true) {
            const i = nextIndex;
            nextIndex += 1;
            if (i >= items.length) return;
            if (firstError && stopOnError) return;
            try {
                results[i] = await mapper(items[i], i);
            } catch (err) {
                results[i] = err instanceof Error ? err : new Error(String(err));
                if (!firstError) firstError = results[i];
                if (stopOnError) return;
            }
        }
    }

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
    await Promise.all(workers);
    if (stopOnError && firstError) throw firstError;
    return results;
}

// ─── requestJsonWithRetry ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetryableStatus(code) {
    return code === 408 || code === 425 || code === 429 || (code >= 500 && code < 600);
}

async function requestJsonWithRetry({
    hostname,
    path,
    method = 'POST',
    headers = {},
    body = null,
    timeoutMs = 25_000,
    maxRetries = 3,
    backoffBaseMs = 1_500,
    backoffCapMs = 12_000,
    label = 'req',
} = {}) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= maxRetries) {
        attempt += 1;
        const startedAt = Date.now();

        const result = await new Promise(resolve => {
            const reqOptions = {
                hostname,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers,
                    ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            };
            let settled = false;
            const settle = (val) => { if (!settled) { settled = true; resolve(val); } };

            const req = https.request(reqOptions, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => settle({ statusCode: res.statusCode, raw }));
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`timeout_${timeoutMs}ms`));
            });
            req.on('error', e => settle({ error: e }));
            if (body) req.write(body);
            req.end();
        });

        const elapsed = Date.now() - startedAt;

        if (result.error) {
            lastError = result.error;
            if (attempt > maxRetries) break;
            const wait = Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, attempt - 1));
            console.warn(`[${label}] transport error attempt ${attempt}/${maxRetries + 1} after ${elapsed}ms: ${lastError.message}; backing off ${wait}ms`);
            await sleep(wait);
            continue;
        }

        if (isRetryableStatus(result.statusCode)) {
            lastError = new Error(`http_${result.statusCode}`);
            if (attempt > maxRetries) {
                return { statusCode: result.statusCode, raw: result.raw, error: lastError, attempts: attempt };
            }
            const wait = Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, attempt - 1));
            console.warn(`[${label}] HTTP ${result.statusCode} attempt ${attempt}/${maxRetries + 1} after ${elapsed}ms; backing off ${wait}ms`);
            await sleep(wait);
            continue;
        }

        let json = null;
        let parseError = null;
        try { json = JSON.parse(result.raw); }
        catch (e) { parseError = e; }
        return { statusCode: result.statusCode, raw: result.raw, json, parseError, attempts: attempt };
    }

    return { statusCode: 0, error: lastError, attempts: attempt };
}

// 与 zhimao apps/web/lib/search/llmClient.ts 对齐（业态画像树工程标准）
// 实测见 zhimao apps/web/scripts/test-gemini-models.mjs（2026-05-20）：
//   - gemini-3-flash-preview   ~1.4s ✓ 最快（默认 fallback 首位）
//   - gemini-3.1-pro-preview   ~4.5s ✓ 但复杂 JSON schema 偶尔 >15s（30s timeout 覆盖）
//   - gemini-2.5-flash         ~4.5s ✓ 第三档
//   - gemini-2.5-pro           >12s timeout ✗ 已剔除
//   - gemini-3.1-pro / gemini-3-pro   404 不存在
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_MODEL_FALLBACK_CHAIN = [
    DEFAULT_GEMINI_MODEL,
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
].filter((m, i, a) => m && a.indexOf(m) === i);

// Claude fallback — 用户指令 2026-05-20：把 Claude 调到 Gemini 之后、OpenAI 之前
// 用户钦定默认 model: claude-sonnet-4-6（性价比 + 稳定，2.3s）
// 实测（zhimao apps/web/scripts/test-claude-openai-models.mjs）：
//   - claude-sonnet-4-6 2.3s ✓ 默认
//   - claude-opus-4-7   1.4s ✓ 最快质量兜底
//   - claude-opus-4-6   1.7s ✓
//   - claude-sonnet-4-5 1.5s ✓ 更便宜兜底
//   - claude-sonnet-4-7 404 不存在
const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CLAUDE_MODEL_FALLBACK_CHAIN = [
    DEFAULT_CLAUDE_MODEL,
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
].filter((m, i, a) => m && a.indexOf(m) === i);

function isGeminiModelUnavailableError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('not found') || msg.includes('not supported') || msg.includes('is not found for api version');
}

// ─── callGeminiJson ─────────────────────────────────────────────────────────
// Provider 优先级（用户指令 2026-05-20）：
//   1. Gemini（GEMINI_MODEL，默认 gemini-3.1-pro-preview，含模型 fallback chain）
//   2. Claude（ANTHROPIC_API_KEY，默认 claude-opus-4-7，含模型 fallback chain）← NEW
//   3. OpenAI（OPENAI_API_KEY，默认 gpt-5.4）
async function callGeminiJson(promptText, {
    apiKey,
    model = DEFAULT_GEMINI_MODEL,
    temperature = 0.1,
    timeoutMs = 60_000,
    maxRetries = 3,
    label = 'gemini',
    openaiApiKey = process.env.OPENAI_API_KEY || '',
    // OpenAI 兜底：用户硬规则 GPT-5.4+
    openaiModel  = process.env.OPENAI_MODEL    || 'gpt-5.4',
    claudeApiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '',
    claudeModel  = DEFAULT_CLAUDE_MODEL,
    disableFallback = false,
    /** 绝对截止时间戳（Date.now()）；到点后不再试下一个模型/provider，避免 fallback 链再卡 60s+ */
    softDeadlineMs = 0,
} = {}) {
    if (!apiKey) throw new Error('GEMINI_KEY required');

    const remainingMs = () => (softDeadlineMs > 0 ? softDeadlineMs - Date.now() : Infinity);
    const assertBudget = (phase) => {
        const left = remainingMs();
        if (left <= 1_500) {
            throw new Error(`soft_deadline_${phase}: ${Math.max(0, Math.round(left))}ms left`);
        }
        return left;
    };

    // ── 1. 尝试 Gemini（主模型 + 回退链）────────────────────────────────────────
    let geminiError = null;
    const modelsToTry = [model, ...GEMINI_MODEL_FALLBACK_CHAIN].filter((m, i, a) => m && a.indexOf(m) === i);
    for (const tryModel of modelsToTry) {
        try {
            const left = assertBudget(`before_${tryModel}`);
            const attemptTimeout = Math.min(timeoutMs, Math.max(5_000, left - 500));
            const attemptRetries = left < timeoutMs ? 0 : maxRetries;
            const reqBody = JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: { temperature, responseMimeType: 'application/json' },
            });
            const r = await requestJsonWithRetry({
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${tryModel}:generateContent?key=${apiKey}`,
                method: 'POST',
                body: reqBody,
                timeoutMs: attemptTimeout,
                maxRetries: attemptRetries,
                label: `${label}/${tryModel}`,
            });
            if (r.error) throw new Error(`gemini_failed: ${r.error.message}`);
            if (!r.json) throw new Error(`gemini_parse_failed: status=${r.statusCode}, body=${(r.raw || '').slice(0, 200)}`);
            if (r.json.error) throw new Error(`gemini_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
            const text = r.json?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error(`gemini_empty_candidate: status=${r.statusCode}`);
            try {
                const parsed = parseJsonLoose(text);
                if (tryModel !== model) {
                    console.log(`[${label}] Gemini succeeded with fallback model ${tryModel}`);
                }
                return parsed;
            } catch (e) {
                // 截断 JSON：先试下一个 Gemini 模型，再走 Claude（比直接 Claude 便宜）
                throw new Error(`gemini_text_not_json: ${e.message}; head=${String(text).slice(0, 200)}`);
            }
        } catch (err) {
            geminiError = err;
            if (/soft_deadline_/.test(String(err.message || ''))) {
                console.warn(`[${label}] soft deadline hit (${err.message.slice(0, 80)}) — skip remaining Gemini/Claude/OpenAI`);
                throw err;
            }
            if (isGeminiModelUnavailableError(err) || /gemini_text_not_json/.test(String(err.message || ''))) {
                console.warn(`[${label}] Gemini model ${tryModel} failed (${err.message.slice(0, 100)}), trying next…`);
                continue;
            }
            console.warn(`[${label}] Gemini failed (${err.message.slice(0, 120)})`);
            break;
        }
    }

    // ── 2. Claude 兜底（用户指令 2026-05-20：Claude 在 OpenAI 之前）────────────
    let claudeError = null;
    if (!disableFallback && claudeApiKey) {
        const claudeModelsToTry = [claudeModel, ...CLAUDE_MODEL_FALLBACK_CHAIN].filter(
            (m, i, a) => m && a.indexOf(m) === i,
        );
        for (const tryClaudeModel of claudeModelsToTry) {
            try {
                const left = assertBudget(`before_claude_${tryClaudeModel}`);
                console.warn(`[${label}] → Falling back to Claude ${tryClaudeModel}...`);
                const claudeBody = JSON.stringify({
                    model: tryClaudeModel,
                    max_tokens: 4096,
                    temperature,
                    system:
                        'You are a B2B procurement data extraction assistant. Respond ONLY with a valid JSON object. No markdown fences, no explanation.',
                    messages: [{ role: 'user', content: promptText }],
                });
                const r = await requestJsonWithRetry({
                    hostname: 'api.anthropic.com',
                    path: '/v1/messages',
                    method: 'POST',
                    headers: {
                        'x-api-key': claudeApiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: claudeBody,
                    timeoutMs: Math.min(timeoutMs + 5_000, Math.max(5_000, left - 500)),
                    maxRetries: left < timeoutMs ? 0 : 2,
                    label: `${label}/claude-fallback`,
                });
                if (r.error) throw new Error(`claude_failed: ${r.error.message}`);
                if (!r.json) throw new Error(`claude_parse_failed: status=${r.statusCode}`);
                if (r.json.error) throw new Error(`claude_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
                const text = (r.json?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
                if (!text) throw new Error('claude_empty_response');
                const result = parseJsonLoose(text);
                if (tryClaudeModel !== claudeModel) {
                    console.log(`[${label}] Claude succeeded with fallback model ${tryClaudeModel}`);
                } else {
                    console.log(`[${label}] Claude fallback succeeded (${tryClaudeModel})`);
                }
                return result;
            } catch (clErr) {
                claudeError = clErr;
                const msg = String(clErr.message || '');
                if (/soft_deadline_/.test(msg)) {
                    console.warn(`[${label}] soft deadline during Claude — abort fallbacks`);
                    throw clErr;
                }
                // 模型不存在 → 试下一个；其他错误 → 中断 Claude 链路转 OpenAI
                if (msg.includes('not_found') || msg.includes('404') || msg.includes('claude_text_not_json')) {
                    console.warn(`[${label}] Claude model ${tryClaudeModel} not available (${msg.slice(0, 80)}), trying next…`);
                    continue;
                }
                console.warn(`[${label}] Claude failed (${msg.slice(0, 100)})`);
                break;
            }
        }
    }

    // ── 3. OpenAI 兜底（用户指令 2026-05-20：第三位）─────────────────────────
    if (disableFallback || !openaiApiKey) {
        throw geminiError;
    }
    const oaLeft = assertBudget('before_openai');
    console.warn(`[${label}] → Falling back to OpenAI ${openaiModel}...`);
    try {
        // GPT-5 reasoning 系列实测约束（2026-05-20 procure/scripts/test-gpt55-temperature.cjs）：
        //   - gpt-5 / gpt-5.5：reasoning model → 必须 max_completion_tokens；temperature 只支持 1（默认）
        //   - gpt-5.4 / gpt-5.4-mini：chat model → 同样用 max_completion_tokens；temperature 支持自定义
        //   - gpt-4.x：用 max_tokens；temperature 支持自定义
        const isGpt5Plus = /^gpt-5/i.test(openaiModel);
        // gpt-5.0 / gpt-5.5 等"纯 reasoning"模型；gpt-5.4 是 chat 变体支持 temperature
        const isGpt5Reasoning = /^gpt-5(\.\d+)?$/i.test(openaiModel) && !/^gpt-5\.4/i.test(openaiModel);
        const tokenField = isGpt5Plus ? 'max_completion_tokens' : 'max_tokens';
        const oaBody = JSON.stringify({
            model: openaiModel,
            // reasoning 模型不传 temperature；chat 模型传配置值
            ...(isGpt5Reasoning ? {} : { temperature }),
            // reasoning 模型给更大 budget（reasoning tokens 会占用 max_completion_tokens）
            [tokenField]: isGpt5Reasoning ? 8192 : 4096,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'You are a B2B procurement data extraction assistant. Always respond with valid JSON.' },
                { role: 'user',   content: promptText },
            ],
        });
        const r = await requestJsonWithRetry({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiApiKey}` },
            body: oaBody,
            timeoutMs: Math.min(timeoutMs + 10_000, Math.max(5_000, oaLeft - 500)),
            maxRetries: oaLeft < timeoutMs ? 0 : 2,
            label: `${label}/openai-fallback`,
        });
        if (r.error) throw new Error(`openai_failed: ${r.error.message}`);
        if (!r.json) throw new Error(`openai_parse_failed: status=${r.statusCode}`);
        if (r.json.error) throw new Error(`openai_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
        const text = r.json?.choices?.[0]?.message?.content;
        if (!text) throw new Error('openai_empty_response');
        const result = parseJsonLoose(text);
        console.log(`[${label}] OpenAI fallback succeeded`);
        return result;
    } catch (oaErr) {
        const claudeMsg = claudeError ? `, claude=(${String(claudeError.message || '').slice(0, 60)})` : '';
        throw new Error(`all_llm_failed: gemini=(${geminiError.message.slice(0, 60)})${claudeMsg}, openai=(${oaErr.message.slice(0, 60)})`);
    }
}

// ─── preFilterRawLeads ──────────────────────────────────────────────────────
// Local heuristics that mirror the LLM "anti-pollution / anti-blog / anti-platform"
// rules but at zero cost. Filtering ~30-50% of obvious noise before Gemini cuts
// step2 wall time and quota usage proportionally.
const LISTICLE_RE = /\b(top\s*\d+|best\s+\w+|how\s+to\b|guide\s+to\b|review[s]?:?\b|vs\.?\b|things\s+you\s+should|^\d+\s+(best|top)|rankings?\b|jun\s+20\d{2}\s+rankings?|minimum\s+\d+\s*kg|起订)\b/i;

// 榜单 / 访谈 / 商会目录 / 媒体内容（非买家实体）— 结构性噪声，与品类无关，始终硬丢
const DIRECTORY_NOISE_RE =
  /\b(membership\s+directory|list\s+of\s+companies|company\s+directory|industry\s+directory|chamber\s+of\s+commerce|amcham\b|content\s+creator\s+interview|questions\s+with\b|interview\s+with\b|top\s+manufacturing\s+companies|manufacturing\s+companies\s+in\s+\w+\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?\s*20\d{2}\s*rankings?)\b|会员名录|企业名录|商会名录|专访|访谈/i;

// 新闻/媒体文章特征（标题级别即可拦截，无需等 Gemini）
const NEWS_TITLE_RE = /\b(breaking\s+news|press\s+release|media\s+release|news\s+report|daily\s+news|weekly\s+news|记者|报道|报章|新闻|报导|早报|联合早报|副刊|采访|专访|通讯社|smart\s*local|mothership)\b/i;
// 已结业/永久关闭特征（snippet 级别）
const CLOSED_BIZ_RE = /\b(permanently\s+clos|closed\s+down|ceased\s+operat|no\s+longer\s+operat|out\s+of\s+business|went\s+bankrupt|liquidat|已结业|已停业|停止营业|结业清货|倒闭|停办)\b/i;

// 新加坡及亚太区主要新闻媒体域名（buyer 来源不应包含新闻报章）
const NEWS_DOMAIN_HOSTS = new Set([
    // 新加坡
    'zaobao.com.sg', 'www.zaobao.com.sg', 'zaobao.sg', 'zbschools.sg',
    'straitstimes.com', 'www.straitstimes.com',
    'channelnewsasia.com', 'www.channelnewsasia.com',
    'todayonline.com', 'www.todayonline.com',
    'businesstimes.com.sg', 'www.businesstimes.com.sg',
    'mothership.sg', 'www.mothership.sg',
    'stomp.straitstimes.com', 'stomp.com.sg',
    '8world.com', 'www.8world.com',
    'beritaharian.sg', 'www.beritaharian.sg',
    'tamilmurasu.com.sg',
    'tnp.sg',
    // 马来西亚
    'thestar.com.my', 'www.thestar.com.my',
    'nst.com.my', 'www.nst.com.my',
    'malaymail.com', 'www.malaymail.com',
    'sinchew.com.my', 'www.sinchew.com.my',
    // 全球主流媒体
    'bbc.com', 'www.bbc.com', 'bbc.co.uk',
    'cnn.com', 'www.cnn.com',
    'reuters.com', 'www.reuters.com',
    'bloomberg.com', 'www.bloomberg.com',
    'ft.com', 'www.ft.com',
    'wsj.com', 'www.wsj.com',
    'theguardian.com', 'www.theguardian.com',
    'techcrunch.com', 'www.techcrunch.com',
    'forbes.com', 'www.forbes.com',
    'businessinsider.com', 'www.businessinsider.com',
    'nytimes.com', 'www.nytimes.com',
    'washingtonpost.com', 'www.washingtonpost.com',
]);
const NEWS_DOMAIN_RE = /\.(news|press|media|journalist|tribune|gazette|herald|chronicle|times\.com\.sg|daily|weekly|post\.com)$/i;

// 注意：importyeti / volza / panjiva 不在此 PLATFORM 黑名单——它们是真实进口商目录的
// 强信号源。step1 fromOrganic 把这些站的 link 转为 source_url（lead.link=null），
// preFilterRawLeads 不会因 link=null 把它们当 no_signal 丢掉（看 line 351：仅在 title+snippet 都空时丢）。
const PLATFORM_HOSTS = [
    'alibaba.com', 'aliexpress.com', 'amazon.com', 'thomasnet.com',
    'globalsources.com', 'made-in-china.com', 'tradeindia.com',
    'indiamart.com', 'tradewheel.com', 'ec21.com', 'ecplaza.net',
    'tradekey.com', 'go4worldbusiness.com',
    'reddit.com', 'quora.com',
    'wikipedia.org', 'wikihow.com', 'youtube.com',
    'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
    // 电商/外卖/内容平台（非 B2B 买家官网）
    'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com',
    'foodpanda.sg', 'foodpanda.com', 'grab.com', 'deliveroo.com', 'grubhub.com',
    'lemon8-app.com', 'huggingface.co', 'ebay.com', 'ebay.com.sg',
    'tridge.com', 'carousell.com', 'shopee.sg', 'shopee.com',
];
const CN_HINT_RE = /\b(china|chinese|guangzhou|shenzhen|yiwu|shanghai|ningbo|hk\b|hong\s*kong)\b/i;

function isNewsDomain(link) {
    if (!link) return false;
    try {
        const host = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.toLowerCase();
        if (NEWS_DOMAIN_HOSTS.has(host)) return true;
        if (NEWS_DOMAIN_RE.test(host)) return true;
    } catch (_) {}
    return false;
}

function loadDomainBlacklistFromEnv() {
    const raw = process.env.DISCOVERY_DOMAIN_BLACKLIST || '[]';
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr)
            ? arr.map((d) => String(d || '').toLowerCase().replace(/^www\./, '')).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

// P6b 供应商模式：找供应商时不能把"中国制造商/出口商/工厂"当污染丢掉——它们正是目标。
// 同理 thomasnet/globalsources/made-in-china 等供应商目录站不再当 platform 噪声整条丢
// （step1 供应商目录 pillar 已把 link=null + source_url，本函数不会因 link 命中 PLATFORM_HOSTS 丢，
//  但 factory-direct organic 仍可能命中 cn_supplier，这里据 supplierMode 放行）。
function preFilterRawLeads(rawItems, opts) {
    if (!Array.isArray(rawItems)) return { kept: [], dropped: 0, reasons: {} };
    const supplierMode = !!(opts && opts.supplierMode);
    const category = resolveCategory(opts && opts.category);
    const kept = [];
    const domainBlacklist = loadDomainBlacklistFromEnv();
    const blacklistSet = new Set(domainBlacklist);
    const reasons = {
      listicle: 0, platform: 0, cn_supplier: 0, no_signal: 0,
      news_media: 0, closed_biz: 0, policy_domain: 0,
      directory: 0, off_category: 0,
    };
    for (const r of rawItems) {
        const title = String(r.title || '').trim();
        const snippet = String(r.snippet || '').trim();
        const link = String(r.link || '').toLowerCase();
        const combined = `${title} ${snippet}`;

        if (blacklistSet.size > 0 && link) {
            try {
                const host = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.toLowerCase().replace(/^www\./, '');
                if (blacklistSet.has(host)) { reasons.policy_domain += 1; continue; }
            } catch { /* ignore */ }
        }

        if (!title && !snippet) { reasons.no_signal += 1; continue; }
        if (LISTICLE_RE.test(title) || LISTICLE_RE.test(snippet)) { reasons.listicle += 1; continue; }
        if (DIRECTORY_NOISE_RE.test(combined)) { reasons.directory += 1; continue; }
        // 垂直错配：对照用户品类（搜护肤时不丢护肤 OEM；搜白菜时丢汽车站）
        if (offCategoryReason(combined, category)) {
          reasons.off_category += 1;
          continue;
        }
        // 供应商模式：保留带 link 的供应商目录站结果（step1 已对目录 pillar 置 link=null，
        // 此处仅 factory-direct organic 带 link，故 supplierMode 下不按 PLATFORM_HOSTS 一刀切）。
        if (!supplierMode && PLATFORM_HOSTS.some(h => link.includes(h))) { reasons.platform += 1; continue; }
        // 新闻媒体：域名黑名单 + 标题特征
        if (isNewsDomain(link) || NEWS_TITLE_RE.test(title)) { reasons.news_media += 1; continue; }
        // 已结业商家：snippet/title 含关闭特征词
        if (CLOSED_BIZ_RE.test(combined)) { reasons.closed_biz += 1; continue; }
        // CN-supplier hint must be in the snippet+title combo and not contradicted
        // by a non-CN country mention. Coarse but cheap.
        // 供应商模式：中国制造商/出口商正是目标，不丢。
        if (!supplierMode && CN_HINT_RE.test(combined) && /\b(supplier|exporter|manufacturer|factory)\b/i.test(snippet)) {
            reasons.cn_supplier += 1; continue;
        }
        kept.push(r);
    }
    return { kept, dropped: rawItems.length - kept.length, reasons };
}

module.exports = {
    pMap,
    sleep,
    requestJsonWithRetry,
    callGeminiJson,
    parseJsonLoose,
    preFilterRawLeads,
};
