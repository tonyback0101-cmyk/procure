/**
 * Step 5 — Routing & Persistence Gateway
 *
 * 1. Writes hot leads (score >= 90 with contact) to local SQLite main_db
 * 2. Queues lower-score leads for future enrichment
 * 3. Persists qualified leads to Supabase: data_intel_l1_companies + data_intel_graph_edges
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
require('./load-env');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createSupabaseClient } = require('./v8_supabase_client');
const { directIngestQualifiedLeads } = require('./v8_direct_l1_ingest');
const { mirrorBuyerPersonsFromLeads } = require('./v8_buyer_persons_mirror');
const { evaluateLead, evaluateLeadSupplier, isNegativeKeywordHit } = require('./v8_quality_gate');
const { appendFunnelStep } = require('./v8_lib_funnel');
const { enqueueEnrichmentLeads } = require('./v8_lib_enrichment_supabase');
const { readIncrementalBlacklist, readIcpContext } = require('./v8_lib_pillar0');

const [inputFile, outputFile] = process.argv.slice(2);

// P6 ICP context（从 PILLAR0_PAYLOAD.icp_context 读取，submit/route.ts P5 注入）
const ICP_CTX = readIcpContext();
const IS_SUPPLIER_MODE = ICP_CTX.direction === 'find_suppliers';
const NEGATIVE_KEYWORDS = ICP_CTX.negativeKeywords; // string[]（已小写）

const DISCOVERY_JOB_ID = process.env.DISCOVERY_JOB_ID || null;
const SKIP_SQLITE = process.env.SKIP_SQLITE === 'true';
const FALLBACK_PATH = process.env.OPS_FALLBACK_PATH || 'ops_hot_inbox_fallback.json';

const SEED_PATH = 'zhimao_seed_intelligence.json';
const SEED_CONFIDENCE_MIN = Number(process.env.SEED_CONFIDENCE_MIN) || 90;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[step5] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Local SQLite ────────────────────────────────────────────────────────────
let insertMain = null;
let insertQueue = null;
if (!SKIP_SQLITE) {
  const db = new Database('zhimao_v8_matrix.sqlite');
  db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        primary_email TEXT, primary_phone TEXT,
        confidence_score INTEGER, entity_role TEXT, source TEXT, timestamp TEXT,
        UNIQUE(company_name, country)
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        score INTEGER, retries INTEGER DEFAULT 0,
        UNIQUE(company_name, country)
    )`);
  insertMain = db.prepare(
    `INSERT OR IGNORE INTO main_db (company_name, domain, country, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertQueue = db.prepare(
    `INSERT OR IGNORE INTO enrichment_queue (company_name, domain, country, score) VALUES (?, ?, ?, ?)`,
  );
} else {
  console.log('[step5] SKIP_SQLITE=true, local sqlite writes disabled.');
}

function writeFallbackInbox(items, reason) {
  if (!Array.isArray(items) || items.length === 0) return;
  let existing = [];
  try {
    if (fs.existsSync(FALLBACK_PATH)) {
      existing = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch (_) {
    existing = [];
  }

  const now = new Date().toISOString();
  const records = items.map((lead) => ({
    reason,
    created_at: now,
    discovery_job_id: DISCOVERY_JOB_ID,
    lead,
  }));
  existing.push(...records);
  fs.writeFileSync(FALLBACK_PATH, JSON.stringify(existing, null, 2));
  console.warn(`[step5] fallback inbox appended: +${records.length} -> ${FALLBACK_PATH} (total=${existing.length})`);
}

// ── Quality Gate — 与 zhimao computeQualityGrade 对齐（v8_quality_gate）────

function applySourceBoost(lead) {
  const pillarBoost = Number(lead.verified_source_boost || 0);
  const taxBoost = lead.tax_verified ? 35 : 0;
  let total = pillarBoost + taxBoost;

  const hasHVC = lead.verified_source_id;
  const hasTax = lead.tax_verified;
  const hasBOL =
    lead.intent_signal === 'BOL_SIGNAL' || lead.intent_signal === 'CUSTOMS_SIGNAL';
  const hasDecisionMaker = lead.intent_signal === 'PROCUREMENT_DECISION_MAKER';
  const hasContact = !!(lead.primary_email || lead.primary_phone);
  const ib = lead.inference_breakdown;
  const hasHighL3 = ib && ib.confidence_tier === 'High';

  const dimensionCount = [hasHVC, hasTax || hasBOL, hasDecisionMaker, hasContact && hasHighL3].filter(
    Boolean,
  ).length;

  if (dimensionCount >= 2) {
    // 不再强制 >= 92。Combo 仅作为 +20 增量 boost，让 confidence_score 真实反映
    // "contact 完整度 + L3 推断"——避免 BOL_SIGNAL（航运/海关数据）+ 流水号邮箱
    // 这种"商业证据强但联系方式垃圾"的 lead 被强制拉到 92 误导用户。
    // 商业证据强度由 quality_grade=premium 单独表达，与 score 解耦。
    const prev = Number(lead.confidence_score ?? 60) + total;
    lead.confidence_score = Math.min(100, prev + 20);
    lead._combo_triggered = true;
    return lead;
  }

  if (total > 0) {
    const prev = Number(lead.confidence_score ?? 60);
    lead.confidence_score = Math.min(100, prev + total);
  }
  return lead;
}

const totalLeads = leads.length;
const gradeStats = { premium: 0, qualified: 0, unqualified: 0 };
// Batch A.4：ICP 闸门阈值
//
//   soft (默认)  → 只丢 none（明确无关，如房产中介、餐厅），保留 low/medium/high
//   balanced     → 丢 low+none
//   off          → 不拦截任何（全量进 L1，人工审核）
//
// 默认保持 soft：买家抓取场景中 industry_match=low 往往是采购频次低但真实进口的企业
// （如物流公司采购纸箱、贸易商采购包装材料），balanced 会把它们整批丢弃。
const ICP_THRESHOLD = String(process.env.ICP_MATCH_THRESHOLD || 'soft').toLowerCase();
const icpStats = { high: 0, medium: 0, low: 0, none: 0, unset: 0 };

// 目标国：从 worker 注入的 DISCOVERY_COUNTRY_ISO，用于校验 lead.country 是否一致。
// 实测 (job 2ba18da6) 36 条 MY 结果中有 6 条是 US/DE/AU/CN，根因是 LLM 推断的国家与
// 用户搜索目标国不一致仍然写入。这里做兜底过滤：跨国结果直接降级为 unqualified，
// 不写入 L1（用户搜 MY 看到 CN 公司是核心错乱体验）。
const TARGET_COUNTRY_ISO = String(process.env.DISCOVERY_COUNTRY_ISO || '').toUpperCase();
// 无国家门槛根治（2026-07，双仓镜像 zhimao buildRefreshCandidates GLOBAL 哨兵）：
// GLOBAL 任务是内贸/全域搜索，不该按目标国裁跨国结果——否则每条 leadCountry!==GLOBAL 全被丢。
const IS_GLOBAL_JOB = TARGET_COUNTRY_ISO === 'GLOBAL' || TARGET_COUNTRY_ISO === '';

// ── 业态画像树工程：反向验证闸门 ─────────────────────────────────────────────
// step3 L3 prompt 已在 DISCOVERY_CATEGORY 注入时输出 target_category_match：
//   high   → 该公司核心采购该品类（强买家）
//   medium → 偶发性采购（弱买家但有意义）
//   low    → 不太可能采购（业态相邻但无明确路径）
//   none   → 明确不采购（服务业、不同供应链）
// 闸门策略与 ICP 阈值对齐，但更激进：reverse-verify 失败直接判为 unqualified，
// 因为这是 LLM 在拿到 company_name + snippet 后做的"是否会买"的反向推断，
// 比 industry_match 更强、更直接。
//
// REVERSE_VERIFY_MODE：
//   strict   → 丢 low + none（设计建议生产值；切默认前必须先 A/B，见下）
//   balanced → 仅丢 none
//   off      → 不拦截（用户取消反向验证、调试用）
//
// RC-2/RC-3（2026-06-19，设计单源 §B3）：默认已切 strict —— 业主授权直接落地。
// strict = 丢 reverse-verify low+none（设计推荐生产值），反向验证是"该公司是否会买此品类"
// 的最强、最直接信号，比 industry_match 更可靠，故作为主闸门收紧到 strict。
// 仍保留两个逐 job 杠杆用于回退 / 进一步收紧：
//   REVERSE_VERIFY_MODE=balanced           逐 job 回退到只丢 none（信息薄/小众品类临时放宽）
//   REVERSE_VERIFY_INCLUDE_UNSET=1         strict 下把 L3 失败(unset) 也按 low 处理（RC-2b，更激进，默认关）
// 一致性约定（RC-3）：ICP_MATCH_THRESHOLD 维持 soft（轻闸门），由 strict 反向验证担任主质量闸门，
//   避免两道闸门同时收紧造成对小众真买家的双重误杀。
const REVERSE_VERIFY_MODE = String(process.env.REVERSE_VERIFY_MODE || 'strict').toLowerCase();
// RC-2b 杠杆：strict 模式下是否把 unset（L3 未产出反向验证）也判失败丢弃。默认关。
const REVERSE_DROP_UNSET =
  REVERSE_VERIFY_MODE === 'strict' &&
  /^(1|true|yes|on)$/i.test(String(process.env.REVERSE_VERIFY_INCLUDE_UNSET || ''));
const reverseStats = { high: 0, medium: 0, low: 0, none: 0, unset: 0 };
const TARGET_CATEGORY_FROM_ENV = String(process.env.DISCOVERY_CATEGORY || '').trim();

const validLeads = leads
  .map(applySourceBoost)
  .filter((lead) => {
    const leadCountry = String(lead.country || '').trim().toUpperCase();
    if (!leadCountry) return false;

    // 跨国校验：lead.country 与本次 job 目标国不一致 → 降级丢弃
    // 例外：seed/HVC 类来源（pillar 0）是种子库反哺，允许跨国
    // GLOBAL 任务（无国家门槛）跳过此校验：任意国家的买家都保留。
    if (!IS_GLOBAL_JOB && TARGET_COUNTRY_ISO && leadCountry !== TARGET_COUNTRY_ISO) {
      const isSeedSource = String(lead.pillar || '').match(/Pillar 0|Seed/i) || lead.verified_source_id;
      if (!isSeedSource) {
        lead._quality_grade = 'unqualified';
        gradeStats.unqualified = (gradeStats.unqualified || 0) + 1;
        return false;
      }
    }

    // P6 负向关键词前置拦截（ICP grounding，优先于其他质量判断）
    if (isNegativeKeywordHit(lead.company_name, lead.description || lead.snippet, NEGATIVE_KEYWORDS)) {
      lead._quality_grade = 'unqualified';
      lead.reject_codes = Array.isArray(lead.reject_codes)
        ? [...lead.reject_codes, 'NEGATIVE_KEYWORD_HIT']
        : ['NEGATIVE_KEYWORD_HIT'];
      gradeStats.unqualified = (gradeStats.unqualified || 0) + 1;
      return false;
    }

    const matchRaw = String(lead.industry_match || '').toLowerCase();
    const m = ['high', 'medium', 'low', 'none'].includes(matchRaw) ? matchRaw : 'unset';
    icpStats[m] += 1;
    // 闸门逻辑：
    //   balanced → 丢 low + none
    //   soft     → 只丢 none
    //   off      → 不拦截
    const shouldDrop =
      (ICP_THRESHOLD === 'balanced' && (m === 'low' || m === 'none')) ||
      (ICP_THRESHOLD === 'soft'     && m === 'none');
    if (shouldDrop) {
      lead._quality_grade = 'unqualified';
      lead.reject_codes = Array.isArray(lead.reject_codes)
        ? [...lead.reject_codes, 'ICP_MATCH_LOW']
        : ['ICP_MATCH_LOW'];
      gradeStats.unqualified = (gradeStats.unqualified || 0) + 1;
      return false;
    }

    // Top-N 截断溢出：未跑 Step3，无 contact/L3；仍入库展示（低 confidence 排后），
    // 跳过 evaluateLead 的 NO_CONTACT / L3 闸门，也不进 enrichment_queue。
    if (lead._enrich_deferred) {
      lead._quality_grade = 'qualified';
      lead.needs_human_review = true;
      gradeStats.qualified = (gradeStats.qualified || 0) + 1;
      if (TARGET_CATEGORY_FROM_ENV && !IS_SUPPLIER_MODE) reverseStats.unset += 1;
      return true;
    }

    // P6 方向感知评分：供应商模式用 evaluateLeadSupplier，买家模式沿用 evaluateLead。
    // 2026-05-23：传 category（DISCOVERY_CATEGORY）启用 CATEGORY_B2C_WHITELIST，
    //   面粉→bakery / 化妆品→spa / 海鲜→restaurant 等真买家不再被一刀切；
    //   见 v8_quality_gate.js BIZ_ANTI_GROUPS + CATEGORY_B2C_WHITELIST 双仓镜像段。
    // 根因修复（数据质量）：evaluateLead 的第二参是 opts 对象 { category }，
    // 旧代码 evalFn(lead, "<category string>", ...) 让 opts.category=undefined → category=null
    // → CATEGORY_B2C_WHITELIST 豁免在生产买家路径整段失效（面粉→bakery / 海鲜→restaurant /
    // 化妆品→spa 真买家被 biz_type_blacklisted 误杀）。回归脚本用对象签名调用所以一直全过，
    // 掩盖了该 caller bug。evaluateLeadSupplier 用位置参 (lead, category, negativeKeywords)，
    // 各自按正确签名分支调用。
    const { qualified, grade } = IS_SUPPLIER_MODE
      ? evaluateLeadSupplier(lead, TARGET_CATEGORY_FROM_ENV, NEGATIVE_KEYWORDS)
      : evaluateLead(lead, { category: TARGET_CATEGORY_FROM_ENV });

    // ── 业态画像树反向验证闸门 ───────────────────────────────────────────────
    // 仅在用户输入了 TARGET_CATEGORY 且 REVERSE_VERIFY_MODE != 'off' 时生效。
    // 例外：seed/HVC 来源（pillar 0）跳过反向验证（已是种子库已验证企业）。
    const isSeedSource =
      String(lead.pillar || '').match(/Pillar 0|Seed/i) || lead.verified_source_id;
    // P6b 供应商模式：反向验证是"该公司是否买家"的买家闸门，对供应商无意义且会误杀，跳过。
    if (
      TARGET_CATEGORY_FROM_ENV &&
      REVERSE_VERIFY_MODE !== 'off' &&
      !IS_SUPPLIER_MODE &&
      !isSeedSource &&
      lead.inference_breakdown &&
      typeof lead.inference_breakdown === 'object'
    ) {
      const rmRaw = String(lead.inference_breakdown.target_category_match || '').toLowerCase();
      const rm = ['high', 'medium', 'low', 'none'].includes(rmRaw) ? rmRaw : 'unset';
      reverseStats[rm] += 1;
      const reverseDrop =
        (REVERSE_VERIFY_MODE === 'strict'   && (rm === 'low' || rm === 'none')) ||
        (REVERSE_VERIFY_MODE === 'balanced' && rm === 'none') ||
        // RC-2b：strict + REVERSE_VERIFY_INCLUDE_UNSET=1 时，L3 失败也按 low 处理
        (REVERSE_DROP_UNSET && rm === 'unset');
      if (reverseDrop) {
        lead._quality_grade = 'unqualified';
        lead.reject_codes = Array.isArray(lead.reject_codes)
          ? [...lead.reject_codes, 'REVERSE_VERIFY_FAIL']
          : ['REVERSE_VERIFY_FAIL'];
        gradeStats.unqualified = (gradeStats.unqualified || 0) + 1;
        return false;
      }
      // 通过反向验证：把 evidence 透传到 lead 顶层（给前端 lead 卡展示"为什么这家公司是买家"）
      if (lead.inference_breakdown.target_category_evidence) {
        lead.target_category_evidence = lead.inference_breakdown.target_category_evidence;
      }
      if (rm === 'medium' || rm === 'low') lead.needs_human_review = true;
    } else if (TARGET_CATEGORY_FROM_ENV && !isSeedSource && !IS_SUPPLIER_MODE) {
      // L3 没填反向验证（SKIP_L3_INFERENCE 或 LLM 失败）→ 计入 unset。
      // RC-2b：strict + REVERSE_VERIFY_INCLUDE_UNSET=1 时按 low 处理并丢弃；否则不拦截（默认）。
      reverseStats.unset += 1;
      if (REVERSE_DROP_UNSET) {
        lead._quality_grade = 'unqualified';
        lead.reject_codes = Array.isArray(lead.reject_codes)
          ? [...lead.reject_codes, 'REVERSE_VERIFY_FAIL']
          : ['REVERSE_VERIFY_FAIL'];
        gradeStats.unqualified = (gradeStats.unqualified || 0) + 1;
        return false;
      }
    }

    gradeStats[grade] = (gradeStats[grade] || 0) + 1;
    lead._quality_grade = grade;
    if (m === 'medium') lead.needs_human_review = true;
    return qualified;
  });

const droppedQuality = totalLeads - validLeads.length;
const reverseLog = TARGET_CATEGORY_FROM_ENV
  ? ` reverse(${REVERSE_VERIFY_MODE},${TARGET_CATEGORY_FROM_ENV})=high:${reverseStats.high} medium:${reverseStats.medium} low:${reverseStats.low} none:${reverseStats.none} unset:${reverseStats.unset}`
  : '';
if (droppedQuality > 0) {
  console.log(
    `[step5] quality-gate veto: dropped ${droppedQuality}/${totalLeads}. grade=premium:${gradeStats.premium} qualified:${gradeStats.qualified} unqualified:${gradeStats.unqualified}; icp=high:${icpStats.high} medium:${icpStats.medium} low:${icpStats.low} none:${icpStats.none} unset:${icpStats.unset} (threshold=${ICP_THRESHOLD})${reverseLog}`,
  );
} else {
  console.log(
    `[step5] quality-gate pass: ${validLeads.length}/${totalLeads}. premium=${gradeStats.premium} qualified=${gradeStats.qualified}; icp=high:${icpStats.high} medium:${icpStats.medium} unset:${icpStats.unset}${reverseLog}`,
  );
}

const supabaseEnrichmentQueue = [];
let enqueueRejected = 0;

// 2026-05-23 双仓修：判断 lead.domain 是否真的可作为后续 step3 contact 抓取的入口。
// 旧逻辑只判 `lead.domain` truthy，导致 inferred 类 lead 给个 garbage 字符串（如 "/"、
// "n/a"、纯白空格 trim 失败）也进 enrichment_queue，下游 worker 取出来跑 step3 立即返回
// contact_hit=0 ——日志里出现的 6 条连续 0% hit + 53ms 早返回正是这个 case。
function isUsableDomain(d) {
  if (typeof d !== 'string') return false;
  const cleaned = d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!cleaned || cleaned.length < 4) return false;
  if (!cleaned.includes('.')) return false;
  if (/^[\d.]+$/.test(cleaned)) return true; // IPv4 字面量极少见但合法
  // 至少有一个字母段，且不是 ".com"/"a.b" 这种短到不能用的
  if (!/[a-z]/.test(cleaned)) return false;
  return true;
}

validLeads.forEach((lead) => {
  const hasContact = !!(lead.primary_email || lead.primary_phone);
  const isHot = lead.confidence_score >= 90 && hasContact;
  const usableDomain = isUsableDomain(lead.domain);
  // Top-N 溢出：只展示、不异步补 contact（用户明确「后面条数不做」）
  if (lead._skip_enrichment_queue || lead._enrich_deferred) {
    enqueueRejected += 1;
    return;
  }
  if (isHot && insertMain) {
    insertMain.run(
      lead.company_name,
      lead.domain,
      lead.country || null,
      lead.primary_email,
      lead.primary_phone,
      lead.confidence_score,
      lead.entity_role || null,
      lead.pillar,
      new Date().toISOString(),
    );
  } else if (usableDomain && insertQueue) {
    insertQueue.run(lead.company_name, lead.domain, lead.country || '', lead.confidence_score);
  } else if (usableDomain && SKIP_SQLITE && !hasContact) {
    supabaseEnrichmentQueue.push({
      discovery_job_id: DISCOVERY_JOB_ID,
      company_name: lead.company_name,
      domain: lead.domain,
      country_iso: String(lead.country || '').slice(0, 2).toUpperCase() || null,
      payload_json: { confidence_score: lead.confidence_score, pillar: lead.pillar },
    });
  } else if (!usableDomain && !hasContact) {
    // domain 不可用 + 无联系方式 → 入 enrichment_queue 也是浪费下游 worker 一次空转
    enqueueRejected += 1;
  }
});

if (enqueueRejected > 0) {
  console.log(`[step5] enrichment_queue: skipped ${enqueueRejected} leads (no usable domain — inferred-only with garbage host)`);
}

// ── 种子库反哺写回 ───────────────────────────────────────────────────────────
(function writeSeedFeedback() {
  const hotLeads = leads.filter(
    (l) =>
      l.confidence_score >= SEED_CONFIDENCE_MIN &&
      (l.primary_email || l.primary_phone) &&
      l.company_name &&
      l.domain,
  );
  if (hotLeads.length === 0) return;

  let seeds = [];
  try {
    if (fs.existsSync(SEED_PATH)) {
      seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    }
  } catch {
    seeds = [];
  }

  const existingDomains = new Set(seeds.map((s) => (s.domain || '').toLowerCase()));
  let added = 0;
  for (const lead of hotLeads) {
    const domainKey = (lead.domain || '').toLowerCase();
    if (!domainKey || existingDomains.has(domainKey)) continue;
    seeds.push({
      company_name: lead.company_name,
      domain: lead.domain,
      country: lead.country || '',
      category: lead.category || lead.pillar || '',
      primary_email: lead.primary_email || null,
      primary_phone: lead.primary_phone || null,
      confidence_score: lead.confidence_score,
      entity_role: lead.entity_role || null,
      seed_source: 'v8_auto_feedback',
      seeded_at: new Date().toISOString(),
    });
    existingDomains.add(domainKey);
    added += 1;
  }
  if (added > 0) {
    fs.writeFileSync(SEED_PATH, JSON.stringify(seeds, null, 2));
    console.log(
      `[step5] Seed feedback: +${added} new seeds → ${SEED_PATH} (total=${seeds.length}). Next run Pillar0 will activate them.`,
    );
  }
})();

(async () => {
  if (validLeads.length > 0) {
    console.log(`[step5] Supabase L1 ingest: ${validLeads.length} leads...`);
    const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // PR-DEDUP-CACHE L2-2 (2026-05-28)：增量补抓模式
    //   zhimao submit route 在 action_type='incremental_search' 时注入
    //   PILLAR0_PAYLOAD.incremental_mode + incremental_blacklist_company_ids，
    //   此处解析后传入 ingest，命中黑名单的 company_id 不写映射（只更新 L1 主表）。
    const incrementalCfg = readIncrementalBlacklist(null);
    if (incrementalCfg.enabled) {
      console.log(
        `[step5] incremental mode: parent=${incrementalCfg.parentJobId || 'unknown'}, ` +
          `blacklist=${incrementalCfg.blacklistSet.size}`,
      );
    }
    const result = await directIngestQualifiedLeads(supabase, validLeads, {
      discoveryJobId: DISCOVERY_JOB_ID,
      incrementalMode: incrementalCfg.enabled,
      incrementalParentJobId: incrementalCfg.parentJobId,
      incrementalBlacklistSet: incrementalCfg.blacklistSet,
    });
    if (incrementalCfg.enabled && (result.incrementalSkipped || 0) > 0) {
      console.log(
        `[step5] incremental: skipped ${result.incrementalSkipped} leads (already in parent job ${incrementalCfg.parentJobId})`,
      );
    }
    if (result.errors.length) {
      console.warn('[step5] ingest messages:', JSON.stringify(result.errors.slice(0, 20)));
      if (result.errors.length > 20) {
        console.warn(`[step5] ... and ${result.errors.length - 20} more`);
      }
    }
    if (!result.ok) {
      console.error('[step5] Supabase L1 ingest failed (see L1 upsert errors above).');
      writeFallbackInbox(validLeads, 'supabase_l1_ingest_failed');
      process.exit(1);
    }
    if (result.resolvedLeads < validLeads.length) {
      console.warn(
        `[step5] resolved ${result.resolvedLeads}/${validLeads.length} leads (some rows skipped or id lookup failed).`,
      );
    }
    console.log(
      `[step5] ingest ok: resolvedLeads=${result.resolvedLeads}, edgesWritten=${result.edgesWritten}`,
    );
    const persons = await mirrorBuyerPersonsFromLeads(supabase, result.resolvedPairs || []);
    if (persons.mirrored > 0) {
      console.log(`[step5] buyer_persons mirrored=${persons.mirrored}`);
    }
    if (supabaseEnrichmentQueue.length > 0) {
      const n = await enqueueEnrichmentLeads(supabase, supabaseEnrichmentQueue);
      if (n > 0) console.log(`[step5] Supabase enrichment_queue: +${n} rows`);
    }
    if (DISCOVERY_JOB_ID) {
      appendFunnelStep(DISCOVERY_JOB_ID, 'step5', {
        total_in: totalLeads,
        valid_leads: validLeads.length,
        l1_resolved: result.resolvedLeads,
        dropped_quality: droppedQuality,
        grade_stats: gradeStats,
        icp_stats: icpStats,
        enrichment_queued: supabaseEnrichmentQueue.length,
        enrichment_queue_skipped: enqueueRejected,
        incremental_mode: incrementalCfg.enabled,
        incremental_parent_job_id: incrementalCfg.parentJobId,
        incremental_blacklist_size: incrementalCfg.blacklistSet.size,
        incremental_skipped: result.incrementalSkipped || 0,
      });
    }
  } else {
    console.log('[step5] No valid leads to persist.');
    if (DISCOVERY_JOB_ID) {
      appendFunnelStep(DISCOVERY_JOB_ID, 'step5', {
        total_in: totalLeads,
        valid_leads: 0,
        dropped_quality: droppedQuality,
      });
    }
  }
  fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
  console.log(`[step5] Done → ${outputFile}`);
})();
