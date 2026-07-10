/**
 * v8_quality_gate.js
 *
 * 与 zhimao/apps/web/lib/data-intel/quality.ts 完全镜像的质量计算模块。
 *
 * 规则双方必须保持一致：
 *   - V8 Step5 用此模块决定哪些线索写入 data_intel_l1_companies（直写模式）
 *   - zhimao 搜索层 (.neq quality_grade unqualified) 决定哪些可以展示
 *
 * 三档质量：
 *   premium     — 高置信 L3 + 真实联系方式（或采购信号 >= 2）
 *   qualified   — 有真实联系方式，来源为 LLM 推断
 *   unqualified — 无联系方式 / 垃圾源头 / 乱码名称 / 业态黑名单 → 不写入，不消耗配额
 *
 * ⚠️ 每次修改 zhimao/quality.ts 时必须同步更新此文件！
 * C3 同步：bizDescription、procurementSignalCount、BIZ_ANTI_PATTERNS、entityType、countryMatchLevel
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
    'foodpanda.sg', 'www.foodpanda.sg', 'foodpanda.com',
    'grab.com', 'www.grab.com',
    'deliveroo.com', 'www.deliveroo.com',
    'grubhub.com', 'www.grubhub.com',
    'lemon8-app.com', 'www.lemon8-app.com',
    'huggingface.co', 'www.huggingface.co',
    'tridge.com', 'www.tridge.com',
    'carousell.com', 'www.carousell.com',
    'shopee.sg', 'www.shopee.sg', 'shopee.com',
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
    // 注意：importyeti / volza / panjiva 不再列入 JUNK，它们是真实进口商目录的强信号源。
    // step1 fromOrganic 会自动把这些站的 link 转为 source_url（不当公司域名），
    // snippet 里的真实买家公司名照常进入 LLM 抽取。详见 SIGNAL_SOURCE_HOSTS。
    'tradesparq.com',
    'dungedon.com',
    'bing.com', 'www.bing.com',
    'google.com', 'www.google.com',
    'yahoo.com', 'answers.yahoo.com',
    'wikipedia.org', 'en.wikipedia.org',
    'wikidata.org',
    // ── 新闻媒体（不是买家）─────────────────────────────────────────────────
    // 新加坡
    'zaobao.com.sg', 'www.zaobao.com.sg', 'zaobao.sg',
    'straitstimes.com', 'www.straitstimes.com',
    'channelnewsasia.com', 'www.channelnewsasia.com',
    'todayonline.com', 'www.todayonline.com',
    'businesstimes.com.sg', 'www.businesstimes.com.sg',
    'mothership.sg', 'www.mothership.sg',
    'stomp.straitstimes.com', 'stomp.com.sg',
    '8world.com', 'www.8world.com',
    'beritaharian.sg', 'www.beritaharian.sg',
    'tamilmurasu.com.sg', 'tnp.sg',
    // 马来西亚
    'thestar.com.my', 'www.thestar.com.my',
    'nst.com.my', 'www.nst.com.my',
    'malaymail.com', 'www.malaymail.com',
    'sinchew.com.my', 'www.sinchew.com.my',
    // 全球媒体
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

const SOCIAL_DOMAIN_HOSTS = new Set([
    'facebook.com', 'www.facebook.com', 'm.facebook.com',
    'instagram.com', 'www.instagram.com',
    'linkedin.com', 'www.linkedin.com',
    'x.com', 'twitter.com', 'www.twitter.com',
    'youtube.com', 'www.youtube.com',
    'tiktok.com', 'www.tiktok.com',
    'pinterest.com', 'www.pinterest.com',
]);
const AGGREGATOR_DOMAIN_HOSTS = new Set([
    'yellowpages.com', 'www.yellowpages.com',
    'yelp.com', 'www.yelp.com',
    'kompass.com', 'www.kompass.com',
    'tradeindia.com', 'www.tradeindia.com',
    'tradekey.com', 'www.tradekey.com',
    'globalsources.com', 'www.globalsources.com',
    'made-in-china.com', 'www.made-in-china.com',
    'ec21.com', 'www.ec21.com',
    'ecplaza.net', 'www.ecplaza.net',
    // 公司目录/评级聚合站：实测 vaneerden.bbb.org 这种被误判 premium
    'bbb.org', 'www.bbb.org',
    'globalimporter.net', 'www.globalimporter.net', 'free.globalimporter.net',
    'thomasnet.com', 'www.thomasnet.com',
    'manta.com', 'www.manta.com',
    'dnb.com', 'www.dnb.com',
    'crunchbase.com', 'www.crunchbase.com',
]);

/**
 * 域名是否为聚合/目录站（公司不在此站持有真实主页，仅被列表收录）。
 * Premium 判定时要求公司有真实主域名，不能仅凭出现在聚合站。
 */
function isAggregatorDomain(raw) {
    if (!raw || !raw.trim()) return false;
    const host = getHost(raw);
    if (!host) return false;
    if (AGGREGATOR_DOMAIN_HOSTS.has(host)) return true;
    // 子域兜底：xxx.bbb.org / free.globalimporter.net 等
    for (const agg of AGGREGATOR_DOMAIN_HOSTS) {
        if (host === agg || host.endsWith('.' + agg)) return true;
    }
    return false;
}
const NEWS_TEXT_RE = /\b(news|press|journal|报道|新闻|专访|记者|通讯社)\b/i;
const SOCIAL_TEXT_RE = /\b(facebook|instagram|linkedin|x\.com|twitter|youtube|tiktok|social)\b/i;

// ── 行业协会 / 会员组织检测（2026-05-26 双仓镜像：zhimao apps/web/lib/data-intel/quality.ts）───
// 三档置信度，防止误杀普通公司名含 "institute" / "council" 的合法买家：
//   HIGH   — 公司名含高置信协会词 → 直接判 aggregator
//   SNIPPET — snippet 明确描述为协会/会员组织 → 判 aggregator
//   MED    — 公司名含中置信协会词 + 辅助信号（.org 域 OR 协会邮箱前缀）才判 aggregator
//
// 故意不包含 council/institute/guild — 这些词可能在普通品牌名里出现（中置信处理）。
const ASSOC_NAME_HIGH_RE =
    /\b(association|associations|federation|federation\s+of|society|societies|chamber\s+of\s+commerce|board\s+of\s+trade|trade\s+body|industry\s+body|member(?:ship)?\s+organization|membership\s+org(?:anization)?)\b/i;

// MEDIUM-confidence：公司名含这些词 → 需辅助信号才判定
const ASSOC_NAME_MED_RE =
    /\b(council|institute|guild|consortium|coalition|alliance|committee|bureau|authority|board\s+of\s+trade)\b/i;

// SNIPPET-level：snippet 明确描述为协会/会员组织
const ASSOC_SNIPPET_RE =
    /\b(trade\s+association|industry\s+association|industry\s+group|trade\s+group|professional\s+association|membership\s+organization|member(?:ship)?\s+body|advocacy\s+group|industry\s+council|trade\s+council|non-?profit\s+trade\s+org|nonprofit\s+industry)\b/i;

// 协会特征邮箱 local-part（用于辅助 MED 信号判定）
const ASSOC_EMAIL_LOCAL_RE = /^(membership|member(?!\.support|\.services)|secretary|secretariat|exec(?:utive)?\.director|exec-director)$/i;

// ── 卖方伪装检测（2026-05-26 双仓镜像：zhimao apps/web/lib/data-intel/quality.ts）───────────
// 设计背景：从中国供应商视角，以下实体不是买家：
//   ① 制造/生产同一品类的企业（本地自产，不向中国采购）
//   ② 货运/物流公司（运货不买货）
//   ③ 市场研究/咨询信息公司（分析不采购）
//
// 两档检测：
//   HIGH  — snippet 第一人称明确声明自己制造/生产（误报率 <3%）
//   MED   — 公司名含明确制造角色词 AND ≥2 个品类关键词共现（双重锁）
//
// ⚠ 不允许仅凭公司名含 "manufacturer" 就判卖方（"Medical Device Manufacturer Supplies" 可能是买家）
// ⚠ "exporter" / "supplier" 不作为卖方信号（美国出口商往往从中国进口后再出口 = 买家）

// HIGH: snippet 第一人称声明自己是制造/生产商
const SELLER_SNIPPET_SELF_DECLARE_RE =
    /\b(we\s+(?:manufacture|produce|fabricate)\b|we\s+are\s+(?:a\s+)?(?:leading\s+)?(?:manufacturer|producer|fabricator)\b|(?:established|founded)\s+(?:in\s+)?\d{4}[,\s]+(?:to\s+)?manufactur\w*|our\s+(?:manufacturing\s+plant|production\s+facility|production\s+line|production\s+base))\b/i;

// MED 第一步：公司名含明确制造/生产角色词（故意排除 exporter/supplier/distributor）
const SELLER_NAME_ROLE_RE =
    /\b(manufacturer|manufacturers|manufacturing|factory|factories|producer|producers|fabricator|fabricators|mill\b|mills\b)\b/i;

// 物流/货运公司检测（精确短语，避免误杀"logistics solutions buyer"）
const LOGISTICS_SPECIFIC_RE =
    /\b(freight\s+forwarder(?:ing)?|customs\s+broker(?:age)?|third.?party\s+logistics|3pl\b|cargo\s+agent|shipping\s+agent)\b/i;

// 信息服务/咨询公司检测（精确短语，避免误杀"market consulting firm buying office products"）
const INFO_SERVICE_SPECIFIC_RE =
    /\b(market\s+research\s+(?:firm|company|group|agency)|industry\s+(?:analyst|analytics)\s+(?:firm|company)|market\s+intelligence\s+(?:firm|company|group))\b/i;

/** 品类关键词提取的英文停用词 */
const CAT_STOP_WORDS = new Set([
    'and', 'the', 'of', 'for', 'in', 'at', 'to', 'a', 'an', 'with', 'by', 'from',
    'or', 'its', 'etc', 'made', 'used', 'use', 'type', 'types', 'grade', 'grades',
]);

/**
 * 从 category 字符串提取有意义的语义词。
 * 支持中英文混合：中文取 2 字以上连续片段，英文取非停用词 + 长度≥3。
 */
function extractCategoryKeywords(category) {
    const zh = (category.match(/[\u4e00-\u9fff]{2,}/g) || []).map(s => s.toLowerCase());
    const en = category
        .toLowerCase()
        .split(/[\s,，、·/\\-]+/)
        .filter(w => w.length >= 3 && !CAT_STOP_WORDS.has(w));
    return [...new Set([...zh, ...en])];
}

/**
 * 判断公司名是否同时包含【制造角色词】AND【≥threshold 个品类关键词】。
 * 双重锁防误杀：光有制造词不够，还需品类词共现确认是同一品类的制造商。
 *
 * 例：
 *   "American Stainless Tableware Manufacturer Inc" + "stainless steel tableware"
 *     → 制造词✓ + stainless/tableware 共现 2 个 → 卖方
 *   "JM Manufacturing Group" + "stainless steel tableware"
 *     → 制造词✓ + 但公司名里无品类词 → 放过（可能是制造业设备买家）
 */
function hasSellerNameCategoryMatch(companyName, category) {
    if (!SELLER_NAME_ROLE_RE.test(companyName)) return false;
    if (!category || !category.trim()) return false;
    const catWords = extractCategoryKeywords(category);
    if (catWords.length === 0) return false;
    const nameLow = companyName.toLowerCase();
    const hits = catWords.filter(w => nameLow.includes(w)).length;
    const threshold = Math.min(2, catWords.length);
    return hits >= threshold;
}

// 国家识别（轻量版，避免引入重依赖）
const COUNTRY_HINTS = {
    US: ['united states', 'usa', 'america', '美国'],
    CN: ['china', 'prc', 'chinese', '中国'],
    SG: ['singapore', '新加坡'],
    MY: ['malaysia', '马来西亚'],
    TH: ['thailand', '泰国'],
    VN: ['vietnam', '越南'],
    ID: ['indonesia', '印尼', '印度尼西亚'],
    PH: ['philippines', '菲律宾'],
    JP: ['japan', '日本'],
    KR: ['south korea', 'korea', '韩国'],
    GB: ['united kingdom', 'uk', 'britain', '英国'],
    DE: ['germany', '德国'],
    FR: ['france', '法国'],
    IT: ['italy', '意大利'],
    ES: ['spain', '西班牙'],
    CA: ['canada', '加拿大'],
    AU: ['australia', '澳大利亚', '澳洲'],
    CH: ['switzerland', 'swiss', '瑞士'],
    BR: ['brazil', '巴西'],
    IN: ['india', '印度'],
    TR: ['turkey', '土耳其'],
    AE: ['uae', 'united arab emirates', '阿联酋'],
    SA: ['saudi arabia', '沙特'],
};
const CCTLD_TO_ISO = {
    us: 'US', cn: 'CN', sg: 'SG', my: 'MY', th: 'TH', vn: 'VN', id: 'ID', ph: 'PH',
    jp: 'JP', kr: 'KR', uk: 'GB', gb: 'GB', de: 'DE', fr: 'FR', it: 'IT', es: 'ES',
    ca: 'CA', au: 'AU', ch: 'CH', br: 'BR', in: 'IN', tr: 'TR', ae: 'AE', sa: 'SA',
};
const CALLING_CODE_TO_ISO = {
    '1': 'US', '86': 'CN', '65': 'SG', '60': 'MY', '66': 'TH', '84': 'VN', '62': 'ID',
    '63': 'PH', '81': 'JP', '82': 'KR', '44': 'GB', '49': 'DE', '33': 'FR', '39': 'IT',
    '34': 'ES', '61': 'AU', '41': 'CH', '55': 'BR', '91': 'IN', '90': 'TR', '971': 'AE', '966': 'SA',
};

// CJK + 地址关键字拦截（与 zhimao quality.ts 对齐）：V8 pipeline 可能把实际地址写入 domain 字段
const CJK_RANGE_RE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
const ADDR_KEYWORD_RE = /[号街路道楼室层区市省镇村]/u;

/**
 * 域名是否为垃圾来源（与 zhimao quality.ts isJunkDomain 完全对齐）
 * 额外规则（相较旧版本补齐）：
 *   1. 含 CJK 字符 → 地址被误写入 domain 字段
 *   2. 含中文地址关键字（号/街/路/楼/室...）
 *   3. 超长 punycode 标签（xn-- 前缀且 >30 字符 = 被编码的中文地址）
 *   4. 无 TLD（不含点 = 不是域名）
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
function isJunkDomain(raw) {
    if (!raw || !raw.trim()) return false;
    // 快速拒绝：原始字符串含 CJK 字符（中文地址直接写入了 domain 字段）
    if (CJK_RANGE_RE.test(raw)) return true;
    // 快速拒绝：含常见中文地址关键字
    if (ADDR_KEYWORD_RE.test(raw)) return true;

    const domain = raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*/, '')
        .replace(/:\d+$/, '');
    if (JUNK_DOMAIN_HOSTS.has(domain)) return true;
    if (JUNK_DOMAIN_PATTERNS.some(p => p.test(domain))) return true;

    // 拒绝超长 punycode 标签（xn-- 且 >30 字符 = 被编码的非 ASCII 地址，如山东省青岛市...）
    const labels = domain.split('.');
    if (labels.some(l => l.startsWith('xn--') && l.length > 30)) return true;
    // 拒绝没有 TLD 的单标签字符串（不含点 = 不是域名）
    if (!domain.includes('.')) return true;

    return false;
}

function getHost(raw) {
    if (!raw || !raw.trim()) return '';
    try {
        const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase();
        return host.replace(/^www\./, '');
    } catch {
        return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
}

/**
 * @updated 2026-05-26 A：新增行业协会/会员组织检测（三档置信度）。
 * @updated 2026-05-26 B：新增卖方伪装检测（制造商/物流/信息服务）。
 * 双仓同步：zhimao 仓 apps/web/lib/data-intel/quality.ts inferEntityType（AGENTS.md 镜像约定）。
 *
 * @param {object} params
 * @param {string} [params.domain]
 * @param {string} [params.snippet]
 * @param {string} [params.companyName]
 * @param {string} [params.primaryEmail] — 可选：辅助 MED 协会判定（local-part 比对 ASSOC_EMAIL_LOCAL_RE）
 * @param {string} [params.category]    — 可选：搜索品类，用于卖方 MED 档双重锁检测
 */
function inferEntityType({ domain, snippet, companyName, primaryEmail, category, supplierMode }) {
    const host = getHost(domain);
    const name = companyName || '';
    const snip = snippet || '';
    const text = `${snip} ${name}`.toLowerCase();

    // 1. 社交媒体平台主页
    if (SOCIAL_DOMAIN_HOSTS.has(host) || SOCIAL_TEXT_RE.test(text)) return 'social';

    // 2. 已知聚合/目录站域名（子域兜底）
    if (isAggregatorDomain(domain)) return 'aggregator';

    // 3. 行业协会 / 会员组织检测（三档）
    //    3a. HIGH: 公司名含高置信协会词 → 直接判 aggregator
    if (ASSOC_NAME_HIGH_RE.test(name)) return 'aggregator';

    //    3b. SNIPPET: snippet 明确说是行业协会 → 判 aggregator
    if (ASSOC_SNIPPET_RE.test(snip)) return 'aggregator';

    //    3c. MED: 公司名含中置信协会词 + 辅助信号（.org 域 OR 协会邮箱前缀）
    if (ASSOC_NAME_MED_RE.test(name)) {
        const hasOrgDomain = host.endsWith('.org');
        const emailLocal = (primaryEmail || '').split('@')[0].toLowerCase();
        const hasMembershipEmail = emailLocal.length > 0 && ASSOC_EMAIL_LOCAL_RE.test(emailLocal);
        if (hasOrgDomain || hasMembershipEmail) return 'aggregator';
    }

    // 4. 卖方伪装检测（制造商、货运、信息服务）
    //    ⚠ 4a/4b 是「找买家」方向专属过滤：把自称制造商/生产商的卖家剔除出买家池。
    //    供应商模式（find_suppliers）下我们正想要这些制造商/工厂/出口商，必须跳过，
    //    否则 evaluateLeadSupplier 委托 evaluateLead 时会把目标供应商误判为 aggregator。
    if (!supplierMode) {
        //    4a. HIGH: snippet 第一人称声明自己是制造/生产商（不需要 category）
        if (SELLER_SNIPPET_SELF_DECLARE_RE.test(snip)) return 'aggregator';

        //    4b. MED: 公司名含制造角色词 + ≥2 个品类关键词共现（需 category 联动）
        if (hasSellerNameCategoryMatch(name, category || null)) return 'aggregator';
    }

    //    4c. 精确物流商（"freight forwarder" / "customs broker" 等精确短语）
    if (LOGISTICS_SPECIFIC_RE.test(name) || LOGISTICS_SPECIFIC_RE.test(snip)) return 'aggregator';

    //    4d. 精确市场研究/信息服务公司
    if (INFO_SERVICE_SPECIFIC_RE.test(name) || INFO_SERVICE_SPECIFIC_RE.test(snip)) return 'aggregator';

    // 5. 新闻/媒体
    if (NEWS_TEXT_RE.test(text)) return 'media';

    return 'company';
}

function extractPhoneCountry(phone) {
    if (!phone || typeof phone !== 'string') return null;
    const m = phone.trim().match(/^\+(\d{1,3})/);
    if (!m) return null;
    return CALLING_CODE_TO_ISO[m[1]] || null;
}

function inferIsoFromDomain(domain) {
    const host = getHost(domain);
    if (!host || !host.includes('.')) return null;
    const suffix = host.split('.').pop();
    if (!suffix) return null;
    return CCTLD_TO_ISO[suffix] || null;
}

function assessCountryMatchLevel({ targetCountry, text, domain, phone }) {
    const target = String(targetCountry || '').toUpperCase();
    if (!target || target.length !== 2) return 'medium';
    const hay = String(text || '').toLowerCase();
    let positive = 0;
    let negative = 0;

    const targetHints = COUNTRY_HINTS[target] || [];
    if (targetHints.some(h => hay.includes(h.toLowerCase()))) positive += 1;

    for (const [iso, hints] of Object.entries(COUNTRY_HINTS)) {
        if (iso === target) continue;
        if (hints.some(h => hay.includes(h.toLowerCase()))) {
            negative += 1;
            break;
        }
    }

    const domainIso = inferIsoFromDomain(domain);
    if (domainIso) {
        if (domainIso === target) positive += 1;
        else negative += 1;
    }
    const phoneIso = extractPhoneCountry(phone);
    if (phoneIso) {
        if (phoneIso === target) positive += 1;
        else negative += 1;
    }

    if (negative >= 2) return 'low';
    if (positive >= 2 && negative === 0) return 'high';
    return 'medium';
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

// ── 业态黑名单（C3 同步：解决餐厅/医院/政府机关误进 L1 问题） ────────────────
// ── 业态黑名单（C3：解决麦当劳/包装厂/政府机关误进 L1 问题） ──────────────────
//
// 2026-05-23 升级：按 category 动态豁免（双仓镜像，见 zhimao AGENTS.md "CATEGORY_B2C_WHITELIST 双仓镜像"段）。
// 旧实现一刀切 — 任何 lead 名字含 bakery / restaurant / salon 都被毙，但**面粉**类目下面包房恰恰是
// 真买家、**化妆品原料**类目下美容沙龙是真买家、**酒店用品**类目下酒店是真买家。
// 新实现把 9 组 B2C 业态命名分组，再用 CATEGORY_B2C_WHITELIST 把"类目 → 允许通过的 group 列表"
// 显式登记；evaluateLead / computeQualityGrade 调用时透传 category（来自 DISCOVERY_CATEGORY env）。
//
// 单源 + 镜像：本文件 ↔ zhimao apps/web/lib/data-intel/quality.ts。任何分组 / 关键词变更两仓必须同步。

const BIZ_ANTI_GROUPS = [
    ['fastfood_chain', /\b(mcdonald|kfc|starbucks|subway|burger.king|pizza.hut|domino|wendy|taco.bell)\b/i],
    ['food_service',   /\b(restaurant|cafe|coffee\s+shop|fast[_\s]food|food.chain|bistro|bakery|eatery|diner)\b/i],
    ['hospitality',    /\b(hotel|motel|hostel|inn\b|resort|lodge|accommodation)\b/i],
    ['healthcare',     /\b(hospital|clinic|dental|medical.center|pharmacy|dispensary|healthcare.provider)\b/i],
    ['education',      /\b(primary.school|secondary.school|university|college|academy\b|kindergarten|tuition)\b/i],
    ['finance_legal',  /\b(bank\b|insurance\s+company|financial\s+service|accounting\s+firm|law\s+firm)\b/i],
    ['government',     /\b(government|municipality|ministry|prefecture|public\s+sector|city.council|town.hall)\b/i],
    ['nonprofit',      /\b(charity|ngo\b|nonprofit|non-profit|foundation\b)\b/i],
    ['beauty_fitness', /\b(salon|barbershop|spa\b|beauty.center|nail.studio|massage.parlor|gym\b|fitness.center)\b/i],
];

const CATEGORY_B2C_WHITELIST = [
    // 食材 / 烘焙原料 / 调料 → 餐饮全行业是真买家（含连锁餐饮）
    {
        match: /(\bflour\b|\bbread\b|\bpastry\b|\bbaking\b|bakery.ingredient|food.ingredient|\bspice\b|\bseasoning\b|\bsauce\b|\bcondiment\b|\bdairy\b|烘焙|面粉|面包|糕点|食材|食品配料|调料|乳制品)/i,
        allow: ['food_service', 'fastfood_chain', 'hospitality'],
        note: '面粉/调料 → 餐饮+酒店+连锁',
    },
    // 海鲜 / 肉类 / 农产品 → 餐饮 + 酒店 + 连锁
    {
        match: /(\bseafood\b|\bmeat\b|\bpoultry\b|\bbeef\b|\bpork\b|\bchicken\b|\bfish\b|\bvegetable\b|\bfruit\b|\bproduce\b|\bgrain\b|\brice\b|\bcucumber\b|海鲜|肉类|蔬菜|水果|农产品|生鲜|大米|稻米|黄瓜|青瓜|白菜)/i,
        allow: ['food_service', 'fastfood_chain', 'hospitality'],
        note: '肉类/海鲜/果蔬 → 餐饮+酒店+连锁',
    },
    // 咖啡豆 / 茶叶 / 饮品原料 → 餐饮 + 酒店 + 连锁
    {
        match: /(coffee.bean|coffee.roast|\btea\b|\bbeverage\b|\bdrink\b|\bjuice\b|\bwater\b|咖啡豆|茶叶|饮品|饮料|矿泉水)/i,
        allow: ['food_service', 'fastfood_chain', 'hospitality'],
        note: '饮品原料 → 餐饮+酒店+连锁',
    },
    // 化妆品 / 美容用品原料 → 美容沙龙是真买家
    {
        match: /(\bcosmetic\b|\bskincare\b|skin.care|beauty.product|\bhaircare\b|hair.care|nail.polish|essential.oil|\bperfume\b|\bfragrance\b|化妆品|美容|护肤|香精|精油|香水|彩妆|美甲)/i,
        allow: ['beauty_fitness'],
        note: '化妆品原料 → 美容/沙龙/spa',
    },
    // 医疗器械 / 药品 / 牙科耗材 → 医疗机构是真买家
    {
        match: /(medical.device|medical.equipment|medical.supply|medical.consumable|\bpharmaceutical\b|pharma.ingredient|api\b|\bdrug\b|dental.supply|dental.equipment|hospital.supply|surgical|医疗器械|医疗设备|医用耗材|药品|医药|牙科|手术|诊所设备)/i,
        allow: ['healthcare'],
        note: '医疗器械/药品/牙科 → 医院/诊所/药房',
    },
    // 教学设备 / 课桌椅 / 教材 → 学校是真买家
    {
        match: /(school.supply|\bclassroom\b|education.equipment|\btextbook\b|teaching.aid|教学设备|课桌|教材|文具|学习用品|学校设备|教学仪器)/i,
        allow: ['education'],
        note: '教学用品 → 学校/学院',
    },
    // 酒店用品 / 床上用品 / 客房一次性 → 酒店是真买家
    {
        match: /(hotel.supply|\bamenity\b|amenities|\btowel\b|\blinen\b|hospitality.supply|\bhousekeeping\b|\bmattress\b|guest.room|酒店用品|客房用品|布草|一次性用品|床品|客房备品|酒店家具)/i,
        allow: ['hospitality'],
        note: '酒店用品 → 酒店/民宿/度假村',
    },
    // 健身器材 → 健身房是真买家
    {
        match: /(gym.equipment|fitness.equipment|\btreadmill\b|\bdumbbell\b|\bbarbell\b|exercise.machine|sports.equipment|健身器材|运动器材|健身房设备)/i,
        allow: ['beauty_fitness'],
        note: '健身器材 → 健身房/spa',
    },
    // 办公用品 / 文具 / 通用耗材 → 律所/教育/政府/非盈利都是真买家
    {
        match: /(office.supply|\bstationery\b|\btoner\b|\bcartridge\b|copier.paper|file.cabinet|文具|办公用品|纸张|耗材|办公耗材|打印纸)/i,
        allow: ['finance_legal', 'education', 'government', 'nonprofit'],
        note: '通用办公耗材 → 律所/学校/政府/NGO 都买',
    },
    // 金融 / 法务 SaaS / 银行系统 → 银行 / 保险 / 律所是真买家
    {
        match: /(banking.software|\bfintech\b|accounting.software|legal.tech|律所软件|银行系统|金融科技|金融软件|法务系统)/i,
        allow: ['finance_legal'],
        note: '金融/法务系统 → 银行/保险/律所',
    },
    // 政府采购 / 公共项目用品 → 政府部门是真买家
    {
        match: /(government.procurement|public.tender|公共采购|政府采购|公务用品|政务系统)/i,
        allow: ['government'],
        note: '政府专项采购 → 政府部门',
    },
    // 公益 / NGO 物资 → 慈善 / NGO 是真买家
    {
        match: /(charity.supply|disaster.relief|humanitarian.aid|慈善物资|救灾物资|人道援助)/i,
        allow: ['nonprofit'],
        note: '公益物资 → 慈善/NGO',
    },
];

/** 给定 category 返回应豁免的 B2C group 名集合。无 category 或无匹配 → 空集合（一刀切）。 */
function resolveB2CWhitelistGroups(category) {
    const allowed = new Set();
    if (!category || typeof category !== 'string' || !category.trim()) return allowed;
    const c = category.trim();
    for (const rule of CATEGORY_B2C_WHITELIST) {
        if (rule.match.test(c)) {
            for (const g of rule.allow) allowed.add(g);
        }
    }
    return allowed;
}

/**
 * 判断公司名/描述是否属于"非采购买家"业态（与 zhimao isBizTypeBlacklisted 双仓镜像）
 * @param {string|null|undefined} nameOrDesc — 公司名 / 业务描述
 * @param {string|null|undefined} [category] — 任务 category（如 'flour' / '面粉'），用于豁免对应 B2C
 * @returns {boolean}
 */
function isBizTypeBlacklisted(nameOrDesc, category) {
    if (!nameOrDesc || !nameOrDesc.trim()) return false;
    const allowed = resolveB2CWhitelistGroups(category);
    for (const [group, re] of BIZ_ANTI_GROUPS) {
        if (allowed.has(group)) continue;
        if (re.test(nameOrDesc)) return true;
    }
    return false;
}

/**
 * 计算质量档（与 zhimao computeQualityGrade 完全对齐，含 C3 升级）
 *
 * @param {{
 *   nameCanonical: string|null|undefined,
 *   domain: string|null|undefined,
 *   primaryEmail: string|null|undefined,
 *   primaryPhone: string|null|undefined,
 *   confidenceTier: string|null|undefined,
 *   hasProcurementItems: boolean|undefined,
 *   entityType: string|null|undefined,
 *   countryMatchLevel: string|null|undefined,
 *   bizDescription: string|null|undefined,
 *   procurementSignalCount: number,
 *   category: string|null|undefined,
 * }} params
 * @returns {'premium'|'qualified'|'unqualified'}
 */
function computeQualityGrade({
    nameCanonical,
    domain,
    primaryEmail,
    primaryPhone,
    confidenceTier,
    hasProcurementItems,
    entityType,
    countryMatchLevel,
    bizDescription,
    procurementSignalCount = 0,
    category,
}) {
    // 第一关：公司名质量
    if (isJunkName(nameCanonical)) return 'unqualified';
    if (entityType && entityType !== 'company') return 'unqualified';
    if (countryMatchLevel === 'low') return 'unqualified';

    // C3 第一关补充：业态黑名单（餐厅/医院/政府 等不可能是采购买家）
    // 2026-05-23：传 category 启用 CATEGORY_B2C_WHITELIST，面粉→bakery / 化妆品→spa 等真买家不再被一刀切
    if (isBizTypeBlacklisted(bizDescription != null ? bizDescription : nameCanonical, category)) return 'unqualified';

    // 第二关：联系方式是否真实可用
    const domainIsJunk = isJunkDomain(domain);
    const hasRealDomain = Boolean(domain && domain.trim()) && !domainIsJunk;
    const hasEmail = Boolean(primaryEmail && primaryEmail.trim() && primaryEmail.includes('@'));
    const hasPhone = Boolean(primaryPhone && primaryPhone.trim() && primaryPhone.replace(/\D/g, '').length >= 6);
    const hasContact = hasRealDomain || hasEmail || hasPhone;

    // ── 根切修改（2026-05-20）─────────────────────────────────────────
    // 旧规则："hasContact || procurementSignalCount > 0" → 只要有任何信号就放过 contact 全空的行
    //         → 用户看到"信息薄 0 + 优质 30 分"的欺骗卡
    // 新规则：**必须 hasContact 才能 qualified/premium**。
    //   - 配合 v8_lib_contact_enricher.js 的 5 层兜底（首页→代理→BFS→LLM→Serper），
    //     真实可触达的公司应当能 95%+ 抓到至少一个 contact 字段。
    //   - 抓不到的 → unqualified 不进 L1，不污染 zhimao 买家池。
    //   - procurementSignalCount 仍参与 premium 升级判定（C3 信号 ≥2 + 主域名 → premium），
    //     但**不再当作放过 contact 缺失的免死金牌**。
    if (!hasContact) return 'unqualified';

    // 第三关：L3 推断置信度（有时不存在，跳过）
    if (confidenceTier !== undefined && confidenceTier !== null) {
        if (confidenceTier.toLowerCase() === 'low') return 'unqualified';
        if (hasProcurementItems === false) return 'unqualified';
    }

    // Premium 升级要求：必须有公司主域名（非聚合/目录站如 bbb.org / globalimporter.net）。
    // 实测 vaneerden 域名是 bbb.org（评级聚合站）被误判 premium——聚合站只能证明公司
    // 出现在目录里，不能证明它是高质量买家主体。
    const hasOwnedDomain = hasRealDomain && !isAggregatorDomain(domain);

    // C3 Premium 升级：有采购信号 + 公司主域名 → premium（进口证据/招聘信号 = 确定性买家）
    if (procurementSignalCount >= 2 && hasOwnedDomain) return 'premium';

    // Premium：高置信 L3 + 公司主域名或验证邮箱
    if (confidenceTier && confidenceTier.toLowerCase() === 'high' && (hasOwnedDomain || hasEmail)) return 'premium';

    // Qualified：有联系方式但未达到 premium
    return 'qualified';
}

// ── 已结业/停止营业检测 ─────────────────────────────────────────────────────
// bug 修复：旧 regex 用 `permanently\s+clos\b` —— `\b` 在 `clos|e` 之间不是词边界
// （e 是词字符），导致最常见的 "permanently closed" 永远匹配不到 → CLOSED_BIZ 自检从来没生效。
// 现把所有 `clos` / `operat` / `liquidat` 等截断动词词根改为带 `\w*` 后缀，
// 兼容 closed / closing / operated / liquidated 等屈折变体。
const CLOSED_BIZ_RE = /(permanently\s+clos\w*|closed\s+down|ceased\s+operat\w*|no\s+longer\s+operat\w*|out\s+of\s+business|went\s+bankrupt|liquidat\w*|already\s+clos\w*|has\s+clos\w*|have\s+clos\w*|已结业|已停业|停止营业|结业清货|倒闭|停办|已停止营业|停业了|不再营业)/i;

/**
 * snippet/summary 是否含结业信号
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function isClosedBusiness(text) {
    if (!text) return false;
    return CLOSED_BIZ_RE.test(text);
}

/**
 * V8 Step5 质量闸：
 * 返回 { qualified: bool, grade: 'premium'|'qualified'|'unqualified', reason?: string }
 *
 * 只有 grade !== 'unqualified' 的线索才上传给 zhimao Bulk API。
 * 这与 zhimao 搜索层 (.neq quality_grade unqualified) 完全对齐，
 * 避免"上传了但展示不了"的废配额问题。
 *
 * @param {object} lead - V8 enriched lead
 * @returns {{ qualified: boolean, grade: string, reason?: string }}
 */
/**
 * 从 V8 lead 推断采购信号数量（与 zhimao C3 procurementSignalCount 语义对齐）：
 *   BOL_SIGNAL / CUSTOMS_SIGNAL / PROCUREMENT_DECISION_MAKER / IMPORT_RECORD：各计 1
 *   tax_verified：+1
 *   verified_source_id（已验证来源）：+1
 * @param {object} lead
 * @returns {number}
 */
function inferProcurementSignalCount(lead) {
    let count = 0;
    const sig = String(lead.intent_signal || '').toUpperCase();
    if (sig === 'BOL_SIGNAL' || sig === 'CUSTOMS_SIGNAL' || sig === 'IMPORT_RECORD') count += 1;
    if (sig === 'PROCUREMENT_DECISION_MAKER') count += 1;
    if (lead.tax_verified) count += 1;
    if (lead.verified_source_id) count += 1;
    // 来自 inference_breakdown 的 reason_codes
    const ib = lead.inference_breakdown;
    if (ib && Array.isArray(ib.reason_codes)) {
        const codes = ib.reason_codes.map(c => String(c).toUpperCase());
        if (codes.some(c => c.includes('IMPORT') || c.includes('BOL') || c.includes('CUSTOMS'))) count += 1;
    }
    return Math.min(count, 5);
}

/**
 * 所有 unqualified 的精确 reason 枚举。
 * 运维 / 矩阵 dashboard 可按 reason 分组统计 worker 拒绝分布。
 *
 * 用于 metric 上报（每个 V8 跑批结束后聚合）：
 *   reason -> count -> 占比；以便发现某天突涨某 reason 时定位上游问题。
 */
const REJECT_REASONS = Object.freeze({
    NO_COMPANY_NAME:       'no_company_name',
    JUNK_NAME:             'junk_name',
    JUNK_DOMAIN:           'junk_domain',
    CLOSED_BUSINESS:       'closed_business',
    COUNTRY_MISMATCH:      'country_mismatch',
    ENTITY_TYPE_SOCIAL:    'entity_type_social',
    ENTITY_TYPE_MEDIA:     'entity_type_media',
    ENTITY_TYPE_AGGREGATOR:'entity_type_aggregator',
    BIZ_TYPE_BLACKLISTED:  'biz_type_blacklisted',
    NO_CONTACT:            'no_contact',
    // 2026-05-23 新增邮箱质量类（双仓镜像，见 v8_lib_email_quality.js）：
    //   解决 5 层 enricher 抓回 chairman@sec.gov / support@bebee.com / jane.doe@... 这种
    //   非买家邮箱时，旧规则只看 lead.domain 漏放过的根切问题
    PLACEHOLDER_EMAIL:     'placeholder_email',     // jane.doe@ / email@address.com / example@…
    AGGREGATOR_EMAIL:      'aggregator_email',      // 邮箱 host ∈ NON_BUYER_EMAIL_HOSTS（招聘/媒体/政府/数据库）
    EMAIL_BRAND_MISMATCH:  'email_brand_mismatch',  // 邮箱 host 与 lead.domain 主域不匹配且非免费邮箱
    CONFIDENCE_LOW:        'confidence_low',
    NO_PROCUREMENT_ITEMS:  'no_procurement_items',
});

/**
 * @param {object} lead — 完整 lead 行（含 company_name / domain / primary_email / ...）
 * @param {{ category?: string|null }} [opts] — 上下文。category 来自 DISCOVERY_CATEGORY，
 *   用于 B 段业态黑名单的 CATEGORY_B2C_WHITELIST 动态豁免（面粉→bakery / 化妆品→spa 真买家不再被一刀切）。
 *   省略则保持旧行为（一刀切）。
 */
function evaluateLead(lead, opts) {
    const category = opts && opts.category != null ? String(opts.category) : null;
    // supplierMode：find_suppliers 方向下跳过 inferEntityType 的卖方伪装降级（4a/4b），
    // 因为制造商/工厂/出口商正是目标，不应被当 aggregator 剔除。
    const supplierMode = Boolean(opts && opts.supplierMode);

    // ─── A 公司名级 ────────────────────────────────────────────────────
    if (!lead || !lead.company_name) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.NO_COMPANY_NAME };
    }
    if (isJunkName(lead.company_name)) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.JUNK_NAME };
    }

    const snippetText = [
        lead.snippet,
        lead.profile_payload_json?.snippet,
        lead.intent_summary,
        lead.intent_summary_zh,
    ].filter(Boolean).join(' ');

    // ─── B 业态级 ──────────────────────────────────────────────────────
    // 2026-05-23：传 category 启用 CATEGORY_B2C_WHITELIST，面粉→bakery / 化妆品→spa 等真买家放过
    if (isBizTypeBlacklisted(lead.company_name, category)) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.BIZ_TYPE_BLACKLISTED };
    }

    // ─── C 实体类型级（先于 junk_domain：social/aggregator 是更精确的语义判定，
    //                  facebook.com / instagram.com / foo.bbb.org 这种应该报 social/aggregator
    //                  而非更宽泛的 junk_domain）─────────────────────────
    const entityType = inferEntityType({
        domain: lead.domain,
        snippet: snippetText,
        companyName: lead.company_name,
        primaryEmail: lead.primary_email || null,
        category: category || null,
        supplierMode,
    });
    if (entityType === 'social') {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.ENTITY_TYPE_SOCIAL };
    }
    if (entityType === 'media') {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.ENTITY_TYPE_MEDIA };
    }
    if (entityType === 'aggregator') {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.ENTITY_TYPE_AGGREGATOR };
    }

    // ─── D 域名级（兜底）──────────────────────────────────────────────
    if (lead.domain && isJunkDomain(lead.domain)) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.JUNK_DOMAIN };
    }

    // ─── E 已结业 ──────────────────────────────────────────────────────
    if (isClosedBusiness(snippetText)) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.CLOSED_BUSINESS };
    }

    // ─── F 国家级 ──────────────────────────────────────────────────────
    const countryMatch = assessCountryMatchLevel({
        targetCountry: lead.country,
        text: snippetText,
        domain: lead.domain,
        phone: lead.primary_phone,
    });
    if (countryMatch === 'low') {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.COUNTRY_MISMATCH };
    }

    // ─── G 联系方式级（根切：!hasContact 一律 unqualified） ─────────────
    // 2026-05-23 双仓镜像加：先用 v8_lib_email_quality.isBuyerEmail 把 primary_email
    // 做一次"买家邮箱"复查 — placeholder/aggregator/brand-mismatch 三类直接返回
    // 对应 reject reason，避免它们伪装成 hasContact 通过 G 闸继续走 H 段。
    const { isBuyerEmail } = require('./v8_lib_email_quality');
    const domainIsJunk = isJunkDomain(lead.domain);
    const hasRealDomain = Boolean(lead.domain && String(lead.domain).trim()) && !domainIsJunk;
    const rawEmail = lead.primary_email ? String(lead.primary_email).trim() : '';
    let hasEmail = false;
    if (rawEmail && rawEmail.includes('@')) {
        const verdict = isBuyerEmail(rawEmail, lead.domain || null);
        if (!verdict.ok) {
            // 注意：不直接返回 reject reason — 因为可能 phone 仍然可触达。先把 hasEmail 置 false，
            // 再走下面 hasContact 兜底；只有"邮箱被毙 + 无其他联系方式"才用具体 email reason。
            hasEmail = false;
            // 仅在 phone+domain 都不可用时才用具体 email reason 替代 NO_CONTACT
            const phoneFallback = Boolean(rawEmail && String(lead.primary_phone || '').trim() && String(lead.primary_phone).replace(/\D/g, '').length >= 6);
            if (!hasRealDomain && !phoneFallback) {
                const reasonMap = {
                    placeholder_email:    REJECT_REASONS.PLACEHOLDER_EMAIL,
                    aggregator_email:     REJECT_REASONS.AGGREGATOR_EMAIL,
                    brand_mismatch:       REJECT_REASONS.EMAIL_BRAND_MISMATCH,
                    invalid_format:       REJECT_REASONS.NO_CONTACT,
                };
                const r = reasonMap[verdict.reason] || REJECT_REASONS.NO_CONTACT;
                return { qualified: false, grade: 'unqualified', reason: r };
            }
        } else {
            hasEmail = true;
        }
    }
    const hasPhone = Boolean(lead.primary_phone && String(lead.primary_phone).trim() && String(lead.primary_phone).replace(/\D/g, '').length >= 6);
    const hasContact = hasRealDomain || hasEmail || hasPhone;
    if (!hasContact) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.NO_CONTACT };
    }

    // ─── H L3 推断级 ──────────────────────────────────────────────────
    const ib = (lead.inference_breakdown && typeof lead.inference_breakdown === 'object')
        ? lead.inference_breakdown
        : null;
    if (ib && ib.confidence_tier && String(ib.confidence_tier).toLowerCase() === 'low') {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.CONFIDENCE_LOW };
    }
    if (ib && ib.confidence_tier && Array.isArray(ib.procurement_items) && ib.procurement_items.length === 0) {
        return { qualified: false, grade: 'unqualified', reason: REJECT_REASONS.NO_PROCUREMENT_ITEMS };
    }

    // ─── I 走到这里 = qualified 或 premium，交由 computeQualityGrade 升级判断 ─
    const procurementSignalCount = inferProcurementSignalCount(lead);
    const grade = computeQualityGrade({
        nameCanonical:           lead.company_name,
        domain:                  lead.domain          || null,
        primaryEmail:            lead.primary_email   || null,
        primaryPhone:            lead.primary_phone   || null,
        confidenceTier:          ib ? (ib.confidence_tier || null) : undefined,
        hasProcurementItems:     ib ? (Array.isArray(ib.procurement_items) && ib.procurement_items.length >= 1) : undefined,
        entityType:              entityType,
        countryMatchLevel:       countryMatch,
        bizDescription:          lead.company_name,
        procurementSignalCount:  procurementSignalCount,
        category:                category,
    });

    // 兜底：computeQualityGrade 仍可能返回 unqualified（如 confidenceTier=low + hasProcurementItems=false 等
    // 已被前面捕获的组合）。此处不应触发，但保留兜底 reason 以便发现规则漂移。
    if (grade === 'unqualified') {
        return { qualified: false, grade: 'unqualified', reason: 'compute_grade_unqualified' };
    }
    return { qualified: true, grade };
}

/**
 * P6 方向感知评分 — 供应商模式。
 *
 * 在 find_suppliers 方向下：
 *   - "aggregator" 实体中，制造商/出口商/工厂域名 NOT unqualified（它们就是目标供应商）
 *   - "aggregator" 中，行业协会/B2B 目录 仍然 unqualified
 *   - 卖方自我声明关键词（manufacturer / exporter / factory / 制造 / 工厂）被视为 positive signal
 *
 * 此函数是 evaluateLead 的前置钩子，供 step5 直接调用。
 * 不修改 evaluateLead 主函数，保持 find_buyers 路径不变。
 *
 * @param {object} lead       - 与 evaluateLead 入参格式一致
 * @param {string} category   - 品类词
 * @param {string[]} [negativeKeywords] - ICP 负向关键词列表（已小写）
 * @returns {{ qualified: boolean, grade: string, reason: string }}
 */
function evaluateLeadSupplier(lead, category, negativeKeywords) {
    // ── 负向关键词拦截（买家/供应商方向通用） ─────────────────────────────────
    if (negativeKeywords && negativeKeywords.length > 0) {
        const hay = `${String(lead.company_name || '')} ${String(lead.description || lead.snippet || '')}`.toLowerCase();
        const hit = negativeKeywords.find((kw) => kw && hay.includes(kw));
        if (hit) {
            return { qualified: false, grade: 'unqualified', reason: `negative_keyword:${hit}` };
        }
    }

    const name = String(lead.company_name || '').toLowerCase();
    const snippet = String(lead.snippet || lead.description || '').toLowerCase();
    const text = `${name} ${snippet}`;

    // ── 供应商正向信号 ─────────────────────────────────────────────────────────
    const SUPPLIER_POSITIVE_RE = /\b(manufacturer|manufactur|factory|factories|exporter|producer|supplier|fabricat|oem|odm|制造|工厂|出口商|生产商|供应商)\b/i;
    const isSupplierSignal = SUPPLIER_POSITIVE_RE.test(text);

    // ── 纯目录/协会（供应商模式下仍排除）────────────────────────────────────────
    const domainEntityType = inferEntityType({ domain: lead.domain, snippet: lead.snippet, companyName: lead.company_name, category, supplierMode: true });
    const isDirectory = domainEntityType === 'aggregator' && !isSupplierSignal;

    if (isDirectory) {
        return { qualified: false, grade: 'unqualified', reason: 'aggregator_no_supplier_signal' };
    }

    // ── 委托买家评分函数处理其余字段（联系方式/域名/垃圾检测等） ────────────────
    // 签名对齐：evaluateLead 第二参为 opts 对象 { category }（旧代码传字符串 → 豁免失效）。
    // supplierMode:true 让委托调用跳过卖方伪装降级，保住目标制造商/工厂/出口商。
    const base = evaluateLead(lead, { category, supplierMode: true });
    if (!base.qualified) return base;

    // 有供应商信号 → 升级 qualified → premium（等同于「高置信目标」）
    if (isSupplierSignal && base.grade === 'qualified') {
        return { qualified: true, grade: 'premium', reason: 'supplier_signal_upgrade' };
    }
    return base;
}

/**
 * P6 ICP 负向关键词评分钩子（买家/供应商通用）。
 * 在 step5 写入前调用，命中 → 强制 unqualified（不写入 data_intel_l1_companies）。
 *
 * @param {string} name         公司名称
 * @param {string} [description] 描述/snippet
 * @param {string[]} negatives  负向关键词列表（已小写）
 */
function isNegativeKeywordHit(name, description, negatives) {
    if (!negatives || negatives.length === 0) return false;
    const hay = `${String(name || '')} ${String(description || '')}`.toLowerCase();
    return negatives.some((kw) => kw && hay.includes(kw));
}

module.exports = {
    isJunkDomain,
    isAggregatorDomain,
    isJunkName,
    isBizTypeBlacklisted,
    computeQualityGrade,
    isClosedBusiness,
    inferProcurementSignalCount,
    inferEntityType,
    evaluateLead,
    evaluateLeadSupplier,
    isNegativeKeywordHit,
    REJECT_REASONS,
};
