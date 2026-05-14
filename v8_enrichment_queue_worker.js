/**
 * v8_enrichment_queue_worker.js
 *
 * enrichment_queue 消费者：把低置信度但有域名的线索重新过一遍
 * Step3（仅联系方式，跳过 L3 推断），命中联系方式后升级入 main_db
 * 并推送到 Catagent Bulk API。
 *
 * 运行方式：
 *   node v8_enrichment_queue_worker.js
 *   ENRICH_QUEUE_BATCH_SIZE=30 node v8_enrichment_queue_worker.js
 *
 * 建议接入 cron：在 v8_infinite_loop.js 或 render.yaml 中单独注册为后台 worker。
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { evaluateLead } = require('./v8_quality_gate');

const DB_PATH            = process.env.V8_SQLITE_PATH     || 'zhimao_v8_matrix.sqlite';
const BATCH_SIZE         = Math.max(1,  Number(process.env.ENRICH_QUEUE_BATCH_SIZE  || 30));
const MAX_RETRIES        = Math.max(1,  Number(process.env.ENRICH_QUEUE_MAX_RETRIES || 5));
const PROMOTE_SCORE      = Math.max(50, Number(process.env.ENRICH_PROMOTE_SCORE     || 70));

// ── 工具：写临时 JSON 文件，execSync 子进程，读结果 ─────────────────────────
function runStep3ContactOnly(items) {
    const ts      = Date.now();
    const inFile  = path.join(process.cwd(), `.tmp_eq_in_${ts}.json`);
    const outFile = path.join(process.cwd(), `.tmp_eq_out_${ts}.json`);
    try {
        fs.writeFileSync(inFile, JSON.stringify(items, null, 2));
        execSync(`node v8_step3_ultimate_enrichment.js "${inFile}" "${outFile}"`, {
            stdio:  'inherit',
            env:    { ...process.env, SKIP_L3_INFERENCE: 'true' },
        });
        const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        console.error('[eq-worker] step3 failed:', e.message);
        return [];
    } finally {
        try { if (fs.existsSync(inFile))  fs.unlinkSync(inFile);  } catch (_) {}
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
    }
}

function runStep5Push(items) {
    if (items.length === 0) return;
    const ts      = Date.now();
    const inFile  = path.join(process.cwd(), `.tmp_eq5_in_${ts}.json`);
    const outFile = path.join(process.cwd(), `.tmp_eq5_out_${ts}.json`);
    try {
        fs.writeFileSync(inFile, JSON.stringify(items, null, 2));
        execSync(`node v8_step5_routing_gateway.js "${inFile}" "${outFile}"`, {
            stdio: 'inherit',
            // 升级条目已在 main_db，用 SKIP_SQLITE 避免重复写；让 Step5 只做 API push
            env: { ...process.env, SKIP_SQLITE: 'true' },
        });
    } catch (e) {
        console.error('[eq-worker] step5 push failed:', e.message);
    } finally {
        try { if (fs.existsSync(inFile))  fs.unlinkSync(inFile);  } catch (_) {}
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
    }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
function run() {
    if (!fs.existsSync(DB_PATH)) {
        console.log(`[eq-worker] SQLite DB not found at ${DB_PATH} — nothing to consume.`);
        return;
    }

    const db = new Database(DB_PATH);

    // 确保表存在（worker 可在 Step5 之前单独运行时自建）
    db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT NOT NULL,
        domain TEXT,
        country TEXT NOT NULL DEFAULT '',
        score INTEGER,
        retries INTEGER DEFAULT 0,
        UNIQUE(company_name, country)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT NOT NULL,
        domain TEXT,
        country TEXT NOT NULL DEFAULT '',
        primary_email TEXT,
        primary_phone TEXT,
        confidence_score INTEGER,
        entity_role TEXT,
        source TEXT,
        timestamp TEXT,
        UNIQUE(company_name, country)
    )`);

    // 拉取待处理批次（重试少的优先）
    const queued = db.prepare(`
        SELECT rowid, company_name, domain, country, score, retries
        FROM enrichment_queue
        ORDER BY retries ASC, rowid ASC
        LIMIT ?
    `).all(BATCH_SIZE);

    if (queued.length === 0) {
        console.log('[eq-worker] enrichment_queue is empty — nothing to do.');
        return;
    }

    console.log(`[eq-worker] pulled ${queued.length} entries (batch_size=${BATCH_SIZE}, max_retries=${MAX_RETRIES})`);

    // 构建 Step3 输入（仅传 domain/公司名，跳过 L3）
    const inputs = queued.map(r => ({
        company_name:     r.company_name,
        domain:           r.domain        || '',
        country:          r.country       || '',
        confidence_score: Number(r.score) || 50,
        snippet:          '',
        pillar:           'EnrichmentQueue',
    }));

    const enriched = runStep3ContactOnly(inputs);

    // 按 (name, country) 建索引方便快速查找
    const byKey = new Map(
        enriched.map(l => [
            `${(l.company_name || '').toLowerCase().trim()}|${(l.country || '').toUpperCase()}`,
            l,
        ])
    );

    const stmtInsertMain = db.prepare(`
        INSERT OR REPLACE INTO main_db
        (company_name, domain, country, primary_email, primary_phone,
         confidence_score, entity_role, source, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtDelete   = db.prepare(`DELETE FROM enrichment_queue WHERE rowid = ?`);
    const stmtBumpRetry = db.prepare(`UPDATE enrichment_queue SET retries = retries + 1 WHERE rowid = ?`);

    const promoted = [];
    let dropped = 0, retried = 0;

    const tx = db.transaction(() => {
        for (const row of queued) {
            const key  = `${row.company_name.toLowerCase().trim()}|${(row.country || '').toUpperCase()}`;
            const lead = byKey.get(key);

            const hasContact = !!(lead?.primary_email || lead?.primary_phone);
            const score      = Number(lead?.confidence_score ?? row.score ?? 50);
            const { grade }  = evaluateLead(lead || { company_name: row.company_name, domain: row.domain });

            if (hasContact && score >= PROMOTE_SCORE && grade !== 'unqualified') {
                // 升级：写 main_db
                stmtInsertMain.run(
                    row.company_name,
                    row.domain || null,
                    row.country || '',
                    lead.primary_email || null,
                    lead.primary_phone || null,
                    score,
                    lead.entity_role   || null,
                    'enrichment_queue_worker',
                    new Date().toISOString(),
                );
                stmtDelete.run(row.rowid);
                promoted.push({
                    company_name:     row.company_name,
                    domain:           row.domain || null,
                    country:          row.country || '',
                    primary_email:    lead.primary_email || null,
                    primary_phone:    lead.primary_phone || null,
                    confidence_score: score,
                    entity_role:      lead.entity_role || null,
                    snippet:          '',
                    pillar:           'EnrichmentQueue',
                });
            } else if ((Number(row.retries) || 0) + 1 >= MAX_RETRIES) {
                // 达到最大重试次数，从队列清除（防止队列永久积压）
                stmtDelete.run(row.rowid);
                dropped += 1;
            } else {
                stmtBumpRetry.run(row.rowid);
                retried += 1;
            }
        }
    });
    tx();

    console.log(`[eq-worker] done: promoted=${promoted.length}, retried=${retried}, dropped=${dropped}`);

    // 升级成功的条目推送到 Catagent API（使用 Step5 push 路径，跳过本地 SQLite）
    if (promoted.length > 0) {
        console.log(`[eq-worker] pushing ${promoted.length} promoted leads via Catagent API...`);
        runStep5Push(promoted);
    }
}

run();
