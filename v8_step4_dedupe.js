const fs = require('fs');
const [inputFile, outputFile, , countryArg] = process.argv.slice(2);

const leads   = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const country = countryArg || 'Unknown';

function normaliseDomain(raw) {
    if (!raw) return '';
    try {
        const href = raw.startsWith('http') ? raw : `http://${raw}`;
        return new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
        // malformed URL (e.g. relative path, linkedin slug) — fall back to raw string
        return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
    }
}

const seen    = new Set();
const deduped = leads
    .filter(l => {
        if (!l.company_name) return false;
        const domainPart = normaliseDomain(l.domain);
        const key = `${l.company_name.toLowerCase().trim()}|${domainPart}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    })
    .map(l => ({ ...l, country }));

fs.writeFileSync(outputFile, JSON.stringify(deduped, null, 2));
console.log(`[step4] Done — ${deduped.length} unique leads (from ${leads.length}) → ${outputFile}`);
