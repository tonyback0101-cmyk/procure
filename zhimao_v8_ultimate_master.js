const fs = require('fs');
const { execSync } = require('child_process');

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
const sessionId = `v8_ultimate_${countryCode}_${Date.now()}`;
fs.mkdirSync(sessionId, { recursive: true });

function runAssertedStep(stepName, scriptFile, inputFiles, outputFile, extraArgs = "") {
    console.log(`\n>>> [STEP: ${stepName}] <<<`);

    const inputs = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
    inputs.forEach(inf => {
        if (inf && !fs.existsSync(inf)) {
            console.error(`[HALT] Required input '${inf}' missing.`);
            process.exit(1);
        }
    });

    const inputArg = inputs.join(',');
    const cmd = `node ${scriptFile} "${inputArg}" "${outputFile}" ${extraArgs}`;
    console.log(`-> Executing: ${cmd}`);

    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
        console.error(`[HALT] Script crashed: ${scriptFile}. Error: ${e.message}`);
        process.exit(1);
    }

    if (!fs.existsSync(outputFile)) {
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

    if (count === 0 && !stepName.includes("Bridge")) {
        console.warn(`[PIPELINE STOP] Step returned 0 results. Graceful halt.`);
        process.exit(0);
    }

    console.log(`[ASSERTION PASSED] ${outputFile} validated with ${count} records.`);
    return outputData;
}

const fileBus = {
    t0_orchestration: `${sessionId}/00_orchestration.json`,
    t1_raw_pool:      `${sessionId}/01_raw_pool.json`,
    t2_intake:        `${sessionId}/02_intake.json`,
    t3_enriched:      `${sessionId}/03_enriched_scored.json`,
    t4_deduped:       `${sessionId}/04_deduped.json`,
    t5_final:         `${sessionId}/05_final_routing.json`,
};

// PHASE 0: Geo-Drill & Bilingual Dorks
runAssertedStep("0. Geo-Orchestrator & Translator", "v8_step0_ultimate_translator.js", [], fileBus.t0_orchestration, `"${countryCode}" "${category}"`);

// PHASE 1: Multi-Pillar Omni-Collection
runAssertedStep("1. Omni-Pillar Collection (6+1 Hub)", "v8_step1_omni_hub.js", fileBus.t0_orchestration, fileBus.t1_raw_pool, `"${countryCode}"`);

// PHASE 2: LLM Anti-Hallucination & CN-Filter Intake
runAssertedStep("2. Strict Entity Intake", "v8_step2_intake.js", fileBus.t1_raw_pool, fileBus.t2_intake);

// PHASE 3: Deep Enrichment, Intent Calc & L3 Deduction
runAssertedStep("3. L3 Deduction & Intent Scoring", "v8_step3_ultimate_enrichment.js", fileBus.t2_intake, fileBus.t3_enriched);

// PHASE 4: Global Dedupe & Schema Normalization
runAssertedStep("4. Global Dedupe", "v8_step4_dedupe.js", fileBus.t3_enriched, fileBus.t4_deduped, `"${countryCode}"`);

// PHASE 5: Routing Gateway → Catagent API
runAssertedStep("5. Routing & Persistence Gateway", "v8_step5_routing_gateway.js", fileBus.t4_deduped, fileBus.t5_final);

console.log(`\n[V8 PIPELINE COMPLETE] Session: ${sessionId}`);
