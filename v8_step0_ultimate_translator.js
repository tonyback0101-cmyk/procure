require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const [inputFile, outputFile, countryCode, ...catArgs] = process.argv.slice(2);
const category = catArgs.join(' ') || 'Industrial';

const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step0] GEMINI_KEY env var is required'); process.exit(1); }

// 54国全量映射（与 v8_cron_worker.js REGIONS 保持同步）
const COUNTRY_NAMES = {
    // SEA
    sg: 'Singapore',    my: 'Malaysia',      th: 'Thailand',     vn: 'Vietnam',
    id: 'Indonesia',    ph: 'Philippines',   kh: 'Cambodia',
    // MENA
    ae: 'UAE',          sa: 'Saudi Arabia',  qa: 'Qatar',        kw: 'Kuwait',
    om: 'Oman',         eg: 'Egypt',         ma: 'Morocco',      jo: 'Jordan',
    // South Asia
    in: 'India',        pk: 'Pakistan',      bd: 'Bangladesh',   lk: 'Sri Lanka',
    // East Asia & Pacific
    jp: 'Japan',        kr: 'South Korea',   au: 'Australia',    nz: 'New Zealand',
    hk: 'Hong Kong',
    // EU West
    de: 'Germany',      gb: 'UK',            fr: 'France',       it: 'Italy',
    nl: 'Netherlands',  es: 'Spain',         be: 'Belgium',      pt: 'Portugal',
    se: 'Sweden',       dk: 'Denmark',       at: 'Austria',      ch: 'Switzerland',
    // EU East & Turkey
    tr: 'Turkey',       pl: 'Poland',        cz: 'Czech Republic', ro: 'Romania',
    hu: 'Hungary',      gr: 'Greece',        ua: 'Ukraine',
    // LATAM
    mx: 'Mexico',       br: 'Brazil',        co: 'Colombia',     cl: 'Chile',
    ar: 'Argentina',    pe: 'Peru',          ec: 'Ecuador',      pa: 'Panama',
    // NA
    us: 'United States', ca: 'Canada',
    // Africa
    ng: 'Nigeria',      za: 'South Africa',  ke: 'Kenya',        gh: 'Ghana',
    et: 'Ethiopia',
};
const LANGUAGE_MAP = {
    // SEA
    sg: 'English',      my: 'Malay',         th: 'Thai',         vn: 'Vietnamese',
    id: 'Indonesian',   ph: 'Filipino',      kh: 'Khmer',
    // MENA
    ae: 'Arabic',       sa: 'Arabic',        qa: 'Arabic',       kw: 'Arabic',
    om: 'Arabic',       eg: 'Arabic',        ma: 'Arabic',       jo: 'Arabic',
    // South Asia
    in: 'Hindi',        pk: 'Urdu',          bd: 'Bengali',      lk: 'Sinhala',
    // East Asia & Pacific
    jp: 'Japanese',     kr: 'Korean',        au: 'English',      nz: 'English',
    hk: 'Cantonese',
    // EU West
    de: 'German',       gb: 'English',       fr: 'French',       it: 'Italian',
    nl: 'Dutch',        es: 'Spanish',       be: 'French',       pt: 'Portuguese',
    se: 'Swedish',      dk: 'Danish',        at: 'German',       ch: 'German',
    // EU East & Turkey
    tr: 'Turkish',      pl: 'Polish',        cz: 'Czech',        ro: 'Romanian',
    hu: 'Hungarian',    gr: 'Greek',         ua: 'Ukrainian',
    // LATAM
    mx: 'Spanish',      br: 'Portuguese',    co: 'Spanish',      cl: 'Spanish',
    ar: 'Spanish',      pe: 'Spanish',       ec: 'Spanish',      pa: 'Spanish',
    // NA
    us: 'English',      ca: 'English',
    // Africa
    ng: 'English',      za: 'English',       ke: 'Swahili',      gh: 'English',
    et: 'Amharic',
};

async function run() {
    const targetLang  = LANGUAGE_MAP[countryCode]  || 'English';
    const countryName = COUNTRY_NAMES[countryCode] || countryCode;
    const tld         = `site:.${countryCode} OR site:.com.${countryCode}`;

    let baseQuery = '';

    if (targetLang !== 'English') {
        const prompt   = `Translate industrial category "${category}" to ${targetLang}. Provide 2 native B2B buyer intent keywords (e.g. importer, wholesaler). Return JSON: {"translated_category":"...","native_intents":["...","..."]}`;
        const reqData  = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } });

        const resData = await new Promise(resolve => {
            const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
                let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
            });
            req.on('error', () => resolve(null)); req.write(reqData); req.end();
        });

        try {
            const parsed  = JSON.parse(resData);
            const content = JSON.parse(parsed.candidates[0].content.parts[0].text);
            const nativeStr = content.native_intents.map(i => `"${i}"`).join(' OR ');
            baseQuery = `"${content.translated_category}" (${nativeStr})`;
        } catch (e) { /* fallback to English below */ }
    }

    if (!baseQuery) {
        baseQuery = `"${category}" ("importer" OR "wholesaler" OR "distributor" OR "buyer")`;
    }

    fs.writeFileSync(outputFile, JSON.stringify({ baseQuery, tld, countryName, countryCode, category }, null, 2));
    console.log(`[step0] Orchestration written ??${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
