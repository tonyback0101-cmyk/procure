/**
 * v8_quality_gate.js
 *
 * 与 zhimao/apps/web/lib/data-intel/quality.ts 完全镜像的质量计算模块。
 *
 * 规则双方必须保持一致：
 *   - V8 Step5 用此模块决定哪些线索上传给 zhimao Bulk API
 *   - zhimao Bulk API (route.ts) 调用 computeQualityGrade 决定写入 quality_grade
 *   - zhimao 搜索层 (.neq quality_grade unqualified) 决定哪些可以展示
 *
 * 三档质量：
 *   premium     — 高置信 L3 + 真实联系方式
 *   qualified   — 有真实联系方式，来源为 LLM 推断
 *   unqualified — 无联系方式 / 垃圾源头 / 乱码名称 → 不上传，不消耗配额
 *
 * ⚠️ 每次修改 zhimao/quality.ts 时必须同步更新此文件！
 */

// ── 垃圾域名黑名单（与 zhimao JUNK_DOMAIN_HOSTS 完全一致） ──────────────────
const JUNK_DOMAIN_HOSTS = new Set([
    'scribd.com', 'www.scribd.com',
    'reddit.com', 'www.reddit.com', 'old.reddit.com',
    'quora.com', 'www.quora.com',
    'alibaba.com', 'www.alibaba.com', 'm.alibaba.com',
    'aliexpress.com', 'www.aliexpress.com',
    '1688.com', 'www.1688.com',
    'taobao.com', 'www.taobao.com',
    'jd.com', 'www.jd.com',
    'pinduoduo.com',
    'linkedin.com', 'www.linkedin.com',
    'facebook.com', 'www.facebook.com', 'm.facebook.com',
    'twitter.com', 'www.twitter.com', 'x.com',
    'instagram.com', 'www.instagram.com',
    'youtube.com', 'www.youtube.com',
    'tiktok.com', 'www.tiktok.com',
    'pinterest.com', 'www.pinterest.com',
    'made-in-china.com', 'www.made-in-china.com',
    'globalsources.com', 'www.globalsources.com',
    'tradeindia.com', 'www.tradeindia.com',
    'tradekey.com', 'www.tradekey.com',
    'exportersindia.com', 'www.exportersindia.com',
    'ec21.com', 'www.ec21.com',
    'ecplaza.net', 'www.ecplaza.net',
    'kompass.com', 'www.kompass.com',
    'yellowpages.com', 'www.yellowpages.com',
    'yelp.com', 'www.yelp.com',
    'amazon.com', 'www.amazon.com', 'amazon.co.uk', 'amazon.de',
    'ebay.com', 'www.ebay.com',
    'etsy.com', 'www.etsy.com',
    'shopify.com', 'www.shopify.com',
    'importyeti.com', 'www.importyeti.com',
    'volza.com', 'www.volza.com',
    'panjiva.com', 'www.panjiva.com',
    'tradesparq.com',
    'dungedon.com',
    'bing.com', 'www.bing.com',
    'google.com', 'www.google.com',
    'yahoo.com', 'answers.yahoo.com',
    'wikipedia.org', 'en.wikipedia.org',
    'wikidata.org',
]);

const JUNK_DOMAIN_PATTERNS = [
    /scribd\./i,
    /1688\.com/i,
    /wikip(e|é)dia/i,
    /fandom\.com/i,
    /blogspot\./i,
    /wordpress\.com/i,
    /medium\.com/i,
    /substack\.com/i,
];

/**
 * 域名是否为垃圾来源（与 zhimao isJunkDomain 完全对齐）
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
function isJunkDomain(raw) {
    if (!raw || !raw.trim()) return false;
    const domain = raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*/, '')
        .replace(/:\d+$/, '');
    if (JUNK_DOMAIN_HOSTS.has(domain)) return true;
    if (JUNK_DOMAIN_PATTERNS.some(p => p.test(domain))) return true;
    return false;
}

// ── 垃圾公司名过滤（与 zhimao JUNK_NAME_EXACT + JUNK_NAME_PATTERNS 完全一致） ─
const JUNK_NAME_EXACT = new Set([
    'n/a', 'na', 'unknown', 'none', 'null', 'test', 'demo', 'sample', 'example', '—', '-', 'company',
]);
const JUNK_NAME_PATTERNS = [
    /^\d+$/,                       // 全数字
    /^[^\w\u4e00-\u9fff]{1,}$/,   // 仅标点/符号
    /^\s*$/,                        // 空白
];

/**
 * 公司名是否为垃圾（与 zhimao isJunkName 完全对齐）
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isJunkName(name) {
    if (!name || !name.trim()) return true;
    const n = name.trim();
    if (n.length < 3) return true;
    if (JUNK_NAME_EXACT.has(n.toLowerCase())) return true;
    if (JUNK_NAME_PATTERNS.some(p => p.test(n))) return true;
    return false;
}

/**
 * 计算质量档（与 zhimao computeQualityGrade 完全对齐）
 *
 * @param {{
 *   nameCanonical: string|null|undefined,
 *   domain: string|null|undefined,
 *   primaryEmail: string|null|undefined,
 *   primaryPhone: string|null|undefined,
 *   confidenceTier: string|null|undefined,
 *   hasProcurementItems: boolean|undefined,
 * }} params
 * @returns {'premium'|'qualified'|'unqualified'}
 */
function computeQualityGrade({ nameCanonical, domain, primaryEmail, primaryPhone, confidenceTier, hasProcurementItems }) {
    // 第一关：公司名质量
    if (isJunkName(nameCanonical)) return 'unqualified';

    // 第二关：联系方式是否真实可用
    const domainIsJunk = isJunkDomain(domain);
    const hasRealDomain = Boolean(domain && domain.trim()) && !domainIsJunk;
    const hasEmail = Boolean(primaryEmail && primaryEmail.trim() && primaryEmail.includes('@'));
    const hasPhone = Boolean(primaryPhone && primaryPhone.trim() && primaryPhone.replace(/\D/g, '').length >= 6);
    const hasContact = hasRealDomain || hasEmail || hasPhone;

    if (!hasContact) return 'unqualified';

    // 第三关：L3 推断置信度（有时不存在，跳过）
    if (confidenceTier !== undefined && confidenceTier !== null) {
        if (confidenceTier.toLowerCase() === 'low') return 'unqualified';
        if (hasProcurementItems === false) return 'unqualified';
    }

    // Premium：高置信 L3 + 真实域名或验证邮箱
    if (confidenceTier && confidenceTier.toLowerCase() === 'high' && (hasRealDomain || hasEmail)) return 'premium';

    // Qualified：有联系方式但未达到 premium
    return 'qualified';
}

/**
 * V8 Step5 质量闸：
 * 返回 { qualified: bool, grade: 'premium'|'qualified'|'unqualified' }
 *
 * 只有 grade !== 'unqualified' 的线索才上传给 zhimao Bulk API。
 * 这与 zhimao 搜索层 (.neq quality_grade unqualified) 完全对齐，
 * 避免"上传了但展示不了"的废配额问题。
 *
 * @param {object} lead - V8 enriched lead
 * @returns {{ qualified: boolean, grade: string }}
 */
function evaluateLead(lead) {
    if (!lead || !lead.company_name) return { qualified: false, grade: 'unqualified' };

    const ib = (lead.inference_breakdown && typeof lead.inference_breakdown === 'object')
        ? lead.inference_breakdown
        : null;

    const grade = computeQualityGrade({
        nameCanonical:        lead.company_name,
        domain:               lead.domain          || null,
        primaryEmail:         lead.primary_email   || null,
        primaryPhone:         lead.primary_phone   || null,
        confidenceTier:       ib ? (ib.confidence_tier || null) : undefined,
        hasProcurementItems:  ib ? (Array.isArray(ib.procurement_items) && ib.procurement_items.length >= 1) : undefined,
    });

    return { qualified: grade !== 'unqualified', grade };
}

module.exports = { isJunkDomain, isJunkName, computeQualityGrade, evaluateLead };
