const fs = require('fs');
const { execSync } = require('child_process');
const { reportDiscoveryStage } = require('./v8_discovery_stage');
const {
    splitEnrichTopN,
    readEnrichTopNFromEnv,
    materializeOverflowLead,
} = require('./v8_lib_enrich_cap');
const { appendFunnelStep } = require('./v8_lib_funnel');

console.log(`\n==================================================================`);
console.log(`[V8 ULTIMATE OMNI-MATRIX] FULL PHYSICAL ASSERTION ENGINE`);
console.log(`==================================================================\n`);

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: node zhimao_v8_ultimate_master.js <country_code> <category>");
    process.exit(1);
}

const countryCode = args[0];
const category = args.slice(1).join(' ');
// 并发安全：worker 可同时跑多个 pipeline。session 目录除了时间戳，还拼上 DISCOVERY_JOB_ID
// 的短哈希，确保两个同国家任务在同一毫秒启动时也不会共用目录、互相覆盖中间文件。
const jobTag = String(process.env.DISCOVERY_JOB_ID || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
const sessionId = `v8_ultimate_${countryCode}_${Date.now()}${jobTag ? `_${jobTag}` : ''}`;
fs.mkdirSync(sessionId, { recursive: true });

/**
 * Graceful cancel 标志：worker 通过 SIGTERM 通知取消。
 * 普通 step 接到信号后，等当前 execSync 子进程结束（或被中断），
 * 然后跳过剩余的富化步骤，但**强制运行 step4（去重）和 step5（持久化）**。
 * 这样即使用户取消，已采集/富化的数据也能落库，不会全损。
 *
 * partialTimeout：某步（通常 Step3）execSync 超时后降级继续，仍跑 step4/5 输出已有数据。
 */
let gracefulCancel = false;
let partialTimeout = false;
process.on('SIGTERM', () => {
    if (!gracefulCancel) {
        gracefulCancel = true;
        console.warn('\n[master] SIGTERM received — graceful cancel mode: will skip remaining enrichment but COMPLETE step4+5 to persist collected data.');
    }
});

// 单个 step 的硬超时：防止某一步（step1 采集 / step3 富化）卡死把整条 pipeline 拖死。
// 默认 10min，env 可调。富化步超时 → 降级继续 step4/5（不再整单失败空结果）。
// 注意：worker 侧另有 DISCOVERY_PIPELINE_MAX_MS 总看门狗作为整体兜底。
const STEP_TIMEOUT_MS = Math.max(Number(process.env.DISCOVERY_STEP_TIMEOUT_MS || 10 * 60 * 1000), 30_000);

function isEnrichmentStep(stepName) {
    return String(stepName || '').startsWith('3');
}

function runAssertedStep(stepName, scriptFile, inputFiles, outputFile, extraArgs = "", opts = {}) {
    // ── Graceful cancel：跳过所有非持久化步；partial timeout：只跳过后续富化步 ──
    const isPersistenceStep = stepName.startsWith("4.") || stepName.startsWith("5.");
    if (!isPersistenceStep && (gracefulCancel || (partialTimeout && isEnrichmentStep(stepName)))) {
        console.warn(`[master] ${gracefulCancel ? 'graceful cancel' : 'partial timeout'} — skipping ${stepName}`);
        return null;
    }

    console.log(`\n>>> [STEP: ${stepName}] <<<`);

    const inputs = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
    inputs.forEach(inf => {
        if (inf && !fs.existsSync(inf)) {
            if (gracefulCancel || partialTimeout) {
                console.warn(`[master] degrade — input '${inf}' missing for ${stepName}, skipping`);
                return;
            }
            console.error(`[HALT] Required input '${inf}' missing.`);
            process.exit(1);
        }
    });
    if ((gracefulCancel || partialTimeout) && inputs.every(inf => inf && !fs.existsSync(inf))) return null;

    const inputArg = inputs.join(',');
    const cmd = `node ${scriptFile} "${inputArg}" "${outputFile}" ${extraArgs}`;
    console.log(`-> Executing: ${cmd}`);

    // 富化步用 SIGTERM：给 step3 机会写 checkpoint；采集步仍 SIGKILL 防真卡死。
    const killSignal = isEnrichmentStep(stepName) ? 'SIGTERM' : 'SIGKILL';

    try {
        execSync(cmd, { stdio: 'inherit', timeout: STEP_TIMEOUT_MS, killSignal });
    } catch (e) {
        const timedOut = !!(e && e.killed);
        if (timedOut && isEnrichmentStep(stepName)) {
            // Step3/3.5 超时：有输出就用；没有则后续回退 intake — 绝不整单空失败。
            partialTimeout = true;
            if (fs.existsSync(outputFile)) {
                console.warn(`[master] step timeout — ${stepName} exceeded ${STEP_TIMEOUT_MS}ms but partial output exists; continuing to step4/5`);
                return null;
            }
            console.warn(`[master] step timeout — ${stepName} exceeded ${STEP_TIMEOUT_MS}ms, no output yet; will fall back to intake/overflow for persistence`);
            return null;
        }
        if (timedOut && !gracefulCancel) {
            console.error(`[HALT] Step "${stepName}" exceeded ${STEP_TIMEOUT_MS}ms — killed (likely a stuck upstream). Treating as crash.`);
            const jobId = process.env.DISCOVERY_JOB_ID || 'unknown';
            try {
                fs.writeFileSync(
                    `crash_${jobId}.json`,
                    JSON.stringify({ step: stepName, script: scriptFile, error: `step_timeout_${STEP_TIMEOUT_MS}ms` })
                );
            } catch (_) { /* ignore */ }
            process.exit(1);
        }
        if (gracefulCancel || partialTimeout) {
            if (fs.existsSync(outputFile)) {
                console.warn(`[master] degrade — ${stepName} interrupted but partial output exists, continuing to persistence...`);
                return null;
            }
            console.warn(`[master] degrade — ${stepName} interrupted, no output, skipping.`);
            return null;
        }
        console.error(`[HALT] Script crashed: ${scriptFile}. Error: ${e.message}`);
        const jobId = process.env.DISCOVERY_JOB_ID || 'unknown';
        try {
            fs.writeFileSync(
                `crash_${jobId}.json`,
                JSON.stringify({ step: stepName, script: scriptFile, error: String(e.message || '').slice(0, 300) })
            );
        } catch (_) { /* ignore crash-file write failure */ }
        process.exit(1);
    }

    if (!fs.existsSync(outputFile)) {
        if (partialTimeout || gracefulCancel || opts.allowEmpty) {
            console.warn(`[master] output missing after ${stepName} — continuing (degrade/allowEmpty)`);
            return null;
        }
        console.error(`[HALT] Physical output missing: ${outputFile}.`);
        process.exit(1);
    }

    const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    const count = Array.isArray(outputData)
        ? outputData.length
        : (outputData.organic         ? outputData.organic.length
            : (outputData.data        ? outputData.data.length
                : (outputData.dorks   ? outputData.dorks.length
                    : (outputData.baseQuery    ? 1
                        : (outputData.db_injected != null ? outputData.db_injected
                            : (outputData.status === 'success' ? 1 : 0))))));

    if (count === 0 && !stepName.includes("Bridge") && !opts.allowEmpty) {
        // exit(2) = "graceful stop, no data" — 与 exit(0)=完全成功 / exit(1)=崩溃 语义区分
        // discovery_worker 和 cron_worker 读取此 exit code：
        //   0 → 全量写入成功
        //   1 → 脚本崩溃 / 配置错误
        //   2 → 流水线正常但本轮该网格无新数据（不计为失败，但不应标记 job 为 done）
        console.warn(`[PIPELINE STOP] Step "${stepName}" returned 0 results — graceful stop (exit 2).`);
        process.exit(2);
    }

    if (count === 0 && opts.allowEmpty) {
        console.warn(`[master] Step "${stepName}" returned 0 results — continuing (allowEmpty, e.g. overflow still pending).`);
    } else {
        console.log(`[ASSERTION PASSED] ${outputFile} validated with ${count} records.`);
    }
    return outputData;
}

const fileBus = {
    t0_orchestration: `${sessionId}/00_orchestration.json`,
    t1_raw_pool:      `${sessionId}/01_raw_pool.json`,
    t2_intake:        `${sessionId}/02_intake.json`,
    t2_enrich_top:    `${sessionId}/02b_enrich_top.json`,
    t2_overflow:      `${sessionId}/02b_enrich_overflow.json`,
    t3_enriched:      `${sessionId}/03_enriched_scored.json`,
    t4_deduped:       `${sessionId}/04_deduped.json`,
    t5_final:         `${sessionId}/05_final_routing.json`,
};

/**
 * 热读 action_payload.negative_keywords 并合并到 CONVO_CONTROLS。
 * 在 step1 完成后调用，让 step2/step5 的 keywordSuppress 能感知运行期注入的排除词。
 * Supabase 不可用时静默降级（不阻断 pipeline）。
 */
async function refreshLiveNegativeKeywords() {
    const jobId = process.env.DISCOVERY_JOB_ID;
    const url   = process.env.SUPABASE_URL;
    const key   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!jobId || !url || !key) return;

    try {
        const res = await fetch(
            `${url}/rest/v1/discovery_jobs?id=eq.${encodeURIComponent(jobId)}&select=action_payload`,
            { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
        );
        if (!res.ok) return;
        const rows = await res.json();
        const ap = rows?.[0]?.action_payload;
        if (!ap || typeof ap !== 'object') return;

        const liveKw = Array.isArray(ap.negative_keywords)
            ? ap.negative_keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
            : [];
        if (liveKw.length === 0) return;

        // 合并到现有 CONVO_CONTROLS
        let controls = {};
        try {
            const raw = process.env.CONVO_CONTROLS;
            if (raw) controls = JSON.parse(raw);
        } catch { /* ignore */ }

        const existingKw = Array.isArray(controls.keywordSuppress) ? controls.keywordSuppress : [];
        const merged = [...new Set([...existingKw, ...liveKw])];
        controls.keywordSuppress = merged;
        process.env.CONVO_CONTROLS = JSON.stringify(controls);

        console.log(`[master] live negative_keywords refreshed: [${merged.join(', ')}] — will apply from step2 onwards`);
    } catch (e) {
        console.warn(`[master] refreshLiveNegativeKeywords failed (non-fatal):`, e?.message || e);
    }
}

// PHASE 0: Geo-Drill & Bilingual Dorks
runAssertedStep("0. Geo-Orchestrator & Translator", "v8_step0_ultimate_translator.js", [], fileBus.t0_orchestration, `"${countryCode}" "${category}"`);

// PHASE 1: Multi-Pillar Omni-Collection
runAssertedStep("1. Omni-Pillar Collection (6+1 Hub)", "v8_step1_omni_hub.js", fileBus.t0_orchestration, fileBus.t1_raw_pool, `"${countryCode}"`);

// ── 热读排除词（step1 结束后，step2 开始前）──────────────────────────────────
// 用户在 step1 运行期间通过前端注入的 negative_keywords 会写入 action_payload；
// 此处从 DB 同步最新词表到 CONVO_CONTROLS，让 step2 preFilterRawLeads 能感知。
(async () => { try { await refreshLiveNegativeKeywords(); } catch (_) {} })();

// PHASE 2: LLM Anti-Hallucination & CN-Filter Intake
void reportDiscoveryStage('parsing');
runAssertedStep("2. Strict Entity Intake", "v8_step2_intake.js", fileBus.t1_raw_pool, fileBus.t2_intake);

// PHASE 2.5: Top-N enrich cap — 只对最好的 N 条跑 Step3，溢出轻量入库排后展示
// Env: ENRICH_TOP_N（默认 30；<=0 关闭截断）
const ENRICH_TOP_N = readEnrichTopNFromEnv();
let step3Input = fileBus.t2_intake;
let overflowLeads = [];
if (!gracefulCancel && fs.existsSync(fileBus.t2_intake)) {
    try {
        const intakeAll = JSON.parse(fs.readFileSync(fileBus.t2_intake, 'utf8'));
        const { top, overflow, total, hardRejected, hardReasons, relevanceFloor, relevanceFilled } = splitEnrichTopN(
          intakeAll,
          ENRICH_TOP_N,
          process.env.DISCOVERY_CATEGORY || category,
        );
        overflowLeads = overflow.map((l) => materializeOverflowLead(l, countryCode));
        fs.writeFileSync(fileBus.t2_enrich_top, JSON.stringify(top, null, 2));
        fs.writeFileSync(fileBus.t2_overflow, JSON.stringify(overflowLeads, null, 2));
        step3Input = fileBus.t2_enrich_top;
        const hardNote = hardRejected
          ? `, hard_noise_rejected=${hardRejected}${hardReasons ? `(${Object.entries(hardReasons).map(([k, v]) => `${k}:${v}`).join(',')})` : ''}`
          : '';
        const floorNote =
          relevanceFloor > 0
            ? `, relevance_floor=${relevanceFilled}/${relevanceFloor}`
            : '';
        console.log(
            `[master] enrich cap: intake=${total} → top=${top.length} for Step3` +
            (overflowLeads.length ? `, overflow=${overflowLeads.length} deferred (display later)` : '') +
            hardNote +
            floorNote +
            ` (ENRICH_TOP_N=${ENRICH_TOP_N})`,
        );
        const jobId = process.env.DISCOVERY_JOB_ID || '';
        if (jobId) {
            appendFunnelStep(jobId, 'enrich_cap', {
                intake_total: total,
                enrich_top_n: ENRICH_TOP_N,
                top_count: top.length,
                overflow_count: overflowLeads.length,
                hard_noise_rejected: hardRejected || 0,
                hard_noise_reasons: hardReasons || {},
                relevance_floor: relevanceFloor || 0,
                relevance_filled: relevanceFilled || 0,
            });
        }
    } catch (e) {
        console.warn(`[master] enrich cap failed (non-fatal, using full intake):`, e?.message || e);
        step3Input = fileBus.t2_intake;
        overflowLeads = [];
    }
}

// PHASE 3: L3 Supply-Chain Inference + Contact Extraction
void reportDiscoveryStage('scoring');
// Gemini infers entity_role, BOM (primary_materials_top3), procurement_items, confidence_tier,
// intent_summary — stored as inference_breakdown (L1 column via Step5 Supabase ingest).
if (!gracefulCancel && Array.isArray(overflowLeads) && overflowLeads.length > 0 &&
    fs.existsSync(step3Input)) {
    let topCount = 0;
    try {
        const topArr = JSON.parse(fs.readFileSync(step3Input, 'utf8'));
        topCount = Array.isArray(topArr) ? topArr.length : 0;
    } catch (_) { topCount = 0; }
    if (topCount === 0) {
        // 截断后 Top 为空（极端）→ 跳过 Step3，直接用溢出轻量线索
        fs.writeFileSync(fileBus.t3_enriched, JSON.stringify(overflowLeads, null, 2));
        console.log(`[master] enrich cap: top empty, persisting overflow only (${overflowLeads.length})`);
        overflowLeads = []; // 已写入，避免下面重复 merge
    } else {
        runAssertedStep(
            "3. L3 Supply-Chain Inference & Contact Extraction",
            "v8_step3_ultimate_enrichment.js",
            step3Input,
            fileBus.t3_enriched,
            "",
            { allowEmpty: true },
        );
    }
} else {
    runAssertedStep("3. L3 Supply-Chain Inference & Contact Extraction", "v8_step3_ultimate_enrichment.js", step3Input, fileBus.t3_enriched);
}

// PHASE 3.5 (Optional): 税号/工商注册反向验证（置信度加权，加分不减分）
// 由 TAX_VERIFY_ENABLED=true 环境变量激活；默认关闭，不影响主流水线稳定性
const fileBus_t3v_verified = `${sessionId}/03b_tax_verified.json`;
if (process.env.TAX_VERIFY_ENABLED === 'true' && fs.existsSync(fileBus.t3_enriched)) {
    runAssertedStep(
        "3.5 Tax Registry Cross-Verify (Bridge)",
        "v8_tax_verifier.js",
        fileBus.t3_enriched,
        fileBus_t3v_verified
    );
    fileBus.t3_enriched = fileBus_t3v_verified; // 后续步骤读取已加权文件
}

// 合并 Step3 富化结果 + 溢出轻量线索，再进去重（溢出不跑 Step3，但仍展示）
if (overflowLeads.length > 0) {
    try {
        let enriched = [];
        if (fs.existsSync(fileBus.t3_enriched)) {
            const parsed = JSON.parse(fs.readFileSync(fileBus.t3_enriched, 'utf8'));
            enriched = Array.isArray(parsed) ? parsed : [];
        }
        const merged = [...enriched, ...overflowLeads];
        fs.writeFileSync(fileBus.t3_enriched, JSON.stringify(merged, null, 2));
        console.log(
            `[master] merged overflow into Step3 output: enriched=${enriched.length} + overflow=${overflowLeads.length} → ${merged.length}`,
        );
    } catch (e) {
        console.warn(`[master] overflow merge failed (non-fatal):`, e?.message || e);
    }
}

// PHASE 4: Global Dedupe & Schema Normalization
// degrade 期间：step3 → enrich_top → intake，确保有数据可去重落库
const bestAvailableForDedupe = [fileBus.t3_enriched, fileBus.t2_enrich_top, fileBus.t2_intake]
    .find(f => fs.existsSync(f)) ?? fileBus.t3_enriched;
if ((gracefulCancel || partialTimeout) && bestAvailableForDedupe !== fileBus.t3_enriched) {
    console.warn(`[master] degrade — step3 output missing, using ${bestAvailableForDedupe} for dedupe`);
}
runAssertedStep("4. Global Dedupe", "v8_step4_dedupe.js", bestAvailableForDedupe, fileBus.t4_deduped, `"${countryCode}"`);

// PHASE 5: Routing Gateway → Supabase L1 + graph edges
void reportDiscoveryStage('persisting');
runAssertedStep("5. Routing & Persistence Gateway", "v8_step5_routing_gateway.js", fileBus.t4_deduped, fileBus.t5_final);

if (gracefulCancel) {
    console.log(`\n[V8 PIPELINE GRACEFUL CANCEL] Data persisted. Session: ${sessionId}`);
    // 退出码 4 = graceful cancel with data — worker 识别后执行 finalize（不计为失败）
    process.exitCode = 4;
} else if (partialTimeout) {
    console.log(`\n[V8 PIPELINE PARTIAL TIMEOUT] Data persisted from best available. Session: ${sessionId}`);
    // 退出码 6 = 某步超时但已落库部分结果 — worker markDone(partial_timeout)
    process.exitCode = 6;
} else {
    console.log(`\n[V8 PIPELINE COMPLETE] Session: ${sessionId}`);
}
