/**
 * Step2 → Step3 之间的 Top-N 截断：
 * 无论 intake 多少条，只对排序后最好的 N 条跑昂贵 Step3；
 * 溢出条保留轻量字段，Step5 入库后靠更低 confidence 排在后面展示。
 *
 * Env: ENRICH_TOP_N（默认 30；<=0 表示不截断）
 *
 * 贵算力防护：硬噪声（榜单/访谈/商会目录/错配 OEM）在进 Top-N 前直接剔除，
 * 不进 Step3，也不占 ENRICH_TOP_N 名额。
 */
'use strict';

const {
  offCategoryReason,
  categoryRelevanceScore,
  resolveCategory,
  isFalseFriendMention,
} = require('./v8_lib_category_relevance');

const INTENT_SCORE = {
  USER_SEED_INLINE: 35,
  USER_SEED: 32,
  BOL_SIGNAL: 28,
  CUSTOMS_SIGNAL: 28,
  CUSTOMS_DB: 26,
  IMPORT_RECORD: 24,
  PROCUREMENT_DECISION_MAKER: 22,
  PRIVATE_LABEL: 18,
  B2B_BUYER: 16,
  PILLAR0_BOOLEAN: 14,
};

const MATCH_SCORE = { high: 40, medium: 22, low: 8, none: 0 };

/** 标题/公司名像文档、指南、聚合页、平台、展会而非买家公司 */
const JUNK_TITLE_RE =
  /\[?\s*pdf\s*\]?|glossary|guidelines?\b|shipping policy|terms of sale|citizen petition|api\s*docs?|developer docs|importing into the|country requirements|trade facilitation act|comprehensive overview|market size|cagr of|job(s)?\b|vacancies|work from home|wikipedia|how to\b|what is\b|meaning of\b|highest paying|trade mission|rfp\b|visitor registration|apps on google play|online electronic store|industry directory|contract manufacturing services providers|rankings?\b|jun\s+20\d{2}|minimum\s+\d+\s*kg|起订/i;

/** 平台 / 展会 / 媒体 / 海关门户（非目标买家） */
const PLATFORM_TITLE_RE =
  /\b(carousell|facebook|linkedin|google play|youtube|trade show|trade fair|forum\s*&\s*market|exhibition|expo\b|itb\b|atf\b|switch trade|medical\s+fair|taobao|foodpanda|grabfood|deliveroo|grubhub|lemon8|huggingface|ebay)\b|海关|singapore customs|customs\.gov|贸易展|展会|淘宝|拼多多/i;

/** 榜单 / 访谈 / 商会名录 — 结构性硬噪声（与品类无关，始终可丢） */
const HARD_NOISE_TITLE_RE =
  /\b(membership\s+directory|list\s+of\s+companies|company\s+directory|chamber\s+of\s+commerce|amcham\b|content\s+creator\s+interview|questions\s+with\b|interview\s+with\b|top\s+manufacturing\s+companies|manufacturing\s+companies\s+in\b[^-]*rankings?|20\s+questions\s+with|day\s+in\s+the\s+life|top\s+selling\s+recommendations|market\s+overview\s+20\d{2}|seeds?\s+\d+|delivery\s+menu)\b|会员名录|企业名录|商会名录|专访|访谈|制作美味|前\s*\d+\s*种成分/i;

/** 电商货架 / 零售 SKU 页（非 B2B 买家公司） */
const RETAIL_SKU_TITLE_RE =
  /私护|湿巾|女性护理|可冲散|[~～]?\s*\d+\s*[gG]\b|[~～]?\s*\d+\s*kg\b|\/pkt\b|add\s+to\s+cart|order\s+online|delivery\s+menu|selling\s+recommendations|seeds?\s+\d+|【\s*\d+\s*[gG]\s*】|\[\s*~\s*\d+\s*G\s*\]/i;

/** 品类假友标题（如搜黄瓜却命中「黄瓜条」牛肉） */
const FALSE_FRIEND_BEEF_CUCUMBER_RE = /黄瓜条|\bcucumber\s*(strip|cut)\b/i;
const BEEF_CUT_RE = /\b(beef|chuck\s+tender|牛嫩肩|牛[肉腩])\b/i;

/** 域名像目录站 / 媒体 / 占位 / 平台，而非公司官网 */
const JUNK_HOST_RE =
  /\b(seair\.co\.in|importinfo\.com|importyeti\.com|volza\.com|panjiva\.com|trademo\.com|usetorg\.com|indexbox\.io|govtrack\.us|zoom\.us|example\.com|wixpress\.com|sentry-next|freepik|shutterstock|carousell\.com|globalspec\.com|highergov\.com|rxglobal\.com|customs\.gov\.sg|google\.com|play\.google|thesmartlocal\.com|amcham\.com\.sg|mothership\.sg|taobao\.com|foodpanda\.(sg|com)|grab\.com|deliveroo\.com|grubhub\.com|lemon8-app\.com|huggingface\.co|ebay\.(com|com\.sg)|tridge\.com|shopify\.com)\b/i;

const PLACEHOLDER_EMAIL_RE =
  /^(user@example\.com|user@domain\.com|info@domain\.com|xxx@organisation\.com|noreply@|no-reply@|orga@|group@thesmartlocal)/i;

/** 邮箱字段被版权串/乱码污染 */
const GARBAGE_EMAIL_RE = /copyright|@organisation\.com$|sales@.+\.sgcopyright/i;

function intentBoost(signal) {
  const key = String(signal || '').toUpperCase();
  if (INTENT_SCORE[key] != null) return INTENT_SCORE[key];
  if (!key) return 0;
  return 6;
}

function pillarBoost(pillar) {
  const p = String(pillar || '');
  if (/Pillar\s*0|Seed/i.test(p)) return 30;
  if (/Pillar\s*10|VerifiedSource/i.test(p)) return 22;
  if (/Pillar\s*7|Customs/i.test(p)) return 18;
  if (/Pillar\s*11|LinkedIn/i.test(p)) return 16;
  if (/Pillar\s*8|B2B/i.test(p)) return 12;
  return 4;
}

function hasUsableDomain(d) {
  if (typeof d !== 'string') return false;
  const cleaned = d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!cleaned || cleaned.length < 4 || !cleaned.includes('.')) return false;
  return /[a-z]/.test(cleaned) || /^[\d.]+$/.test(cleaned);
}

function hostOf(lead) {
  const raw = String(lead?.domain || lead?.link || lead?.source_url || '').trim();
  if (!raw) return '';
  try {
    const href = raw.startsWith('http') ? raw : `http://${raw}`;
    return new URL(href).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function leadText(lead) {
  return `${lead?.company_name || ''} ${lead?.snippet || ''} ${lead?.title || ''}`;
}

/**
 * 硬噪声 / 品类错配：进 Top-N / Step3 前剔除（不占贵算力名额）。
 * @param {object} lead
 * @param {string} [category] 用户品类；默认读 DISCOVERY_CATEGORY
 * @returns {string|null} 原因码，或 null 表示可保留
 */
function hardNoiseReason(lead, category) {
  if (!lead || typeof lead !== 'object') return 'empty';
  const title = leadText(lead);
  const host = hostOf(lead);
  const email = String(lead.primary_email || '').trim();

  // 1) 结构性噪声：与品类无关
  if (HARD_NOISE_TITLE_RE.test(title)) return 'directory_or_interview';
  if (/\brankings?\b/i.test(title) && /\b(top|best|companies\s+in)\b/i.test(title)) return 'rankings_list';
  if (PLATFORM_TITLE_RE.test(title) && /taobao|foodpanda|grabfood|deliveroo|grubhub|lemon8|huggingface|ebay|淘宝/i.test(title)) {
    return 'marketplace_content';
  }
  if (host && JUNK_HOST_RE.test(host)) {
    // 已知平台/媒体/聚合域名：一律不当买家官网
    if (/taobao|foodpanda|grab\.|deliveroo|grubhub|lemon8|huggingface|ebay|tridge|carousell|mothership|smartlocal|amcham|google|play\.google|shopify/i.test(host)) {
      return 'junk_host_platform';
    }
    if (/directory|rankings?|interview|amcham|smartlocal|mothership/i.test(title + host)) {
      return 'junk_host_content';
    }
  }
  if (RETAIL_SKU_TITLE_RE.test(title) && !/\b(wholesale|importer|import\b|distributor|trading|供应|批发|进口)\b/i.test(title)) {
    return 'retail_sku_page';
  }
  if (PLACEHOLDER_EMAIL_RE.test(email) || GARBAGE_EMAIL_RE.test(email)) return 'placeholder_email';

  const cat = category != null ? category : resolveCategory();
  // 品类假友：搜「黄瓜」却是「黄瓜条」牛肉部位
  if (
    cat &&
    (isFalseFriendMention(title, cat) ||
      (FALSE_FRIEND_BEEF_CUCUMBER_RE.test(title) && BEEF_CUT_RE.test(title) && /黄瓜|cucumber/i.test(cat)))
  ) {
    return 'false_friend_category';
  }

  // 2) 垂直错配：必须对照用户品类（搜护肤时不丢护肤 OEM）
  const off = offCategoryReason(title, cat);
  if (off) return off;

  return null;
}

/**
 * 从 intake 列表剔除硬噪声，返回 { clean, rejected, reasons }。
 * @param {object[]} leads
 * @param {string} [category]
 */
function rejectHardNoiseLeads(leads, category) {
  const list = Array.isArray(leads) ? leads : [];
  const cat = category != null ? category : resolveCategory();
  const clean = [];
  const rejected = [];
  const reasons = {};
  for (const lead of list) {
    const why = hardNoiseReason(lead, cat);
    if (why) {
      rejected.push({ ...lead, _hard_noise: why });
      reasons[why] = (reasons[why] || 0) + 1;
    } else {
      clean.push(lead);
    }
  }
  return { clean, rejected, reasons };
}

/**
 * 垃圾/非买家惩罚（负分）。把 PDF 指南、聚合站、占位邮箱等压出 Top-N。
 */
function junkPenalty(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  let pen = 0;
  const title = leadText(lead);
  const host = hostOf(lead);
  const pathHint = String(lead.link || lead.source_url || lead.domain || '').toLowerCase();
  const email = String(lead.primary_email || '').trim();

  if (hardNoiseReason(lead)) pen += 80; // 若未硬剔，排序上也压到底
  if (JUNK_TITLE_RE.test(title)) pen += 35;
  if (PLATFORM_TITLE_RE.test(title)) pen += 40;
  if (/\.pdf(\?|#|$)/i.test(pathHint) || /\[pdf\]/i.test(title)) pen += 25;
  if (host && JUNK_HOST_RE.test(host)) pen += 40;
  if (PLACEHOLDER_EMAIL_RE.test(email) || GARBAGE_EMAIL_RE.test(email)) pen += 45;
  // 纯国家代码 / 过短公司名（如 "SG"、"+ SG"）
  const name = String(lead.company_name || '').trim();
  if (name.length > 0 && name.length <= 3) pen += 25;
  if (/^(sg|us|uk|jp|cn)\b/i.test(name) && name.length < 12 && !/\b(inc|ltd|llc|corp|co)\b/i.test(name)) {
    pen += 15;
  }
  // 无可用域名且无电话 → 富化价值低
  if (!hasUsableDomain(lead.domain) && !(lead.phone || lead.primary_phone) && !lead.place_id) {
    pen += 12;
  }
  // 合同制造 / OEM：仅当与用户品类无关时加重罚（相关则轻罚）
  if (/\b(contract manufacturing|odm services|oem\b|factory outlet)\b/i.test(title)) {
    const relOem = categoryRelevanceScore(title);
    pen += relOem >= 0.5 ? 8 : 22;
  }
  // 电商零售货架页（非 B2B 买家）
  if (RETAIL_SKU_TITLE_RE.test(title) || /\b(market\s+fresh\s+pork|bok\s+choy\s+\d|\/pkt\b|add\s+to\s+cart)\b/i.test(title)) {
    pen += 28;
  }
  // 品类相关加分 / 错配惩罚（连续分，配合硬丢）
  const rel = categoryRelevanceScore(title);
  if (rel >= 1) pen -= 15;
  else if (rel >= 0.5) pen -= 8;
  else if (rel < 0) pen += 25;
  return pen;
}

/**
 * 预富化排序分（0–100 量级）。Step3 前尚无 confidence_score / L3，
 * 用 industry_match + 信号源 + pillar + 域名/电话等可观测字段，并扣垃圾分。
 */
function preEnrichRankScore(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  const matchRaw = String(lead.industry_match || '').toLowerCase();
  const matchPts = MATCH_SCORE[matchRaw] != null ? MATCH_SCORE[matchRaw] : 5;
  let score =
    matchPts +
    intentBoost(lead.intent_signal) +
    pillarBoost(lead.pillar) +
    Number(lead.verified_source_boost || 0);

  if (hasUsableDomain(lead.domain)) score += 12;
  if (lead.phone || lead.primary_phone) score += 10;
  if (lead.place_id || lead.maps_url) score += 6;
  if (lead.source_url || lead.link) score += 3;
  if (Array.isArray(lead.social_profile_urls) && lead.social_profile_urls.length) score += 4;

  score -= junkPenalty(lead);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function compareLeads(a, b) {
  const sa = preEnrichRankScore(a);
  const sb = preEnrichRankScore(b);
  if (sb !== sa) return sb - sa;
  const ma = String(a.industry_match || '');
  const mb = String(b.industry_match || '');
  const order = { high: 3, medium: 2, low: 1, none: 0 };
  const da = order[ma] || 0;
  const db = order[mb] || 0;
  if (db !== da) return db - da;
  return String(a.company_name || '').localeCompare(String(b.company_name || ''));
}

/** 品类相关优先：同排序分时，文本命中用户品类的排前 */
function compareLeadsWithCategory(a, b, category) {
  const cat = category != null ? category : resolveCategory();
  if (cat) {
    const ra = categoryRelevanceScore(leadText(a), cat);
    const rb = categoryRelevanceScore(leadText(b), cat);
    if (rb !== ra) return rb - ra;
  }
  return compareLeads(a, b);
}

/**
 * 相关性保底：Top-N 中至少留出 floor 个「品类相关」席位，避免噪声挤光展示。
 * Env: ENRICH_RELEVANCE_FLOOR（默认 min(8, topN)；0=关闭）
 */
function readRelevanceFloor(topN, env = process.env) {
  const raw = env.ENRICH_RELEVANCE_FLOOR;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n) && n <= 0) return 0;
    if (Number.isFinite(n)) return Math.min(n, topN);
  }
  return Math.min(8, Math.max(0, topN));
}

function isCategoryRelevantLead(lead, category) {
  const cat = category != null ? category : resolveCategory();
  if (!cat) return false;
  return categoryRelevanceScore(leadText(lead), cat) >= 0.5;
}

/**
 * @param {object[]} leads
 * @param {number} topN  ENRICH_TOP_N；<=0 不截断
 * @returns {{ top: object[], overflow: object[], topN: number, total: number, hardRejected: number, hardReasons: object, relevanceFloor: number, relevanceFilled: number }}
 */
function splitEnrichTopN(leads, topN, category) {
  const { clean, rejected, reasons } = rejectHardNoiseLeads(leads, category);
  const list = clean.slice();
  const n = Number(topN);
  const total = Array.isArray(leads) ? leads.length : 0;
  const hardRejected = rejected.length;
  const cat = category != null ? category : resolveCategory();
  const floor = readRelevanceFloor(Number.isFinite(n) && n > 0 ? n : list.length);

  if (!Number.isFinite(n) || n <= 0 || list.length <= n) {
    list.sort((a, b) => compareLeadsWithCategory(a, b, cat));
    return {
      top: list,
      overflow: [],
      topN: n,
      total,
      hardRejected,
      hardReasons: reasons,
      relevanceFloor: floor,
      relevanceFilled: list.filter((l) => isCategoryRelevantLead(l, cat)).length,
    };
  }
  list.sort((a, b) => compareLeadsWithCategory(a, b, cat));
  // 排序分过低的也不进 Top（避免噪声挤占）
  const MIN_TOP_SCORE = Math.max(0, parseInt(process.env.ENRICH_MIN_TOP_SCORE || '18', 10));
  const eligible = list.filter((l) => preEnrichRankScore(l) >= MIN_TOP_SCORE);
  const weak = list.filter((l) => preEnrichRankScore(l) < MIN_TOP_SCORE);
  const pool = eligible.length >= Math.min(8, n) ? eligible : list;

  // 相关性保底：先锁品类相关席位，再按排序填满剩余
  let top = [];
  const used = new Set();
  if (floor > 0 && cat) {
    const relevant = pool.filter((l) => isCategoryRelevantLead(l, cat));
    for (const lead of relevant) {
      if (top.length >= floor || top.length >= n) break;
      top.push(lead);
      used.add(lead);
    }
  }
  for (const lead of pool) {
    if (top.length >= n) break;
    if (used.has(lead)) continue;
    top.push(lead);
    used.add(lead);
  }
  // 若相关席位仍不足且 weak 里有相关线索，从 weak 补（保底优先于 MIN_TOP_SCORE）
  if (floor > 0 && cat) {
    const relevantInTop = top.filter((l) => isCategoryRelevantLead(l, cat)).length;
    if (relevantInTop < floor) {
      const need = floor - relevantInTop;
      const fromWeak = weak.filter((l) => isCategoryRelevantLead(l, cat) && !used.has(l));
      for (let i = 0; i < need && i < fromWeak.length && top.length < n; i++) {
        // 挤掉末尾非相关，换入相关
        const swapIdx = [...top].map((l, idx) => ({ l, idx }))
          .reverse()
          .find((x) => !isCategoryRelevantLead(x.l, cat));
        if (swapIdx) {
          used.delete(top[swapIdx.idx]);
          top[swapIdx.idx] = fromWeak[i];
          used.add(fromWeak[i]);
        } else if (top.length < n) {
          top.push(fromWeak[i]);
          used.add(fromWeak[i]);
        }
      }
    }
  }

  const relevanceFilled = top.filter((l) => isCategoryRelevantLead(l, cat)).length;
  top = top.map((lead, i) => ({
    ...lead,
    _enrich_rank: i + 1,
    _pre_enrich_score: preEnrichRankScore(lead),
  }));
  const overflow = [...pool.filter((l) => !used.has(l)), ...weak.filter((l) => !used.has(l))].map((lead, i) => ({
    ...lead,
    _enrich_deferred: true,
    _enrich_rank: n + i + 1,
    _pre_enrich_score: preEnrichRankScore(lead),
    confidence_score: Math.min(45, Math.max(15, Math.round(preEnrichRankScore(lead) * 0.45))),
  }));
  return {
    top,
    overflow,
    topN: n,
    total,
    hardRejected,
    hardReasons: reasons,
    relevanceFloor: floor,
    relevanceFilled,
  };
}

function readEnrichTopNFromEnv(env = process.env) {
  const raw = env.ENRICH_TOP_N;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 30;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 30;
  return n;
}

/**
 * 把溢出线索压成可进 Step4/5 的轻量 lead（跳过 Step3）。
 * 不入 enrichment_queue（_skip_enrichment_queue）。
 */
function materializeOverflowLead(lead, countryCode) {
  const score = Number(lead.confidence_score);
  const confidence = Number.isFinite(score)
    ? score
    : Math.min(45, Math.max(15, Math.round(preEnrichRankScore(lead) * 0.45)));
  return {
    ...lead,
    country: lead.country || countryCode || null,
    confidence_score: confidence,
    _enrich_deferred: true,
    _skip_enrichment_queue: true,
    entity_role: lead.entity_role || null,
  };
}

module.exports = {
  preEnrichRankScore,
  compareLeads,
  compareLeadsWithCategory,
  splitEnrichTopN,
  readEnrichTopNFromEnv,
  readRelevanceFloor,
  isCategoryRelevantLead,
  materializeOverflowLead,
  hasUsableDomain,
  junkPenalty,
  hardNoiseReason,
  rejectHardNoiseLeads,
};
