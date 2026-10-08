import fs from 'node:fs';

const locales = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'];
const data = {};
for (const loc of locales) {
  data[loc] = JSON.parse(fs.readFileSync(`packages/shared/src/locales/${loc}.json`, 'utf8'));
}

function flatten(obj, prefix = '') {
  let res = {};
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(res, flatten(val, key));
    } else {
      res[key] = String(val);
    }
  }
  return res;
}

const flat = {};
for (const loc of locales) {
  flat[loc] = flatten(data[loc]);
}

for (const loc of locales) {
  const issues = [];
  for (const [key, val] of Object.entries(flat[loc])) {
    // 检查大括号配对
    const openBraces = (val.match(/\{/g) || []).length;
    const closeBraces = (val.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      issues.push(`[${key}] Unmatched curly braces: "${val}"`);
    }

    // 检查双引号、单引号是否有奇怪的未转义或不成对情况（针对带有全角半角混杂的）
    // 比如中文的 “ ”「 」
    const cnQuotesOpen = (val.match(/“/g) || []).length;
    const cnQuotesClose = (val.match(/”/g) || []).length;
    if (cnQuotesOpen !== cnQuotesClose) {
      issues.push(`[${key}] Unmatched double curly quotes: "${val}"`);
    }
    const jpQuotesOpen = (val.match(/「/g) || []).length;
    const jpQuotesClose = (val.match(/」/g) || []).length;
    if (jpQuotesOpen !== jpQuotesClose) {
      issues.push(`[${key}] Unmatched corner brackets 「」: "${val}"`);
    }
  }
  if (issues.length > 0) {
    console.log(`\n=== Formatting issues in ${loc} (${issues.length}):`);
    for (const iss of issues) console.log(iss);
  }
}
