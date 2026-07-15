require('./load-env');
const fs    = require('fs');
const https = require('https');

// ── 垃圾域名判断统一从 v8_quality_gate 引入，与 zhimao 主系统保持单源同步 ────
// 不再在此文件维护独立黑名单，避免两处列表漂移浪费 Serper 配额
const { isJunkDomain } = require('./v8_quality_gate');
const {
  readMatrixFromEnv,
  resolveCitiesForRun,
  isPlatformEnabled,
  readIndustryHintFromEnv,
  readConvoControlsFromEnv,
  getIndustryAnchor,
} = require('./v8_constants_geo');
const {
  readFullPillar0Payload,
  readInlineSeeds,
  buildQuerySubjects,
  buildLocalQuerySubjects,
  quoteSubject,
  pickSubject,
  collectBooleanQueries,
  collectLocalBooleanQueries,
  collectProcurementQueries,
  sanitizeDiscoveryCategory,
  readIcpContext,
} = require('./v8_lib_pillar0');
const { appendFunnelStep } = require('./v8_lib_funnel');
const { extractSocialUrlsFromText } = require('./v8_lib_social_extract');
const { getIndustryHint, DEFAULT_PLACE_BLACKLIST } = require('./v8_icp_taxonomy');

function isJunkLead(lead) {
  if (!lead || !lead.link) return false;
  try {
    return isJunkDomain(lead.link);
  } catch(_) {}
  return false;
}

const [inputFile, outputFile, countryCode] = process.argv.slice(2);

const API_KEY = process.env.SERPER_API_KEY;
if (!API_KEY) { console.error('[step1] SERPER_API_KEY env var is required'); process.exit(1); }

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ── Deep Paging：由 Cron 传入的第几次扫描，转换为 Serper 搜索页码 ────────────
// sweep 1 → page 1（结果 1-20）
// sweep 2 → page 2（结果 21-40）
// sweep 5 → page 5（结果 81-100，长尾冰山数据）
// 让同一个 [category × country] 网格每次 cron 运行都挖到新数据
const SWEEP_COUNT  = Math.max(1, parseInt(process.env.SWEEP_COUNT || '1', 10));
const SEARCH_PAGE  = SWEEP_COUNT; // 1-based Serper page

function loadReweightControls() {
  const raw = process.env.DISCOVERY_REWEIGHT_JSON || '[]';
  let items = [];
  try { items = JSON.parse(raw); } catch { items = []; }

  const sum = (kind) => (Array.isArray(items) ? items
    .filter(x => String(x?.source_kind || '').toLowerCase() === kind)
    .reduce((acc, x) => acc + Number(x?.weight_delta || 0), 0) : 0);

  const geo      = sum('geo');
  const entity   = sum('entity');
  const contact  = sum('contact');
  const generic  = sum('generic');
  const staleness = sum('staleness');

  // 硬禁用检查（channel_disabled=true 时直接 disable）
  const isHardDisabled = (kind) => Array.isArray(items) && items
    .filter(x => String(x?.source_kind || '').toLowerCase() === kind)
    .some(x => x?.channel_disabled === true);

  // 合并多行域名黑名单（V8 step2 直接过滤 host）
  const domainBlacklist = Array.isArray(items)
    ? [...new Set(items.flatMap(x => Array.isArray(x?.domain_blacklist) ? x.domain_blacklist : []))]
    : [];

  // 合并关键词抑制列表（V8 step0 查询翻译时排除这些词）
  const keywordSuppress = Array.isArray(items)
    ? [...new Set(items.flatMap(x => Array.isArray(x?.keyword_suppress) ? x.keyword_suppress : []))]
    : [];

  // 计算各渠道权重分（0-1），用于动态调整抓取优先级
  // 基准 1.0，负向信号降低，正向信号提升，硬禁用强制 0
  const channelWeight = (kind, base = 1.0) => {
    if (isHardDisabled(kind)) return 0;
    const delta = sum(kind);
    // 线性映射：delta=-0.3 → weight=0.1, delta=0 → 1.0, delta=+0.15 → 1.5
    return Math.max(0, Math.min(2.0, base + delta * 3));
  };

  return {
    // 原有布尔控制（向后兼容）
    geo, entity, contact, generic,
    disableLinkedin:  isHardDisabled('entity') || entity <= -0.05,
    disableLookalike: isHardDisabled('generic') || generic <= -0.08,
    enforceGeo:       isHardDisabled('geo') || geo <= -0.05,
    // 新增：渠道权重（0=禁用, 1=正常, >1=加权）
    weights: {
      geo:       channelWeight('geo'),
      entity:    channelWeight('entity'),
      contact:   channelWeight('contact'),
      generic:   channelWeight('generic'),
      staleness: channelWeight('staleness'),
    },
    // 新增：时效性加强（数据陈旧投诉时，强制加年份过滤）
    enforceRecency: isHardDisabled('staleness') || staleness <= -0.06,
    // 新增：域名黑名单（直接传给 step2）
    domainBlacklist,
    // 新增：关键词抑制（传给 step0 翻译器）
    keywordSuppress,
    // 调试用：原始策略行数
    _policyCount: Array.isArray(items) ? items.length : 0,
  };
}

// ─── Serper helpers ────────────────────────────────────────────────────────
function serperPost(path, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'google.serper.dev', path, method: 'POST',
      headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, r => {
      let data = ''; r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.write(payload); req.end();
  });
}

function fetchPlaces(query, gl) {
  return serperPost('/places', { q: query, gl }).then(r => r.places || []);
}

// ─── Google Places API（原生，优先于 Serper /places）──────────────────────
// Text Search → Place Details（补电话+官网），最多 20 条，并发限 5 个 Details
// 失败静默降级：返回 [] 触发 Serper /places 兜底
function httpsGet(url) {
  return new Promise(resolve => {
    https.get(url, r => {
      let data = ''; r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });
}

async function fetchGooglePlacesNative(query, gl) {
  if (!GMAPS_KEY) return null; // 无 key，触发 Serper 兜底

  const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json`
    + `?query=${encodeURIComponent(query)}`
    + `&region=${gl.toLowerCase()}`
    + `&key=${GMAPS_KEY}`;
  const tsRes = await httpsGet(tsUrl).catch(() => ({}));
  if (tsRes.status !== 'OK' || !Array.isArray(tsRes.results) || tsRes.results.length === 0) return null;

  const raw = tsRes.results.slice(0, 20);
  const detailFields = 'name,formatted_address,formatted_phone_number,website,business_status,rating,user_ratings_total';

  // 并发最多 5 个 Place Details（保持在 Google QPS 内）
  const pLimit = 5;
  const enriched = [];
  for (let i = 0; i < raw.length; i += pLimit) {
    const batch = raw.slice(i, i + pLimit);
    const details = await Promise.all(batch.map(async p => {
      if (!p.place_id) return p;
      const dtUrl = `https://maps.googleapis.com/maps/api/place/details/json`
        + `?place_id=${encodeURIComponent(p.place_id)}`
        + `&fields=${detailFields}`
        + `&key=${GMAPS_KEY}`;
      const dt = await httpsGet(dtUrl).catch(() => ({}));
      if (dt.status === 'OK' && dt.result) return { ...p, ...dt.result };
      return p;
    }));
    enriched.push(...details);
  }
  return enriched;
}

/**
 * Batch A.4：根据 industry_hint.place_type_blacklist 把 Google Places 的 types 过滤掉。
 * Native API 才有 types 字段；Serper /places 没有 → 走 Native 时才生效。
 */
function filterByPlaceTypeBlacklist(placesRaw, blacklist) {
  if (!Array.isArray(placesRaw) || placesRaw.length === 0) return placesRaw;
  if (!Array.isArray(blacklist) || blacklist.length === 0) return placesRaw;
  const blk = new Set(blacklist.map((s) => String(s || '').toLowerCase()));
  return placesRaw.filter((p) => {
    const types = Array.isArray(p.types) ? p.types : [];
    if (types.length === 0) return true; // 无 types 时不过滤（避免误杀 Serper 兜底）
    for (const t of types) {
      if (blk.has(String(t || '').toLowerCase())) return false;
    }
    return true;
  });
}

/** mapTypes 正向偏好：命中 segment.mapTypes 的 Places 结果排在前面 */
function rankPlacesByMapTypes(placesRaw, mapTypes) {
  if (!Array.isArray(placesRaw) || placesRaw.length === 0) return placesRaw;
  if (!Array.isArray(mapTypes) || mapTypes.length === 0) return placesRaw;
  const prefer = new Set(mapTypes.map((t) => String(t || '').toLowerCase()));
  const score = (p) => {
    const types = Array.isArray(p.types) ? p.types : [];
    return types.some((t) => prefer.has(String(t || '').toLowerCase())) ? 1 : 0;
  };
  return [...placesRaw].sort((a, b) => score(b) - score(a));
}

function leadMatchesKeywordSuppress(lead, suppressList) {
  if (!Array.isArray(suppressList) || suppressList.length === 0) return false;
  const text = `${lead.title || ''} ${lead.snippet || ''}`.toLowerCase();
  return suppressList.some((kw) => {
    const k = String(kw || '').trim().toLowerCase();
    return k.length > 1 && text.includes(k);
  });
}

// P1 Pillar 专用：先走 Google Places 原生，失败回 Serper /places
async function fetchPlacesWithFallback(query, gl, placeTypeBlacklist, mapTypesPrefer) {
  const native = await fetchGooglePlacesNative(query, gl).catch(() => null);
  if (native && native.length > 0) {
    const filtered = rankPlacesByMapTypes(
      filterByPlaceTypeBlacklist(native, placeTypeBlacklist || []),
      mapTypesPrefer || [],
    );
    return filtered.map(p => ({
      title:       p.name || '',
      website:     p.website || '',
      phoneNumber: p.formatted_phone_number || '',
      address:     p.formatted_address || p.vicinity || '',
      rating:      p.rating,
      business_status: p.business_status,
      // 买家抓取矩阵（Batch 3）：新增 maps_url / place_id 直透到 lead，
      // Step5 → buildL1Row 据此写 data_intel_l1_companies.maps_url / place_id 列
      place_id:    p.place_id || null,
      maps_url:    p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : null,
      _source: 'google_places_native',
    }));
  }
  // Serper 兜底：Serper /places 返回 cid / placeId（驼峰），不返回 place_id（蛇形）。
  // 旧实现只读 p.place_id → 永远 null → maps 线索无任何出处锚点（行业级修复点）。
  // 现在统一从 placeId / cid 派生 Google Maps 深链：
  //   placeId → maps/place/?q=place_id:{id}；cid → maps?cid={cid}（两者皆官方稳定深链）
  return fetchPlaces(query, gl).then(arr => arr.map((p) => {
    const placeId = p.place_id || p.placeId || null;
    const cid = p.cid != null ? String(p.cid) : null;
    const maps_url =
      p.maps_url ||
      (placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : null) ||
      (cid ? `https://www.google.com/maps?cid=${cid}` : null);
    return { ...p, place_id: placeId, maps_url };
  }));
}

function searchOrganic(query, gl, num = 20, page = SEARCH_PAGE) {
  // page=1 时不传（Serper 默认），page≥2 时传入实现真正的深水区翻页
  const body = page > 1
    ? { q: query, gl, num, page }
    : { q: query, gl, num };
  return serperPost('/search', body).then(r => r.organic || []);
}

/**
 * 买家抓取矩阵 matrix.max_pages_per_pillar 驱动的多页 Serper 调用。
 * 从当前 SEARCH_PAGE 开始，往后取 MATRIX_MAX_PAGES 页，并按 link 去重合并。
 * MATRIX_MAX_PAGES=1（默认）退化为单次 searchOrganic，行为向后兼容。
 */
const MATRIX_MAX_PAGES = (() => {
  try {
    const m = readMatrixFromEnv();
    return (m && m.maxPages) ? Math.min(5, Math.max(1, m.maxPages)) : 1;
  } catch { return 1; }
})();

async function searchOrganicMultiPage(query, gl, num = 20) {
  if (MATRIX_MAX_PAGES <= 1) return searchOrganic(query, gl, num);
  const pagePromises = [];
  for (let p = SEARCH_PAGE; p < SEARCH_PAGE + MATRIX_MAX_PAGES; p++) {
    pagePromises.push(searchOrganic(query, gl, num, p));
  }
  const pages = await Promise.all(pagePromises);
  const seen = new Set();
  const merged = pages.flat().filter(r => {
    const key = (r.link || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (MATRIX_MAX_PAGES > 1) {
    console.log(`[step1] multiPage: query="${query.slice(0, 60)}" pages=${MATRIX_MAX_PAGES} merged=${merged.length}`);
  }
  return merged;
}

// ─── Lead builders ─────────────────────────────────────────────────────────

/**
 * "信号源域名"：这些站本身不是采购商主页，但 snippet 里包含真实买家公司名。
 * fromOrganic 自动把这些站的 link 转为 source_url（lead.link=null），
 * 让 LLM step2 从 snippet 抽取公司名，step3 不会用这些聚合站当 contact 富化目标。
 *
 * 设计原则（与 P11 LinkedIn 现有处理一致）：
 *   - link 设为 null  → 后续 isJunkDomain / preFilterRawLeads 不会把整条 lead 当垃圾丢掉
 *   - source_url 保留 → 用户可看到证据来源
 *   - snippet 保留    → LLM 抽取公司名（这些站的 snippet 通常是 "Company X imports XXX
 *                       from supplier Y, 12 shipments in 2025" 这类高质量买家信号）
 */
const SIGNAL_SOURCE_HOSTS = new Set([
  'importyeti.com', 'www.importyeti.com',
  'volza.com', 'www.volza.com',
  'panjiva.com', 'www.panjiva.com',
  'importgenius.com', 'www.importgenius.com',
  'tradesparq.com', 'www.tradesparq.com',
  'linkedin.com', 'www.linkedin.com',
  'glassdoor.com', 'www.glassdoor.com',
  'indeed.com', 'www.indeed.com',
  'zhipin.com', 'www.zhipin.com',
  'liepin.com', 'www.liepin.com',
]);

function isSignalSourceHost(link) {
  if (!link || typeof link !== 'string') return false;
  try {
    const url = new URL(link.startsWith('http') ? link : `https://${link}`);
    const host = url.hostname.toLowerCase();
    if (SIGNAL_SOURCE_HOSTS.has(host)) return true;
    // 子域兜底：m.linkedin.com / api.importyeti.com 等
    for (const h of SIGNAL_SOURCE_HOSTS) {
      if (host.endsWith('.' + h)) return true;
    }
  } catch (_) {}
  return false;
}

function fromOrganic(results, pillar, intent_signal) {
  return results.map(o => {
    const isSignal = isSignalSourceHost(o.link);
    return {
      title:   o.title,
      link:    isSignal ? null : o.link,           // 信号源不当公司主页域名
      snippet: o.snippet,
      pillar,
      ...(intent_signal ? { intent_signal } : {}),
      ...(isSignal ? { source_url: o.link } : {}), // 留作证据溯源
    };
  });
}

// ─── 区域专属数据源注册表（单源加载，避免每次 run() 重读文件）──────────────
let _verifiedSourceRegistry = null;
function getVerifiedSources() {
  if (_verifiedSourceRegistry) return _verifiedSourceRegistry;
  const regPath = 'zhimao_verified_source_registry.json';
  try {
    if (fs.existsSync(regPath)) {
      _verifiedSourceRegistry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    }
  } catch (_) { _verifiedSourceRegistry = { sources: {} }; }
  return _verifiedSourceRegistry || { sources: {} };
}

// ─── 主函数：全 Pillar 并行执行 ────────────────────────────────────────────
// 性能：原来 ~10 次 Serper 调用串行 ≈ 30-60s，现在全并行 ≈ 1-3s（取最慢一路）
async function run() {
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const pillar0Payload = readFullPillar0Payload();
  // categoryClean 由 step0 净化；再与 PILLAR0 兜底净化保持单源语义
  const { baseQuery, countryName, tld } = data;
  const category = data.categoryClean || sanitizeDiscoveryCategory(data.category || '');
  // 无国家门槛根治（2026-07）：GLOBAL 哨兵 → gl 置空，Serper 走全域检索（不做单国偏置）。
  // countryName 已由 step0 在 GLOBAL 时置空，各 pillar query 自然不拼国家后缀。
  const cc   = (countryCode && String(countryCode).toUpperCase() !== 'GLOBAL') ? countryCode : '';
  const year = new Date().getFullYear();
  const controls = loadReweightControls();
  const convo = readConvoControlsFromEnv();
  // P6b：找供应商方向 → 启用供应商目录 / 工厂直采 pillar，撤掉买家专属 organic/maps pillar。
  const IS_SUPPLIER_MODE = readIcpContext(pillar0Payload).direction === 'find_suppliers';
  const allKeywordSuppress = [...new Set([
    ...controls.keywordSuppress,
    ...(convo.negativeKeywords || []),
  ])];
  console.log('[step1] reweight controls:', JSON.stringify(controls));
  if (baseQuery) {
    console.log(`[step0] baseQuery available (${baseQuery.slice(0, 100)}…) — boolean/procurement pillars will execute it`);
  }

  // ── 买家抓取矩阵（Batch 3）：解析 PILLAR0_PAYLOAD.matrix ──────────────────
  // matrix.cities       → maps 类 pillar 多城市循环（空=按国家级 query 兼容老路径）
  // matrix.platforms    → 6 平台 pillar 启停白名单（空=全开）
  // matrix.deepAllCities→ true 时 cities 空 + 国家有主要城市表 → 自动展开 5 城
  const matrix = readMatrixFromEnv();
  const mapsCities = resolveCitiesForRun(cc, matrix);
  if (matrix) {
    console.log(`[step1] matrix: cities=[${(matrix.cities || []).join('|')}] effective=[${mapsCities.join('|')}] platforms=[${(matrix.platforms || []).join('|')}] deepAll=${matrix.deepAllCities}`);
  }

  // ── Batch A.4：ICP 业态 hint（zhimao submit 注入；缺失则从 category 兜底）─
  // 用于：Google Places types 黑名单过滤 + 写到 lead.industry_hint 透传到 step2 prompt
  let industryHint = readIndustryHintFromEnv();
  if (!industryHint) {
    try { industryHint = getIndustryHint(category); }
    catch (_) { industryHint = null; }
  }
  const placeTypeBlacklist = (industryHint && industryHint.place_type_blacklist)
    ? industryHint.place_type_blacklist
    : DEFAULT_PLACE_BLACKLIST;
  if (industryHint) {
    console.log(
      `[step1] industry_hint: category_key=${industryHint.category_key} ` +
      `industry_key=${industryHint.industry_key || '-'} ` +
      `blacklist=[${placeTypeBlacklist.slice(0, 4).join(',')}…] hit=${industryHint.hit}`,
    );
  }

  // ── Batch D.1：业态 anchor 词（map_retrieval_segments 派生）──────────────────
  // 命中字典（industry_key/category_key/segment_id）时，step1 的 P1/P3/P11/P_*
  // pillar 把"trading company / procurement manager"这种泛词替换为业态精准 anchor，
  // 显著提升 industry_match=high 比例（验收金标线：基线 ~30% → ≥70%）。
  // 不命中时 anchor=null，pillar 退化为旧泛词路径，保持向后兼容。
  // 查询顺序：industry_key → category_key → 原始品类（容忍用户传中文）
  let industryAnchor = null;
  try {
    const tries = [];
    if (industryHint) {
      if (industryHint.industry_key) tries.push(industryHint.industry_key);
      if (industryHint.category_key && industryHint.category_key !== 'other') tries.push(industryHint.category_key);
    }
    tries.push(category);
    for (const ov of (convo.icpOverrides || [])) {
      if (ov) tries.unshift(ov);
    }
    for (const k of tries) {
      const a = getIndustryAnchor(k);
      if (a) { industryAnchor = a; break; }
    }
  } catch (_) {
    industryAnchor = null;
  }
  if (industryAnchor) {
    console.log(
      `[step1] industry_anchor segment=${industryAnchor.segment_id} ` +
      `en=[${industryAnchor.en.slice(0, 3).join(',')}…] zh=[${industryAnchor.zh.slice(0, 3).join(',')}…]`,
    );
  }
  // 取主 anchor（首选 EN，作为 P1 maps / P3 jobs / P11 LinkedIn 的核心 query 词）
  const anchorPrimary = industryAnchor && industryAnchor.en[0] ? industryAnchor.en[0] : '';
  const anchorAlt     = industryAnchor && industryAnchor.en[1] ? industryAnchor.en[1] : '';
  const mapTypesPrefer = industryAnchor && industryAnchor.mapTypes ? industryAnchor.mapTypes : [];

  const querySubjects = buildQuerySubjects(data, category, industryAnchor, pillar0Payload);
  const OQ = quoteSubject(pickSubject(querySubjects, category, SEARCH_PAGE));
  const rot = (off) => pickSubject(querySubjects, category, SEARCH_PAGE + (off || 0));
  const organicNum = controls.weights.generic < 0.5 ? 10 : (controls.weights.generic >= 1.2 ? 30 : 20);
  const booleanQueries = collectBooleanQueries(data, pillar0Payload);
  const procurementQueries = collectProcurementQueries(data, pillar0Payload);
  // P1 本地化（2026-05-21）：收集目标国母语 boolean / subjects，p_pillar0_boolean
  // 同时跑英文 + 本地语两批，提升日本/德国/西班牙等非英语市场的 SERP 命中率。
  const localBooleanQueries = collectLocalBooleanQueries(data, pillar0Payload);
  const localQuerySubjects = buildLocalQuerySubjects(data, pillar0Payload);
  if (querySubjects.length > 1) {
    console.log(`[step1] querySubjects(${querySubjects.length}): ${querySubjects.slice(0, 4).join(' | ')}…`);
  }
  if (localQuerySubjects.length > 0 || localBooleanQueries.length > 0) {
    console.log(
      `[step1] localized search active: ${localQuerySubjects.length} local subjects, ` +
      `${localBooleanQueries.length} local boolean queries (target_lang=${data?.targetLanguageHint || data?.targetLang || '?'})`
    );
  }

  // ── Pillar 定义（每个 Pillar 都是一个 Promise，全部同时启动） ──────────────
  //
  // 核心选题原则（采购数据专家视角）：
  //   真正的买家信号强度：进口记录 > 招聘采购岗 > 业务类型(进口商/批发商) > 主动询盘 > 公司自述
  //   所有 query 必须返回"公司官网"URL，而非聚合站/社交媒体（会被垃圾过滤器清除）

  const pillarPromises = {

    // ── P0: 种子库激活（高质量已验证买家 + DB pending seeds） ─────────────────
    // 1) 本地 zhimao_seed_intelligence.json：经营级别一致性的离线种子
    // 2) Supabase discovery_seeds：业务员主动喂入的 FB 小组 / 公司主页 URL（Batch 4）
    //    pending 种子按 (country_iso, category) 匹配后转为 lead；procure 在 Step5 后由
    //    finalize 路径将 status 标记为 consumed（避免 Step1 内重复跑 query 而 mark 过早）。
    p0_seed: (async () => {
      const out = [];
      const inline = readInlineSeeds(pillar0Payload);
      for (const u of [...inline.social_urls, ...inline.company_urls]) {
        out.push({
          title: u,
          link: u,
          snippet: 'Inline seed from submit action_payload.seeds',
          pillar: 'Pillar 0 Seed',
          intent_signal: 'USER_SEED_INLINE',
        });
      }
      try {
        if (fs.existsSync('zhimao_seed_intelligence.json')) {
          const seeds = JSON.parse(fs.readFileSync('zhimao_seed_intelligence.json', 'utf8'));
          for (const s of seeds) {
            if (s.country?.toLowerCase() === cc.toLowerCase() &&
                s.category?.toLowerCase().includes(category.toLowerCase())) {
              out.push({ title: s.company_name, link: s.domain, snippet: 'Seed DB Verified Buyer', pillar: 'Pillar 0 Seed' });
            }
          }
        }
      } catch (_) { /* local seed missing is fine */ }

      // 仅当 worker 已注入 SUPABASE 凭证时拉取 DB pending 种子
      const supaUrl = process.env.SUPABASE_URL || '';
      const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      if (supaUrl && supaKey) {
        try {
          const { createSupabaseClient } = require('./v8_supabase_client');
          const supa = createSupabaseClient(supaUrl, supaKey, { auth: { persistSession: false } });
          let q = supa.from('discovery_seeds').select('id,url,seed_type,country_iso,category').eq('status', 'pending');
          if (cc) q = q.or(`country_iso.is.null,country_iso.eq.${cc.toUpperCase()}`);
          const { data: pending, error } = await q.limit(50);
          if (!error && Array.isArray(pending)) {
            const catLower = category.toLowerCase();
            for (const s of pending) {
              const sc = String(s.category || '').toLowerCase();
              if (sc && !sc.includes(catLower)) continue; // 与本任务品类不相关则跳过（保留 pending）
              out.push({
                title: s.url,
                link: s.url,
                snippet: `User-supplied seed (${s.seed_type})`,
                pillar: 'Pillar 0 Seed',
                intent_signal: 'USER_SEED',
                _seed_id: s.id,
              });
            }
            // 标记 consumed：worker 再次启动同条件任务时不会重复入队
            const consumeIds = pending
              .filter((s) => {
                const sc = String(s.category || '').toLowerCase();
                return !sc || sc.includes(category.toLowerCase());
              })
              .map((s) => s.id);
            if (consumeIds.length > 0) {
              await supa.from('discovery_seeds')
                .update({ status: 'consumed', consumed_at: new Date().toISOString(), job_id: process.env.DISCOVERY_JOB_ID || null })
                .in('id', consumeIds);
              console.log(`[step1] p0_seed: consumed ${consumeIds.length} discovery_seeds rows for ${cc}/${category}`);
            }
          }
        } catch (e) {
          console.warn('[step1] p0_seed: supabase fetch failed (non-fatal):', e?.message || e);
        }
      }
      return out;
    })(),

  // ── Pillar0 布尔查询（expand-query boolean_queries / step0 落盘）──────────
    // P1 multi-lang rotation（2026-05-21）：同时跑英文 boolean + 本地语 boolean，
    // 让 SERP 同时命中"国际化大品牌"和"本地连锁/商社/协会"。
    p_pillar0_boolean: (async () => {
      const enQueries = booleanQueries.length > 0
        ? booleanQueries
        : (baseQuery ? [baseQuery] : []);
      const localQueries = localBooleanQueries; // 本地语 boolean（jp/de/es/...）
      if (enQueries.length === 0 && localQueries.length === 0) return [];

      const enPages = await Promise.all(
        enQueries.slice(0, 5).map((bq) => searchOrganicMultiPage(bq, cc, organicNum).catch(() => [])),
      );
      const localPages = await Promise.all(
        localQueries.slice(0, 3).map((bq) => searchOrganicMultiPage(bq, cc, organicNum).catch(() => [])),
      );

      const enResults = enPages.flat().map((o) => ({
        title: o.title,
        link: o.link,
        snippet: o.snippet,
        pillar: 'Pillar 0 Boolean',
        intent_signal: 'PILLAR0_BOOLEAN',
      }));
      const localResults = localPages.flat().map((o) => ({
        title: o.title,
        link: o.link,
        snippet: o.snippet,
        pillar: 'Pillar 0 Boolean Local',
        intent_signal: 'PILLAR0_BOOLEAN_LOCAL',
      }));
      if (localResults.length > 0) {
        console.log(`[step1] p_pillar0_boolean: en=${enResults.length} local=${localResults.length}`);
      }
      return [...enResults, ...localResults];
    })(),

    p_procurement: (async () => {
      if (!procurementQueries.length) return [];
      const pages = await Promise.all(
        procurementQueries.map((pq) => searchOrganicMultiPage(pq, cc, organicNum).catch(() => [])),
      );
      return pages.flat().map((o) => ({
        title: o.title,
        link: o.link,
        snippet: o.snippet,
        pillar: 'Pillar Procurement',
        intent_signal: 'PROCUREMENT_QUERY',
      }));
    })(),

    // ── P1: Google Maps/Places（最可靠买家信号：业务类型注册为进口商/批发商） ─
    // 返回真实公司网站，命中率最高。
    // 深分页策略：Places 不支持 page 参数，改用 query 轮换（SEARCH_PAGE 奇偶 / 不同身份词）
    // 避免每次 cron 重复拉取相同 20 条结果。
    // 买家抓取矩阵（Batch 3）：mapsCities 非空时多城市循环并合并去重（按 place_id）。
    p1_maps_dist: (async () => {
      const buildQ = (city) => {
        // Batch D.1：命中 anchor 时把"procurement manager OR buyer"换成业态精准 anchor，
        // 例：anchor='wholesale cosmetics' → 直接用，避免泛词把金融/咨询拉回结果集。
        const anchorTerm = anchorPrimary
          ? (SEARCH_PAGE % 2 === 0 ? anchorPrimary : (anchorAlt || anchorPrimary))
          : (SEARCH_PAGE % 2 === 0
              ? 'procurement manager OR buyer OR purchasing'
              : 'wholesaler OR distributor OR importer');
        const subj = rot(0);
        return city ? `${subj} ${anchorTerm} "${city}" ${countryName}` : `${subj} ${anchorTerm} ${countryName}`;
      };
      const queries = mapsCities.length > 0
        ? mapsCities.map((city) => ({ city, q: buildQ(city) }))
        : [{ city: null, q: buildQ(null) }];
      const arrs = await Promise.all(queries.map(({ city, q }) =>
        fetchPlacesWithFallback(q, cc, placeTypeBlacklist, mapTypesPrefer).then((ps) => ps.map((p) => ({ ...p, _city: city })))
      ));
      const seen = new Set();
      return arrs.flat()
        .filter((p) => p.website || p.phoneNumber)
        .filter((p) => {
          const k = (p.place_id || p.website || `${p.title}|${p.address}`).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .map((p) => ({
          title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber,
          pillar: 'Pillar 1 LBS', intent_signal: 'MAP_VERIFIED_BUYER',
          _gmaps_source: p._source || 'serper_places',
          _city: p._city || null, maps_url: p.maps_url || null, place_id: p.place_id || null,
        }));
    })(),

    p1_maps_trading: (async () => {
      const buildQ = (city) => {
        // Batch D.1：anchor 命中时把"trading company OR import export"换成业态词；
        // 同行抓取"印尼大蒜"案例的核心病灶就是这段把所有印尼商号拉回来。
        const anchorTerm = anchorPrimary
          ? `(${anchorPrimary}${anchorAlt ? ` OR ${anchorAlt}` : ''})`
          : (SEARCH_PAGE % 2 === 0
              ? 'import export agent OR sourcing company'
              : 'trading company OR import export');
        return city ? `${category} ${anchorTerm} "${city}" ${countryName}` : `${category} ${anchorTerm} in ${countryName}`;
      };
      const queries = mapsCities.length > 0
        ? mapsCities.map((city) => ({ city, q: buildQ(city) }))
        : [{ city: null, q: buildQ(null) }];
      const arrs = await Promise.all(queries.map(({ city, q }) =>
        fetchPlacesWithFallback(q, cc, placeTypeBlacklist, mapTypesPrefer).then((ps) => ps.map((p) => ({ ...p, _city: city })))
      ));
      const seen = new Set();
      return arrs.flat()
        .filter((p) => p.website || p.phoneNumber)
        .filter((p) => {
          const k = (p.place_id || p.website || `${p.title}|${p.address}`).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .map((p) => ({
          title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber,
          pillar: 'Pillar 1 LBS', intent_signal: 'TRADING_COMPANY',
          _gmaps_source: p._source || 'serper_places',
          _city: p._city || null, maps_url: p.maps_url || null, place_id: p.place_id || null,
        }));
    })(),

    // ── P1c (新增 2026-05): 业态画像 LBS —— 基于 expand-query 生成的 buyer_personas ─
    //
    // 设计：原有 p1_maps_dist / p1_maps_trading 把 category 当 query 主词，命中的多是
    // "卖该品类的供应商门店"（如纸箱搜索 → A-Z Packaging, Welch Packaging）。
    //
    // 业态画像反向找买家：用 LLM 推断的下游应用业态（如"纸箱"对应"electronics
    // manufacturer / food processor / e-commerce warehouse / 3pl"）作为 query 主词，
    // Maps 命中的就是真实采购该品类的业态实体（电商仓库、食品厂等）。
    //
    // 限速：最多 3 个高分 persona × min(3, mapsCities.length 或单国家) = 最多 9 次 Maps 调用。
    // 成本：Google Places 单次 ~$0.017，9 次 = ~$0.15/job，可接受。
    p1_maps_personas: (async () => {
      const personas = Array.isArray(pillar0Payload.buyer_personas)
        ? pillar0Payload.buyer_personas
            .filter((p) => p && typeof p.industry_en === 'string' && p.industry_en.trim())
            .slice(0, 3)  // 限速：最多 3 个高分 persona
        : [];
      if (personas.length === 0) return [];  // 无业态画像时跳过（不影响向后兼容）

      const cityList = mapsCities.length > 0 ? mapsCities.slice(0, 3) : [null];  // 限速：最多 3 城市
      const queries = [];
      for (const persona of personas) {
        const personaTerm = String(persona.industry_en).trim();
        for (const city of cityList) {
          queries.push({
            city,
            personaName: persona.industry_zh || personaTerm,
            q: city ? `${personaTerm} "${city}" ${countryName}` : `${personaTerm} ${countryName}`,
          });
        }
      }
      console.log(`[step1] p1_maps_personas: ${queries.length} queries (${personas.length} personas × ${cityList.length} cities)`);

      const arrs = await Promise.all(queries.map(({ city, personaName, q }) =>
        fetchPlacesWithFallback(q, cc, placeTypeBlacklist, mapTypesPrefer).then((ps) =>
          ps.map((p) => ({ ...p, _city: city, _persona: personaName }))
        )
      ));
      const seen = new Set();
      return arrs.flat()
        .filter((p) => p.website || p.phoneNumber)
        .filter((p) => {
          const k = (p.place_id || p.website || `${p.title}|${p.address}`).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .map((p) => ({
          title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber,
          pillar: 'Pillar 1 LBS', intent_signal: 'PERSONA_VERIFIED_BUYER',
          _gmaps_source: p._source || 'serper_places',
          _city: p._city || null, _persona: p._persona || null,
          maps_url: p.maps_url || null, place_id: p.place_id || null,
        }));
    })(),

    // ── P2: 公司官网直接搜索（在目标国TLD下找自述为进口商/批发商的公司） ─────
    // 关键：用 site:.vn 等TLD直接找公司网站，不找聚合站
    p2_direct_importer: searchOrganicMultiPage(
      `${OQ} (importer OR wholesaler OR distributor) ${tld} -site:alibaba.com -site:made-in-china.com`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 2 Direct', 'SELF_DECLARED_IMPORTER')),

    p2_sourcing_intent: searchOrganicMultiPage(
      `${OQ} ("we import" OR "we source" OR "our suppliers" OR "looking for supplier" OR "wanted suppliers") ${tld}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 2 Direct', 'ACTIVE_SOURCING')),

    // ── P3: 采购招聘信号（最可靠的买家信号之一：招采购经理 = 一定在采购）  ────
    //
    // 设计修订（2026-05）：
    //   原版本 -site:linkedin.com -site:glassdoor.com 主动排除主流招聘平台，
    //   导致命中率极低——而 LinkedIn/Glassdoor 恰是采购岗位招聘的主战场。
    //
    // 现版本：保留 LinkedIn/Glassdoor 搜索结果，由 fromOrganic 自动识别
    //   SIGNAL_SOURCE_HOSTS 把这些站的 link → null + source_url，避免被当
    //   公司主页域名（与 P11 LinkedIn 现有 source_url 模式一致）。
    //   step2 LLM 从招聘 snippet（"XX 公司招聘采购经理"）抽公司名 → step3 富化。
    p3_jobs_procurement: searchOrganicMultiPage(
      // Batch D.1：把 anchor 词加进 query，避免"procurement manager"拉到金融/IT 招聘
      anchorPrimary
        ? `"${anchorPrimary}" "procurement manager" OR "category manager" OR "buyer" job ${tld}`
        : `${OQ} ("procurement manager" OR "import manager" OR "sourcing manager" OR "purchasing manager") job ${tld}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 3 Jobs', 'PROCUREMENT_HIRING')),

    p3_jobs_buyer: searchOrganicMultiPage(
      anchorPrimary
        ? `"${anchorPrimary}" buyer job hiring ${countryName}`
        : `${OQ} ("buyer" OR "import buyer" OR "commercial buyer") job hiring ${countryName}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 3 Jobs', 'BUYER_HIRING')),

    // ── P4: 主动询盘意图（RFQ / 供应商征集 — 最明确的买家自我标识） ──────────
    p4_rfq: searchOrganicMultiPage(
      `${OQ} (RFQ OR "request for quotation" OR "request for proposal" OR "tender" OR "供应商征集") ${tld}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 4 Intent', 'RFQ_POSTED')),

    p4_sourcing_post: searchOrganicMultiPage(
      `${OQ} ("looking for manufacturers" OR "need factory" OR "sourcing from China" OR "procurement notice") ${countryName}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 4 Intent', 'SOURCING_POST')),

    // ── P5: 政府采购/招标（机构采购商，预算确定，信号最强） ─────────────────
    p5_tenders: searchOrganicMultiPage(
      `${OQ} (tender OR RFP OR "request for proposal" OR procurement) (${tld} OR site:.gov.${cc})`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 5 Tenders', 'GOV_PROCUREMENT')),

    // ── P6: 行业协会与进口商目录（结构化来源） ─────────────────────────────
    // 修复说明：原来搜 "exhibitor list"（展商名录）找到的是卖家不是买家。
    // 改为：搜买家参观/注册信息，或进口商协会会员名录
    p6_buyer_assoc: searchOrganicMultiPage(
      `${OQ} importers association OR buyers club OR "member directory" ${countryName}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 6 Association', 'ASSOCIATION_MEMBER')),

    p6_trade_show_buyer: searchOrganicMultiPage(
      `${OQ} ("buyer visitor" OR "visitor registration" OR "trade visitors" OR "buying mission") ${year} ${countryName}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 6 Association', 'TRADE_SHOW_BUYER')),

    // ── P7: 海关/贸易信号（真实进口行为，数据最权威） ───────────────────────
    //
    // 设计：分双路并行，互补抓取：
    //
    //   ① p7_customs_direct: 搜"含海关关键词的公司主页"（少数大公司在主页明示进口资质）
    //      → 返回公司官网 → step3 直接富化
    //
    //   ② p7_customs_signal_source（新增 2026-05）: 直接 site: 限定海关聚合站
    //      → 返回 importyeti / volza / panjiva 的公司清单页面
    //      → fromOrganic 自动把 link 设为 null + source_url，snippet 含公司名
    //      → step2 LLM 从 snippet 抽公司名 → step3 用公司名独立解析 domain 富化
    //      → 这是从"靠公司主页 SEO"→"靠贸易数据库实证"的范式升级
    p7_customs_direct: searchOrganicMultiPage(
      `${OQ} ("import" OR "importer of record" OR "customs entry" OR "HS code" OR "HTS") ${tld} company`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 7 Customs', 'CUSTOMS_SIGNAL')),

    p7_customs_signal_source: searchOrganicMultiPage(
      `${OQ} importer "${countryName}" (site:importyeti.com OR site:volza.com OR site:panjiva.com)`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 7 Customs', 'CUSTOMS_DB')),

    p7_bol_signal: searchOrganicMultiPage(
      `${OQ} ("bill of lading" OR "海运提单" OR "شحنة" OR "connaissement") importer "${countryName}"`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 7 Customs', 'BOL_SIGNAL')),

    // ── P8: 电商买家信号（B2B电商平台上的买家侧入口） ────────────────────────
    p8_b2b_buyer: searchOrganicMultiPage(
      `${OQ} buyer OR "trade buyer" OR "retail buyer" ${countryName} -site:alibaba.com -site:made-in-china.com -site:globalsources.com`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 8 B2B', 'B2B_BUYER')),

    p8_ecommerce_import: searchOrganicMultiPage(
      `${OQ} ("private label" OR "OEM buyer" OR "contract manufacturing") ${countryName}`,
      cc, organicNum
    ).then(r => fromOrganic(r, 'Pillar 8 B2B', 'PRIVATE_LABEL')),

    // ── P10: 区域专属高壁垒数据源定向搜索 ─────────────────────────────────────
    // 核心护城河：这些来源不是 Google 烂大街结果，而是各国本土商业数据库、
    // 海关系统、政府工商注册表、行业协会名录。
    // 命中这些来源的公司，经过交叉验证后置信度可比普通 Serper 搜索高 15-40 点。
    p10_verified_sources: Promise.resolve().then(() => {
      const registry = getVerifiedSources();
      const allSourceGroups = Object.values(registry.sources || {});
      const allSources = allSourceGroups.flat();

      // 只取覆盖当前国家的来源，最多选 4 个（避免 Serper 配额超限）
      const applicableSources = allSources
        .filter(src => Array.isArray(src.countries) && src.countries.includes(cc))
        .sort((a, b) => (b.source_confidence_boost || 0) - (a.source_confidence_boost || 0))
        .slice(0, 4);

      if (applicableSources.length === 0) return [];

      // 对每个适用的来源并发发起定向搜索
      return Promise.all(
        applicableSources.map(src => {
          // 把 search_strategy 模板里的 ${category} 替换为实际品类
          const q = (src.search_strategy || `site:${src.domain} ${OQ}`)
            .replace(/\$\{category\}/g, category)
            .replace(/\$\{countryName\}/g, countryName);

          return searchOrganicMultiPage(q, cc, organicNum).then(r =>
            r.map(o => ({
              ...o,
              pillar:                  'Pillar 10 VerifiedSource',
              intent_signal:           src.intent_signals?.[0] || 'VERIFIED_SOURCE',
              verified_source_id:      src.id,
              verified_source_domain:  src.domain,
              verified_source_boost:   src.source_confidence_boost || 0,
            }))
          ).catch(() => []);
        })
      ).then(arrs => arrs.flat());
    }),

    // ── P11: LinkedIn 采购决策人 X 光透视 ────────────────────────────────────
    // 设计逻辑：LinkedIn URL 在垃圾名单里会被域名过滤器过滤，所以不能直接用 LinkedIn URL。
    // 改为：搜 LinkedIn 职位页/公司页，仅从 snippet 中提取【公司名+采购头衔】信号
    // 由 Step2 LLM 的 extractCompanyFromSnippet 负责从 snippet 里抽公司名。
    // 最终 lead.domain 不是 linkedin.com，而是 Step2 推断出的空域名（待 Step3 补全）。
    p11_linkedin_decision: searchOrganic(
      // Batch D.1：LinkedIn 决策人查询用 anchor 替代品类原文，让 LinkedIn 的语义匹配
      // 落到具体行业（"wholesale cosmetics" 比 "护肝片" 更易命中决策人 profile）
      anchorPrimary
        ? `site:linkedin.com/in "${anchorPrimary}" ("Procurement Director" OR "Category Manager" OR "Sourcing Manager" OR "Head of Purchasing") ${countryName}`
        : `site:linkedin.com/in ${OQ} ("Procurement Director" OR "Category Manager" OR "Sourcing Manager" OR "Import Manager" OR "Head of Purchasing") ${countryName}`,
      cc, 20
    ).then(r => r.map(o => ({
      title:         o.title,
      link:          null,           // 不传 linkedin URL，避免被垃圾过滤器清除
      snippet:       o.snippet,      // snippet 里有公司名和职位，供 Step2 LLM 提取
      pillar:        'Pillar 11 LinkedIn',
      intent_signal: 'PROCUREMENT_DECISION_MAKER',
      source_url:    o.link,         // 保留原始 URL 供溯源，但不作为公司 domain
    }))),

    // ── 买家抓取矩阵 P_Y / P_FB / P_YT / P_X（Batch 3 新增） ─────────────────
    // 4 个平台 pillar 通过 site: 限定走公开 snippet，绝不登录态抓取；
    // matrix.platforms 为空时全开，含枚举值时仅启用对应平台。
    p_yellowpages: (async () => {
      const cityClause = mapsCities.length > 0 ? ` ("${mapsCities.slice(0, 3).join('" OR "')}")` : '';
      // Batch D.1：anchor 命中时把品类原文换成业态短语，避免黄页站把无关行业拉进来
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `${OQ}`;
      const q = `(site:yellowpages.com OR site:yelp.com OR site:europages.com OR site:kompass.com) ${subject} ${countryName}${cityClause}`;
      const r = await searchOrganicMultiPage(q, cc, organicNum);
      return r.map((o) => ({
        title: o.title, link: o.link, snippet: o.snippet,
        pillar: 'Pillar Yellow', intent_signal: 'YP_LISTING',
      }));
    })(),

    p_facebook_public: (async () => {
      const cityClause = mapsCities.length > 0 ? ` ("${mapsCities.slice(0, 3).join('" OR "')}")` : '';
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `${OQ}`;
      const q = `site:facebook.com ${subject} (buyer OR distributor OR importer OR wholesale) ${countryName}${cityClause}`;
      const r = await searchOrganicMultiPage(q, cc, organicNum);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar FB Public', intent_signal: 'FB_PUBLIC_PROFILE',
        source_url: o.link,
        // 公开主页 URL 直接挂到 lead.social_profile_urls，Step5 写入 L1 列
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    p_youtube_about: (async () => {
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `${OQ}`;
      const q = `site:youtube.com (inurl:about OR inurl:c OR inurl:@) ${subject} (company OR brand OR official) ${countryName}`;
      const r = await searchOrganicMultiPage(q, cc, organicNum);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar YT About', intent_signal: 'YT_ABOUT',
        source_url: o.link,
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    p_x_public: (async () => {
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `${OQ}`;
      const q = `(site:x.com OR site:twitter.com) ${subject} (buyer OR import OR procurement) ${countryName}`;
      const r = await searchOrganicMultiPage(q, cc, organicNum);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar X Public', intent_signal: 'X_PUBLIC',
        source_url: o.link,
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    // 2026-05-26 加 telegram_public（Telegram 融入数据通道 · 批次 T-A）：
    // Telegram 公开频道 / 讨论组在采购领域常见"我们正在找 X 厂家"这种询价 snippet。
    // 实现完全镜像 p_facebook_public：Serper site:t.me 搜 + 同款 OR 关键词组 +
    // 前 3 城市作 OR clause；link=null + source_url=原始（避免被当公司 domain 写 L1）。
    // 不强求 site 限定到 telegram.me — t.me 是官方主域，telegram.me 流量极少。
    p_telegram_public: (async () => {
      const cityClause = mapsCities.length > 0 ? ` ("${mapsCities.slice(0, 3).join('" OR "')}")` : '';
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `${OQ}`;
      const q = `site:t.me ${subject} (buyer OR procurement OR sourcing OR wholesale OR importer) ${countryName}${cityClause}`;
      const r = await searchOrganicMultiPage(q, cc, organicNum);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar TG Public', intent_signal: 'TG_PUBLIC',
        source_url: o.link,
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    // ── P9: Lookalike 裂变（种子反哺闭环核心）────────────────────────────────
    // 设计逻辑：
    //   Pillar0 把种子激活为 lead → Step5 把高置信 lead 写回 seed JSON
    //   → 下轮 Pillar9 用新种子搜"它的竞品是谁/同行是谁" → 找到同生态位买家
    // 这形成了一个"越用越深，自动扩网"的闭环。
    p9_lookalike: Promise.resolve().then(() => {
      const SEED_PATH = 'zhimao_seed_intelligence.json';
      try {
        if (!fs.existsSync(SEED_PATH)) return [];
        const seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
        // 只取本国 + 本品类相关的种子，随机挑最多 3 个做 Lookalike 查询（避免 Serper 超额）
        const relevant = seeds.filter(s =>
          s.country?.toLowerCase() === cc.toLowerCase() &&
          (!s.category || s.category.toLowerCase().includes(category.toLowerCase().split(' ')[0]))
        ).slice(0, 3);
        if (relevant.length === 0) return [];

        // 对每个种子并发搜它的竞品和同类公司
        return Promise.all(
          relevant.map(seed =>
            searchOrganicMultiPage(
              `${OQ} companies like "${seed.company_name}" OR competitors "${seed.company_name}" ${countryName} importer wholesaler`,
              cc, organicNum
            ).then(r => r.map(o => ({
              ...o, pillar: 'Pillar 9 Lookalike',
              intent_signal: 'LOOKALIKE', seed_company: seed.company_name,
            })))
          )
        ).then(arrs => arrs.flat());
      } catch { return []; }
    }),
  };

  if (controls.weights.generic < 0.35) {
    const organicKeys = [
      'p2_direct_importer', 'p2_sourcing_intent', 'p3_jobs_procurement', 'p3_jobs_buyer',
      'p4_rfq', 'p4_sourcing_post', 'p5_tenders', 'p6_buyer_assoc', 'p6_trade_show_buyer',
      'p7_customs_direct', 'p7_customs_signal_source', 'p7_bol_signal',
      'p8_b2b_buyer', 'p8_ecommerce_import',
      'p10_verified_sources', 'p9_lookalike',
    ];
    organicKeys.forEach((k) => { delete pillarPromises[k]; });
    console.log('[step1] Organic pillars OFF (generic weight < 0.35)');
  }
  if (controls.weights.geo < 0.35) {
    delete pillarPromises.p1_maps_dist;
    delete pillarPromises.p1_maps_trading;
    delete pillarPromises.p1_maps_personas;
    console.log('[step1] Maps pillars OFF (geo weight < 0.35)');
  }
  if (controls.weights.contact < 0.35) {
    delete pillarPromises.p_yellowpages;
    console.log('[step1] Yellowpages OFF (contact weight < 0.35)');
  }

  if (controls.disableLinkedin) {
    delete pillarPromises.p11_linkedin_decision;
    console.log('[step1] LinkedIn pillar DISABLED by reweight policy (entity delta=' + controls.entity.toFixed(3) + ')');
  }
  if (controls.disableLookalike) {
    delete pillarPromises.p9_lookalike;
    console.log('[step1] Lookalike pillar DISABLED by reweight policy (generic delta=' + controls.generic.toFixed(3) + ')');
  }

  // 买家抓取矩阵：6 平台白名单启停（matrix.platforms 为空 → 全开）
  if (matrix && Array.isArray(matrix.platforms) && matrix.platforms.length > 0) {
    if (!isPlatformEnabled(matrix, 'maps')) {
      delete pillarPromises.p1_maps_dist;
      delete pillarPromises.p1_maps_trading;
      delete pillarPromises.p1_maps_personas;
    }
    if (!isPlatformEnabled(matrix, 'yellowpages'))      delete pillarPromises.p_yellowpages;
    if (!isPlatformEnabled(matrix, 'facebook_public'))  delete pillarPromises.p_facebook_public;
    if (!isPlatformEnabled(matrix, 'linkedin_snippet')) delete pillarPromises.p11_linkedin_decision;
    if (!isPlatformEnabled(matrix, 'youtube_about'))    delete pillarPromises.p_youtube_about;
    if (!isPlatformEnabled(matrix, 'x_public'))         delete pillarPromises.p_x_public;
    if (!isPlatformEnabled(matrix, 'telegram_public'))  delete pillarPromises.p_telegram_public;
    console.log(`[step1] matrix.platforms whitelist applied: kept=${Object.keys(pillarPromises).filter(k => /^(p1_maps|p_|p11_)/.test(k)).join('|')}`);
  }

  // ── P6b 供应商模式：撤掉买家专属 pillar，注入供应商目录 / 工厂直采 pillar ────────
  // 保留 p0_seed（业务员喂入种子）与 p_pillar0_boolean（zhimao 已按 direction 生成 boolean），
  // 其余买家 organic/maps/customs/linkedin pillar 全撤；改抓 made-in-china / globalsources /
  // thomasnet / alibaba 目录（listing 页 link=null + source_url，snippet 带供应商名）+ 工厂直采官网。
  if (IS_SUPPLIER_MODE) {
    const buyerOnlyKeys = Object.keys(pillarPromises).filter(
      (k) => k !== 'p0_seed' && k !== 'p_pillar0_boolean',
    );
    buyerOnlyKeys.forEach((k) => { delete pillarPromises[k]; });
    // 供应商目录：listing 页 link=null + source_url（与 fromOrganic 信号源处理一致）
    const fromSupplierDir = (results, pillar, intent) => (results || []).map((o) => ({
      title: o.title, link: null, snippet: o.snippet, pillar, intent_signal: intent, source_url: o.link,
    }));
    const supDir = (host) => `${OQ} (manufacturer OR factory OR supplier OR exporter) site:${host}`;
    Object.assign(pillarPromises, {
      s_made_in_china: searchOrganicMultiPage(supDir('made-in-china.com'), cc, organicNum)
        .then((r) => fromSupplierDir(r, 'Pillar S MadeInChina', 'SUPPLIER_DIRECTORY')).catch(() => []),
      s_global_sources: searchOrganicMultiPage(supDir('globalsources.com'), cc, organicNum)
        .then((r) => fromSupplierDir(r, 'Pillar S GlobalSources', 'SUPPLIER_DIRECTORY')).catch(() => []),
      s_thomasnet: searchOrganicMultiPage(supDir('thomasnet.com'), cc, organicNum)
        .then((r) => fromSupplierDir(r, 'Pillar S ThomasNet', 'SUPPLIER_DIRECTORY')).catch(() => []),
      s_alibaba: searchOrganicMultiPage(`${OQ} (manufacturer OR factory) site:alibaba.com`, cc, organicNum)
        .then((r) => fromSupplierDir(r, 'Pillar S Alibaba', 'SUPPLIER_DIRECTORY')).catch(() => []),
      // 工厂 / 出口商直采官网（保留 link，真实供应商主页）
      s_factory_direct: searchOrganicMultiPage(
        `${OQ} (manufacturer OR factory OR "OEM" OR "ODM" OR exporter) official website`, cc, organicNum,
      ).then((r) => fromOrganic(r, 'Pillar S Factory', 'SUPPLIER_DIRECT')).catch(() => []),
      s_exporter: searchOrganicMultiPage(
        `${OQ} (exporter OR "export company" OR "trading company") ${countryName}`, cc, organicNum,
      ).then((r) => fromOrganic(r, 'Pillar S Exporter', 'SUPPLIER_DIRECT')).catch(() => []),
    });
    console.log(`[step1] SUPPLIER MODE: removed ${buyerOnlyKeys.length} buyer pillars, injected 6 supplier-directory/factory pillars`);
  }

  // ── P1-B：分层 pillar + enough-hits 早停（默认开，STEP1_TIERED=0 回退全并行）──
  const STEP1_TIERED = process.env.STEP1_TIERED !== '0';
  const ENOUGH_HITS = Math.max(Number(process.env.STEP1_ENOUGH_HITS || 80), 20);

  const TIER1_KEYS = [
    'p0_seed', 'p1_maps_dist', 'p1_maps_trading',
    'p2_direct_importer', 'p2_sourcing_intent',
  ];
  const TIER2_KEYS = [
    'p3_jobs_procurement', 'p3_jobs_buyer', 'p4_rfq', 'p4_sourcing_post',
    'p5_tenders', 'p6_buyer_assoc', 'p6_trade_show_buyer',
    'p8_b2b_buyer', 'p8_ecommerce_import',
  ];
  const TIER3_KEYS = [
    'p7_customs_direct', 'p7_bol_signal', 'p10_verified_sources',
    'p11_linkedin_decision', 'p9_lookalike',
  ];

  async function collectPillarResults(keys) {
    const subset = {};
    for (const k of keys) {
      if (pillarPromises[k]) subset[k] = pillarPromises[k];
    }
    const labels = Object.keys(subset);
    if (labels.length === 0) return [];
    const results = await Promise.allSettled(Object.values(subset));
    const batch = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        console.log(`[step1] ${labels[i]}: ${r.value.length} signals`);
        batch.push(...r.value);
      } else if (r.status === 'rejected') {
        console.warn(`[step1] ${labels[i]} failed (non-fatal): ${r.reason?.message || r.reason}`);
      }
    });
    return batch;
  }

  const depthLabel = SEARCH_PAGE === 1 ? '浅层(p1)' : `深水区(p${SEARCH_PAGE} ≈ 第${(SEARCH_PAGE-1)*20+1}-${SEARCH_PAGE*20}条)`;
  const pillarCount = Object.keys(pillarPromises).length;
  console.log(`[step1] Launching ${pillarCount} pillars for "${category}" in ${countryName} [${depthLabel}]${STEP1_TIERED ? ' (tiered)' : ' (all-parallel)'}...`);
  if (controls._policyCount > 0) {
    console.log(`[step1] Active policies: ${controls._policyCount}, weights:`, JSON.stringify(controls.weights));
  }
  if (controls.domainBlacklist.length > 0) {
    console.log(`[step1] Domain blacklist (${controls.domainBlacklist.length}): ${controls.domainBlacklist.slice(0, 5).join(', ')}...`);
  }
  const startedAt = Date.now();

  let allLeads = [];
  if (STEP1_TIERED) {
    allLeads.push(...await collectPillarResults(TIER1_KEYS));
    console.log(`[step1] tier1 raw signals: ${allLeads.length}`);
    if (allLeads.length < ENOUGH_HITS) {
      allLeads.push(...await collectPillarResults(TIER2_KEYS));
      console.log(`[step1] tier1+tier2 raw signals: ${allLeads.length}`);
    } else {
      console.log(`[step1] P1-B early-stop: tier1 >= ${ENOUGH_HITS}, skipping tier2/3`);
    }
    if (allLeads.length < ENOUGH_HITS) {
      allLeads.push(...await collectPillarResults(TIER3_KEYS));
      console.log(`[step1] all tiers raw signals: ${allLeads.length}`);
    }
  } else {
    allLeads.push(...await collectPillarResults(Object.keys(pillarPromises)));
  }

  // 注入时间戳
  const nowIso = new Date().toISOString();
  allLeads.forEach(l => { l.source_timestamp = l.source_timestamp || nowIso; });

  // P0 出口过滤：丢弃垃圾域名 + 策略域名黑名单 + 地理过滤
  const beforeFilter = allLeads.length;
  // 构建策略域名黑名单 Set（O(1) 查找）
  const blacklistSet = new Set(controls.domainBlacklist.map(d => d.toLowerCase()));

  let suppressDropped = 0;
  let filteredLeads = allLeads.filter(l => {
    if (leadMatchesKeywordSuppress(l, allKeywordSuppress)) {
      suppressDropped += 1;
      return false;
    }
    if (isJunkLead(l)) return false;
    // 策略域名黑名单过滤
    if (blacklistSet.size > 0 && l.link) {
      try {
        const host = new URL(l.link).hostname.toLowerCase().replace(/^www\./, '');
        if (blacklistSet.has(host)) return false;
      } catch { /* ignore */ }
    }
    return true;
  });

  if (controls.enforceGeo) {
    const countryHint = String(countryName || '').toLowerCase();
    const beforeGeo = filteredLeads.length;
    filteredLeads = filteredLeads.filter((l) => {
      const combined = `${l.title || ''} ${l.snippet || ''} ${l.link || ''}`.toLowerCase();
      return combined.includes(countryHint) || combined.includes(`.${cc.toLowerCase()}`);
    });
    console.log(`[step1] Geo filter (enforced): ${beforeGeo} → ${filteredLeads.length} (removed ${beforeGeo - filteredLeads.length} geo-mismatched)`);
  }

  // 时效性过滤：数据陈旧投诉时，过滤掉明显旧数据（标题/摘要中含 3 年前年份）
  if (controls.enforceRecency) {
    const currentYear = new Date().getFullYear();
    const staleYearRe = new RegExp(`\\b(${currentYear - 3}|${currentYear - 4}|${currentYear - 5})\\b`);
    const beforeRecency = filteredLeads.length;
    filteredLeads = filteredLeads.filter(l => {
      const combined = `${l.title || ''} ${l.snippet || ''}`;
      return !staleYearRe.test(combined);
    });
    if (beforeRecency > filteredLeads.length) {
      console.log(`[step1] Recency filter (enforced): removed ${beforeRecency - filteredLeads.length} stale results`);
    }
  }

  const junkCount = beforeFilter - filteredLeads.length;

  // Pillar 分布统计（帮助运营判断哪些渠道质量好）
  const pillarStats = {};
  filteredLeads.forEach(l => { pillarStats[l.pillar] = (pillarStats[l.pillar] || 0) + 1; });

  console.log(`[step1] Done in ${Date.now() - startedAt}ms. Total=${filteredLeads.length} (junk_filtered=${junkCount}, suppress_dropped=${suppressDropped})`);
  console.log(`[step1] Pillar distribution:`, JSON.stringify(pillarStats, null, 2));

  const jobId = process.env.DISCOVERY_JOB_ID || '';
  if (jobId) {
    appendFunnelStep(jobId, 'step1', {
      before_filter: beforeFilter,
      after_filter: filteredLeads.length,
      junk_filtered: junkCount,
      suppress_dropped: suppressDropped,
      pillar_stats: pillarStats,
      organic_num: organicNum,
      boolean_queries: booleanQueries.length,
      procurement_queries: procurementQueries.length,
    });
  }

  fs.writeFileSync(outputFile, JSON.stringify(filteredLeads, null, 2));
}

run().catch(e => { console.error('[step1] fatal:', e); process.exit(1); });
