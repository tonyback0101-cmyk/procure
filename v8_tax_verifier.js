/**
 * v8_tax_verifier.js
 *
 * 拉美/非洲/东欧 税务/工商注册反向验证模块
 *
 * 核心价值：
 *   V8 抓到的公司名 → 在官方税务/工商数据库交叉印证 → 确认是"合法活跃纳税实体"
 *   验证通过：confidence_score += 35-40 → premium 级线索
 *   验证失败：不降分，但不提升（保留怀疑态度）
 *
 * 使用场景（Step3 之后、Step5 之前）：
 *   node v8_tax_verifier.js "<enriched.json>" "<verified.json>"
 *
 * 重要：本模块为"加分不减分"设计：
 *   - 验证失败 ≠ 公司不存在（可能是 ID 未抓到、格式不符）
 *   - 验证成功 = 确认存在 → 提升置信度
 *   - 所有网络请求设 5s 超时，失败安静跳过（不阻塞主流程）
 */
require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const [inputFile, outputFile] = process.argv.slice(2);
if (!inputFile || !outputFile) {
    console.error('Usage: node v8_tax_verifier.js <input.json> <output.json>');
    process.exit(1);
}

// 验证并发数（税务系统通常不允许高频请求）
const CONCURRENCY     = Math.max(1, Number(process.env.TAX_VERIFY_CONCURRENCY || 3));
const TIMEOUT_MS      = Number(process.env.TAX_VERIFY_TIMEOUT_MS || 5000);
// 未配置则默认不跑（CI/本地测试安全）
const ENABLED         = process.env.TAX_VERIFY_ENABLED === 'true';

// ── 从注册表加载 tax_verify_databases ─────────────────────────────────────
let TAX_DB_MAP = {}; // key: country_code → config
try {
    const reg = JSON.parse(fs.readFileSync('zhimao_verified_source_registry.json', 'utf8'));
    for (const db of (reg.tax_verify_databases?.databases || [])) {
        TAX_DB_MAP[db.country] = db;
    }
} catch (_) {}

// ── 从公司 snippet / domain 中尝试提取税号 ──────────────────────────────────
function extractTaxId(lead, country) {
    const text = [lead.snippet || '', lead.title || '', lead.domain || ''].join(' ');
    switch (country) {
        case 'br': { const m = text.match(/\b\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}\b/); return m ? m[0].replace(/\D/g, '') : null; }
        case 'pe': { const m = text.match(/\bRUC[:\s]+(\d{11})\b/i); return m ? m[1] : null; }
        case 'co': { const m = text.match(/\bNIT[:\s]+([\d\-]+)/i); return m ? m[1].replace(/\D/g, '') : null; }
        case 'cl': { const m = text.match(/\bRUT[:\s]+([\d\.\-kK]+)/i); return m ? m[1] : null; }
        case 'ar': { const m = text.match(/\bCUIT[:\s]+(\d{11})\b/i); return m ? m[1] : null; }
        default:   return null;
    }
}

// ── 简单 HTTP GET，带超时 ─────────────────────────────────────────────────
function httpGet(url) {
    return new Promise(resolve => {
        try {
            const parsed    = new URL(url);
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request({
                hostname: parsed.hostname,
                port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path:     parsed.pathname + (parsed.search || ''),
                method:   'GET',
                headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; ZhimaoBot/1.0)' },
            }, res => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end',  () => resolve({ status: res.statusCode, body }));
            });
            req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
            req.end();
        } catch (_) { resolve(null); }
    });
}

// ── 简单 HTML 响应判断是否"找到"了该公司 ────────────────────────────────────
function looksFound(body, taxId) {
    if (!body || !taxId) return false;
    const b = body.toLowerCase();
    // 通用判断：页面出现了税号本身，且没有明显"not found"特征
    return b.includes(taxId.toLowerCase().slice(0, 8)) &&
           !b.includes('não encontrado') &&
           !b.includes('not found') &&
           !b.includes('no se encontró') &&
           !b.includes('error');
}

// ── 对单个 lead 做税号验证 ────────────────────────────────────────────────
async function verifyOneLead(lead) {
    const country = (lead.country || '').toLowerCase();
    const dbConf  = TAX_DB_MAP[country];
    if (!dbConf) return lead; // 无验证配置，原样返回

    const taxId = extractTaxId(lead, country);
    if (!taxId) return lead; // 无法提取税号，原样返回

    const url = (dbConf.lookup_url || '').replace('${id}', taxId);
    if (!url || url.includes('${')) return lead;

    console.log(`[tax-verify] ${lead.company_name} (${country}) taxId=${taxId} → ${url}`);
    try {
        const res = await httpGet(url);
        if (res && res.status === 200 && looksFound(res.body, taxId)) {
            const boost = dbConf.confidence_boost_on_match || 35;
            const prev  = Number(lead.confidence_score ?? 60);
            const next  = Math.min(100, prev + boost);
            console.log(`[tax-verify] ✓ VERIFIED: ${lead.company_name} confidence ${prev} → ${next} (+${boost})`);
            return {
                ...lead,
                confidence_score:   next,
                tax_verified:        true,
                tax_verify_source:   dbConf.id,
                tax_id:              taxId,
                intent_signal:       lead.intent_signal || 'TAX_VERIFIED',
            };
        }
    } catch (_) {}
    return lead;
}

// ── 限流并发执行 ────────────────────────────────────────────────────────────
async function runWithConcurrency(items, fn, limit) {
    const results = [];
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function run() {
    const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (!ENABLED) {
        console.log('[tax-verify] TAX_VERIFY_ENABLED != true — copying input to output unchanged.');
        fs.writeFileSync(outputFile, JSON.stringify(leads, null, 2));
        return;
    }

    // 只处理有 country 的 leads，且该 country 有验证配置
    const verifiable = leads.filter(l => TAX_DB_MAP[(l.country || '').toLowerCase()]);
    const passthrough = leads.filter(l => !TAX_DB_MAP[(l.country || '').toLowerCase()]);

    console.log(`[tax-verify] ${verifiable.length} verifiable / ${passthrough.length} passthrough (concurrency=${CONCURRENCY})`);

    const verified = await runWithConcurrency(verifiable, verifyOneLead, CONCURRENCY);
    const taxVerifiedCount = verified.filter(l => l.tax_verified).length;

    const output = [...verified, ...passthrough];
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`[tax-verify] done: ${taxVerifiedCount}/${verifiable.length} tax-verified, output=${output.length} leads → ${outputFile}`);
}

run().catch(e => { console.error('[tax-verify] fatal:', e.message); process.exit(1); });
