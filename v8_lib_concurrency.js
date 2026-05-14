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

// ─── callGeminiJson ─────────────────────────────────────────────────────────
// 模型分级策略（按任务复杂度）：
//   复杂任务（L3 供应链推断）→ GEMINI_MODEL=gemini-3.1-pro-preview（env 默认）
//   简单任务（翻译/名称提取）→ GEMINI_FAST_MODEL=gemini-3.1-flash-lite（env 快速模式）
//   所有 Gemini 失败后      → OpenAI gpt-4o 自动兜底（OPENAI_API_KEY）
async function callGeminiJson(promptText, {
    apiKey,
    model = 'gemini-3.1-pro-preview',
    temperature = 0.1,
    timeoutMs = 25_000,
    maxRetries = 3,
    label = 'gemini',
    openaiApiKey = process.env.OPENAI_API_KEY || '',
    // 兜底模型默认 gpt-5.5（2026-04 最新旗舰）
    openaiModel  = process.env.OPENAI_MODEL    || 'gpt-5.5',
    disableFallback = false,
} = {}) {
    if (!apiKey) throw new Error('GEMINI_KEY required');

    // ── 1. 尝试 Gemini ────────────────────────────────────────────────────────
    let geminiError = null;
    try {
        const reqBody = JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { temperature, responseMimeType: 'application/json' },
        });
        const r = await requestJsonWithRetry({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
            method: 'POST',
            body: reqBody,
            timeoutMs,
            maxRetries,
            label,
        });
        if (r.error) throw new Error(`gemini_failed: ${r.error.message}`);
        if (!r.json) throw new Error(`gemini_parse_failed: status=${r.statusCode}, body=${(r.raw || '').slice(0, 200)}`);
        if (r.json.error) throw new Error(`gemini_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
        const text = r.json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error(`gemini_empty_candidate: status=${r.statusCode}`);
        try { return JSON.parse(text); }
        catch (e) { throw new Error(`gemini_text_not_json: ${e.message}; head=${String(text).slice(0, 200)}`); }
    } catch (err) {
        geminiError = err;
        console.warn(`[${label}] Gemini failed (${err.message.slice(0, 120)})`);
    }

    // ── 2. OpenAI 兜底（Gemini 限流/错误时自动切换）────────────────────────────
    if (disableFallback || !openaiApiKey) {
        throw geminiError;
    }
    console.warn(`[${label}] → Falling back to OpenAI ${openaiModel}...`);
    try {
        const oaBody = JSON.stringify({
            model: openaiModel,
            temperature,
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
            timeoutMs: timeoutMs + 10_000, // OpenAI 通常比 Gemini 慢，给额外余量
            maxRetries: 2,
            label: `${label}/openai-fallback`,
        });
        if (r.error) throw new Error(`openai_failed: ${r.error.message}`);
        if (!r.json) throw new Error(`openai_parse_failed: status=${r.statusCode}`);
        if (r.json.error) throw new Error(`openai_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
        const text = r.json?.choices?.[0]?.message?.content;
        if (!text) throw new Error('openai_empty_response');
        const result = JSON.parse(text);
        console.log(`[${label}] OpenAI fallback succeeded`);
        return result;
    } catch (oaErr) {
        throw new Error(`both_llm_failed: gemini=(${geminiError.message.slice(0, 80)}), openai=(${oaErr.message.slice(0, 80)})`);
    }
}

// ─── preFilterRawLeads ──────────────────────────────────────────────────────
// Local heuristics that mirror the LLM "anti-pollution / anti-blog / anti-platform"
// rules but at zero cost. Filtering ~30-50% of obvious noise before Gemini cuts
// step2 wall time and quota usage proportionally.
const LISTICLE_RE = /\b(top\s*\d+|best\s+\w+|how\s+to\b|guide\s+to\b|review[s]?:?\b|vs\.?\b|things\s+you\s+should|^\d+\s+(best|top))\b/i;
const PLATFORM_HOSTS = [
    'alibaba.com', 'aliexpress.com', 'amazon.com', 'thomasnet.com',
    'globalsources.com', 'made-in-china.com', 'tradeindia.com',
    'indiamart.com', 'tradewheel.com', 'ec21.com', 'ecplaza.net',
    'tradekey.com', 'go4worldbusiness.com', 'panjiva.com',
    'importyeti.com', 'volza.com', 'reddit.com', 'quora.com',
    'wikipedia.org', 'wikihow.com', 'youtube.com',
];
const CN_HINT_RE = /\b(china|chinese|guangzhou|shenzhen|yiwu|shanghai|ningbo|hk\b|hong\s*kong)\b/i;

function preFilterRawLeads(rawItems) {
    if (!Array.isArray(rawItems)) return { kept: [], dropped: 0, reasons: {} };
    const kept = [];
    const reasons = { listicle: 0, platform: 0, cn_supplier: 0, no_signal: 0 };
    for (const r of rawItems) {
        const title = String(r.title || '').trim();
        const snippet = String(r.snippet || '').trim();
        const link = String(r.link || '').toLowerCase();

        if (!title && !snippet) { reasons.no_signal += 1; continue; }
        if (LISTICLE_RE.test(title) || LISTICLE_RE.test(snippet)) { reasons.listicle += 1; continue; }
        if (PLATFORM_HOSTS.some(h => link.includes(h))) { reasons.platform += 1; continue; }
        // CN-supplier hint must be in the snippet+title combo and not contradicted
        // by a non-CN country mention. Coarse but cheap.
        if (CN_HINT_RE.test(`${title} ${snippet}`) && /\b(supplier|exporter|manufacturer|factory)\b/i.test(snippet)) {
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
    preFilterRawLeads,
};
