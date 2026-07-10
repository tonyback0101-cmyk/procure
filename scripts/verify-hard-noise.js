'use strict';
const { hardNoiseReason, rejectHardNoiseLeads, splitEnrichTopN } = require('../v8_lib_enrich_cap');
const { offCategoryReason, textMentionsCategory } = require('../v8_lib_category_relevance');

const noiseStructural = [
  { company_name: 'Top Manufacturing Companies in Singapore - Jun 2026 Rankings' },
  { company_name: '20 Questions with Zermatt Neo - Content Creator Interviews' },
  { company_name: 'AmCham Singapore Membership Directory - List of Companies' },
  { company_name: 'Good Veg Wholesaler', primary_email: 'xxx@organisation.com' },
];

const noiseMarketplace = [
  { company_name: 'Latest Top Selling Recommendations | Taobao Singapore', domain: 'taobao.com' },
  { company_name: 'Chang Xing Mala Hot Pot - Foodpanda', domain: 'foodpanda.sg' },
  { company_name: '1 - Hugging Face', domain: 'huggingface.co' },
  { company_name: 'A Day in the Life of Xiao Hei | Lemon8', domain: 'lemon8-app.com' },
  { company_name: '60+ Green Tender Chinese Cucumber Seeds | eBay', domain: 'ebay.com.sg' },
  { company_name: 'Fresh Cucumber Suppliers — Market Overview 2026', domain: 'tridge.com' },
];

const noiseRetailSku = [
  { company_name: 'Cucumber (黄瓜) [~350G] - Market Fresh SG', domain: 'marketfresh.com.sg' },
  { company_name: '女性护理湿巾OEM | 私护洁面可冲散湿巾| Niceday', domain: 'everyniceday.com' },
];

const noiseFalseFriend = [
  { company_name: 'Beef Chuck Tender | 牛嫩肩肉（黄瓜条）| BR - S. S. Kim Enterprises', domain: 'sskim.com.sg' },
];

const noiseOffForCabbage = [
  { company_name: 'Private Label OEM/ODM Skincare Manufacturer in Singapore' },
  { company_name: 'Pharmaceutical Contract Manufacturing Company | APD Singapore' },
  { company_name: 'The Car Enthusiast Pte Ltd' },
];

const keepCabbage = [
  { company_name: 'Yuan Sang Pte Ltd', domain: 'yuansang.com.sg', pillar: 'Pillar 1 LBS', industry_match: 'medium' },
  { company_name: 'Z.N.TRADING (SINGAPORE) PTE LTD', domain: 'zntrading.sg', pillar: 'Pillar 2 Direct', industry_match: 'high' },
  { company_name: 'Kirei Japanese Food Supply Pte Ltd', domain: 'kireifood.com.sg', phone: '+65', pillar: 'Pillar 1 LBS' },
  { company_name: 'Cabbage Wholesale Fresh Produce', domain: 'veg.sg', snippet: 'import cabbage and leafy vegetables' },
];

const keepCucumber = [
  {
    company_name: 'Cucumber (Malaysia) 黄瓜 – freshveggies.sg',
    domain: 'freshveggies.sg',
    snippet: 'wholesale cucumber vegetable importer',
    pillar: 'Pillar 2 Direct',
    industry_match: 'high',
  },
  {
    company_name: 'Le Fresco Produce Trading',
    domain: 'lefresco.co',
    snippet: 'cucumbers eggplants wholesale Singapore',
    pillar: 'Pillar 8 B2B',
    industry_match: 'medium',
  },
];

const keepWhenSkincare = [
  { company_name: 'Private Label OEM/ODM Skincare Manufacturer in Singapore', domain: 'dermalab.sg' },
];

let failed = 0;

console.log('--- structural noise (any category) ---');
for (const n of noiseStructural) {
  const why = hardNoiseReason(n, '白菜');
  const ok = !!why;
  console.log(`${ok ? 'DROP' : 'FAIL-KEEP'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- marketplace / content platforms ---');
for (const n of noiseMarketplace) {
  const why = hardNoiseReason(n, '黄瓜');
  const ok = !!why;
  console.log(`${ok ? 'DROP' : 'FAIL-KEEP'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- retail SKU pages ---');
for (const n of noiseRetailSku) {
  const why = hardNoiseReason(n, '黄瓜');
  const ok = !!why;
  console.log(`${ok ? 'DROP' : 'FAIL-KEEP'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- false friend 黄瓜条 (not vegetable) ---');
{
  const n = noiseFalseFriend[0];
  const mention = textMentionsCategory(`${n.company_name}`, '黄瓜');
  const why = hardNoiseReason(n, '黄瓜');
  console.log(`textMentionsCategory → ${mention} (want false)`);
  console.log(`hardNoise → ${why || 'null'} (want false_friend_category)`);
  if (mention) failed += 1;
  if (why !== 'false_friend_category') failed += 1;
}

console.log('\n--- off-category when user=白菜 ---');
for (const n of noiseOffForCabbage) {
  const why = hardNoiseReason(n, '白菜');
  const ok = why === 'off_category';
  console.log(`${ok ? 'DROP' : 'FAIL'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- keep when user=白菜 ---');
for (const k of keepCabbage) {
  const why = hardNoiseReason(k, '白菜');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  ${k.company_name.slice(0, 48)} → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- keep cucumber buyers when user=黄瓜 ---');
for (const k of keepCucumber) {
  const why = hardNoiseReason(k, '黄瓜');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  ${k.company_name.slice(0, 48)} → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- skincare OEM kept when user=护肤 ---');
for (const k of keepWhenSkincare) {
  const why = hardNoiseReason(k, '护肤');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  ${k.company_name.slice(0, 48)} → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- car kept when user=汽车配件 ---');
{
  const car = { company_name: 'The Car Enthusiast Pte Ltd' };
  const why = hardNoiseReason(car, '汽车配件');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  car under 汽车配件 → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- offCategoryReason unit ---');
{
  const a = offCategoryReason('The Car Enthusiast Pte Ltd', '白菜');
  const b = offCategoryReason('Skincare Manufacturer OEM', '护肤');
  const c = offCategoryReason('Cabbage importer wholesale', '白菜');
  const d = offCategoryReason('Cucumber wholesale importer Singapore', '黄瓜');
  console.log(`car vs 白菜 → ${a} (want off_category)`);
  console.log(`skincare vs 护肤 → ${b} (want null)`);
  console.log(`cabbage text vs 白菜 → ${c} (want null)`);
  console.log(`cucumber text vs 黄瓜 → ${d} (want null)`);
  if (a !== 'off_category') failed += 1;
  if (b != null) failed += 1;
  if (c != null) failed += 1;
  if (d != null) failed += 1;
}

const allCabbage = [...noiseStructural, ...noiseOffForCabbage, ...keepCabbage];
const { top, hardRejected } = splitEnrichTopN(allCabbage, 30, '白菜');
console.log(`\nsplitEnrichTopN(白菜): top=${top.length} hardRejected=${hardRejected}`);
if (top.some((t) => /Rankings|Interview|AmCham|Skincare|Pharmaceutical|Car Enthusiast/i.test(t.company_name))) {
  console.error('FAIL: noise leaked into top for 白菜');
  failed += 1;
}

// 相关性保底：噪声池里混入少量黄瓜相关，Top 应优先保住相关
const cucumberPool = [
  ...noiseMarketplace,
  ...noiseRetailSku,
  ...noiseFalseFriend,
  ...keepCucumber,
  { company_name: 'Random Office Supplies SG', domain: 'officesg.com', pillar: 'Pillar 4 Intent' },
  { company_name: 'Generic Trading Co', domain: 'generic.sg', pillar: 'Pillar 2 Direct', industry_match: 'medium' },
];
const cuc = splitEnrichTopN(cucumberPool, 8, '黄瓜');
console.log(
  `\nsplitEnrichTopN(黄瓜): top=${cuc.top.length} hardRejected=${cuc.hardRejected} floor=${cuc.relevanceFilled}/${cuc.relevanceFloor}`,
);
console.log('  top names:', cuc.top.map((t) => t.company_name.slice(0, 40)).join(' | '));
if (cuc.top.some((t) => /Taobao|Foodpanda|Hugging|Lemon8|eBay|Tridge|350G|湿巾/i.test(t.company_name))) {
  console.error('FAIL: marketplace/retail noise leaked into cucumber top');
  failed += 1;
}
if (cuc.relevanceFilled < Math.min(2, cuc.relevanceFloor) && keepCucumber.length >= 2) {
  console.error('FAIL: relevance floor not filled for 黄瓜');
  failed += 1;
}
if (!cuc.top.some((t) => /freshveggies|Le Fresco|cucumber|黄瓜/i.test(t.company_name))) {
  console.error('FAIL: no cucumber-relevant lead in top');
  failed += 1;
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall passed');
