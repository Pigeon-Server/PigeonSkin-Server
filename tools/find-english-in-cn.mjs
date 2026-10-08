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

// 检查 zh_CN 中没有中文字符的条目（排除纯数字、纯符号、纯代码变量或专有名词）
const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const latinRegex = /[a-zA-Z]/;

const suspiciousCN = [];
for (const [key, val] of Object.entries(flat.zh_CN)) {
  // 如果全是英文单词且长度 > 3，并且不含任何汉字
  if (!cjkRegex.test(val) && latinRegex.test(val)) {
    suspiciousCN.push({ key, val, en: flat.en[key], tw: flat.zh_TW[key] });
  }
}

console.log(`=== Suspicious entries in zh_CN without CJK (${suspiciousCN.length}):`);
for (const item of suspiciousCN) {
  console.log(`[${item.key}]: CN="${item.val}" | TW="${item.tw}" | EN="${item.en}"`);
}
