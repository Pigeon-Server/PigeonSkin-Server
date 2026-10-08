import fs from 'node:fs';
import path from 'node:path';

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

// 1. Check placeholder consistency
// Vue I18n allows {'@'} or {'|'} or placeholders like {name}
const placeholderRegex = /\{([a-zA-Z0-9_]+)\}/g;
const linkedRegex = /@:([a-zA-Z0-9_.]+)/g;

const allKeys = Object.keys(flat.zh_CN);
const placeholderIssues = [];
const linkedIssues = [];

for (const key of allKeys) {
  const getParams = (str) => {
    const matches = str.matchAll(placeholderRegex);
    const params = new Set();
    for (const m of matches) {
      params.add(m[1]);
    }
    return Array.from(params).sort();
  };

  const cnParams = getParams(flat.zh_CN[key] || '');
  for (const loc of locales) {
    const val = flat[loc]?.[key];
    if (val === undefined) {
      placeholderIssues.push(`Missing key in ${loc}: ${key}`);
      continue;
    }
    const locParams = getParams(val);
    if (JSON.stringify(cnParams) !== JSON.stringify(locParams)) {
      placeholderIssues.push(`Param mismatch in ${loc} for "${key}": CN has [${cnParams.join(',')}], ${loc} has [${locParams.join(',')}].\n  CN: "${flat.zh_CN[key]}"\n  ${loc}: "${val}"`);
    }

    // Check linked messages
    const links = Array.from(val.matchAll(linkedRegex)).map(m => m[1]);
    for (const link of links) {
      if (!flat[loc]?.[link]) {
        linkedIssues.push(`Broken link in ${loc} for "${key}": @:${link} does not exist`);
      }
    }
  }
}

console.log('=== Placeholder issues count:', placeholderIssues.length);
for (const issue of placeholderIssues) console.log(issue);

console.log('\n=== Linked issues count:', linkedIssues.length);
for (const issue of linkedIssues) console.log(issue);

// 2. Check for unexpected Chinese in non-zh locales
const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/;
for (const loc of ['en', 'es_ES', 'ru_RU']) {
  const cjkIssues = [];
  for (const [key, val] of Object.entries(flat[loc])) {
    if (cjkRegex.test(val)) {
      cjkIssues.push(`[${loc}] ${key}: ${val}`);
    }
  }
  if (cjkIssues.length > 0) {
    console.log(`\n=== Unexpected CJK characters in ${loc} (${cjkIssues.length}):`);
    for (const issue of cjkIssues.slice(0, 30)) console.log(issue);
  }
}
