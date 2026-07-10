/**
 * 品类相关性 — 用用户搜索品类决定「错配垂直」是否可丢。
 *
 * 原则：
 *   1. 结构性噪声（榜单/访谈/商会名录）与品类无关，始终可硬丢。
 *   2. 垂直错配（汽车站、药妆 OEM、药厂…）必须对照用户品类：
 *      - 用户搜「白菜」→ 可丢汽车/护肤/药厂
 *      - 用户搜「护肤」→ 不可丢护肤 OEM
 *      - 用户品类无法归类 → 不按垂直硬丢（避免误杀）
 *   3. 标题/snippet 已含用户品类词 → 强制保留（相关性命中）
 */
'use strict';

const { sanitizeDiscoveryCategory } = require('./v8_lib_category_sanitize');

/**
 * 垂直族：categoryHints 匹配用户品类；leadMarkers 匹配线索文本。
 * 仅当「用户族 ≠ 线索族」且线索有强 marker 时才判 off_category。
 */
const VERTICAL_FAMILIES = {
  produce_food: {
    categoryHints: [
      /白菜|黄瓜|青瓜|草莓|蔬菜|水果|海鲜|水产|大米|面粉|食品|蔬果|榴莲|土豆|马铃薯|肉|禽|蛋|奶|茶|酒|饮料|粮油|调味/,
      /\b(cabbage|cucumber|seafood|vegetable|fruit|produce|food|rice|flour|durian|potato|meat|poultry|dairy|beverage|grocery|fresh\s+produce)\b/i,
    ],
    leadMarkers: [
      /\b(vegetable|fruit|produce|seafood|food\s+(supply|wholesale|trading|import)|wet\s+market|grocery|bok\s+choy|cabbage|cucumber|strawberry)\b/i,
      // 黄瓜(?!条)：避免「黄瓜条」牛肉部位误判为蔬果
      /蔬|果|海鲜|水产|白菜|黄瓜(?!条)|青瓜|草莓|粮油|食品批发|食品供应|生鲜/,
    ],
  },
  auto: {
    categoryHints: [
      /汽车|汽配|车用|整车|轮胎|motoring/,
      /\b(auto(?:motive)?|car\s+parts?|vehicle\s+parts?|tyre|tire|motoring)\b/i,
    ],
    leadMarkers: [
      /\b(car\s+enthusiast|thecarenthusiast|auto\s+parts?|motoring\s+news|automotive\s+parts?|car\s+dealer)\b/i,
    ],
  },
  skincare_beauty: {
    categoryHints: [
      /护肤|化妆品|美容|彩妆|面膜/,
      /\b(skincare|skin\s*care|cosmetic|beauty|makeup|dermal)\b/i,
    ],
    leadMarkers: [
      /\b(skincare|skin\s*care|cosmetic|odm\s+skincare|dermalab|beauty\s+manufacturer)\b/i,
    ],
  },
  pharma: {
    categoryHints: [
      /药|制药|医药|保健品|原料药/,
      /\b(pharma(?:ceutical)?|api\b|supplement|nutraceutical|drug)\b/i,
    ],
    leadMarkers: [
      /\b(pharmaceutical\s+contract\s+manufactur\w*|api\/?\s*supplements?|nutraceutical|pharma\s+oem)\b/i,
    ],
  },
  electronics: {
    categoryHints: [
      /电视|电子|电器|芯片|半导体|手机|电脑|显示/,
      /\b(tv|television|electronics?|semiconductor|chip|smartphone|computer|display|led\s+lighting)\b/i,
    ],
    leadMarkers: [
      /\b(electronics?\s+(oem|odm|contract)|semiconductor|pcb\s+assembl)\b/i,
    ],
  },
  industrial_oem: {
    categoryHints: [
      /代工|合同制造|oem|odm|零部件/,
      /\b(contract\s+manufactur|oem|odm|precision\s+parts)\b/i,
    ],
    leadMarkers: [
      /\b(contract\s+manufacturing|oem\/odm|odm\s+services)\b/i,
    ],
  },
};

function resolveCategory(explicit) {
  const raw = String(
    explicit != null && String(explicit).trim()
      ? explicit
      : (process.env.DISCOVERY_CATEGORY || process.env.DISCOVERY_CATEGORY_RAW || ''),
  ).trim();
  if (!raw) return '';
  try {
    return sanitizeDiscoveryCategory(raw) || raw;
  } catch {
    return raw;
  }
}

function detectFamilies(text, field) {
  const s = String(text || '');
  if (!s) return [];
  const hit = [];
  for (const [id, fam] of Object.entries(VERTICAL_FAMILIES)) {
    const list = fam[field] || [];
    if (list.some((re) => re.test(s))) hit.push(id);
  }
  return hit;
}

/** 用户品类 token：中文按字/词块，英文按词 */
function categoryTokens(category) {
  const c = String(category || '').trim().toLowerCase();
  if (!c) return [];
  const tokens = new Set();
  // 英文词
  for (const m of c.match(/[a-z0-9]{2,}/gi) || []) tokens.add(m.toLowerCase());
  // 中文连续块（≥1）
  for (const m of c.match(/[\u4e00-\u9fff]+/g) || []) {
    tokens.add(m);
    if (m.length >= 2) {
      for (let i = 0; i < m.length - 1; i++) tokens.add(m.slice(i, i + 2));
    }
  }
  return [...tokens].filter((t) => t.length >= 1);
}

/**
 * 中文品类假友：子串命中但语义不是该品类（如「黄瓜条」= 牛肉部位，非蔬菜黄瓜）
 * key = 用户品类（净化后），value = 命中则不算品类相关的正则
 */
const CATEGORY_FALSE_FRIENDS = {
  黄瓜: /黄瓜条/,
  cucumber: /\bcucumber\s*strip\b|\bcucumber\s*cut\b/i,
};

function isFalseFriendMention(text, category) {
  const cat = String(category || '').trim().toLowerCase();
  if (!cat) return false;
  const t = String(text || '');
  const re = CATEGORY_FALSE_FRIENDS[cat] || CATEGORY_FALSE_FRIENDS[String(category || '').trim()];
  if (re && re.test(t)) {
    // 假友命中且无独立蔬果语境 → 视为假命中
    if (!/\b(vegetable|produce|fresh\s+veg|蔬|青瓜|freshveggies|wholesale\s+cucumber)\b/i.test(t)) {
      return true;
    }
  }
  return false;
}

/**
 * 线索文本是否已含用户品类词（强相关 → 不可因垂直错配丢掉）
 */
function textMentionsCategory(text, category) {
  const t = String(text || '').toLowerCase();
  const cat = String(category || '').toLowerCase().trim();
  if (!t || !cat) return false;
  if (isFalseFriendMention(text, category) || isFalseFriendMention(text, cat)) return false;
  if (t.includes(cat)) return true;
  const tokens = categoryTokens(cat);
  // 至少命中一个长度≥2 的 token，或唯一短中文品类整词
  return tokens.some((tok) => {
    if (tok.length < 2) return false;
    if (!t.includes(tok.toLowerCase())) return false;
    // token 级假友：黄瓜 ⊂ 黄瓜条
    if (tok === '黄瓜' && /黄瓜条/.test(String(text || '')) && !/青瓜|蔬菜|蔬果|fresh\s*veg/i.test(t)) {
      return false;
    }
    return true;
  });
}

/**
 * 垂直错配判定。
 * @returns {string|null} 'off_category' 或 null
 */
function offCategoryReason(leadText, categoryOpt) {
  const category = resolveCategory(categoryOpt);
  if (!category) return null; // 无品类 → 不按垂直硬丢

  const text = String(leadText || '');
  if (textMentionsCategory(text, category)) return null;

  const userFamilies = detectFamilies(category, 'categoryHints');
  if (userFamilies.length === 0) return null; // 用户品类未归类 → 保守不丢

  const leadFamilies = detectFamilies(text, 'leadMarkers');
  if (leadFamilies.length === 0) return null;

  // 线索命中的垂直族与用户族完全无交集 → 错配
  const overlap = leadFamilies.some((f) => userFamilies.includes(f));
  if (!overlap) return 'off_category';
  return null;
}

/**
 * 用户品类与线索的粗相关分（0–1），供排序加分用。
 */
function categoryRelevanceScore(leadText, categoryOpt) {
  const category = resolveCategory(categoryOpt);
  if (!category) return 0;
  const text = String(leadText || '');
  if (textMentionsCategory(text, category)) return 1;
  const userFamilies = detectFamilies(category, 'categoryHints');
  const leadFamilies = detectFamilies(text, 'leadMarkers');
  if (userFamilies.length && leadFamilies.some((f) => userFamilies.includes(f))) return 0.6;
  if (userFamilies.length && leadFamilies.length && !leadFamilies.some((f) => userFamilies.includes(f))) {
    return -0.5; // 明确错配，排序惩罚（硬丢由 offCategoryReason 处理）
  }
  return 0;
}

module.exports = {
  VERTICAL_FAMILIES,
  resolveCategory,
  detectFamilies,
  categoryTokens,
  textMentionsCategory,
  isFalseFriendMention,
  offCategoryReason,
  categoryRelevanceScore,
};
