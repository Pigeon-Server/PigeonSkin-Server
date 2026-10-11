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

function dumpPrefix(prefix) {
  const keys = Object.keys(flat.zh_CN).filter(k => k.startsWith(prefix));
  for (const k of keys) {
    const row = { key: k };
    for (const loc of locales) {
      row[loc] = flat[loc][k];
    }
    console.log(JSON.stringify(row));
  }
}

dumpPrefix('integration.');
dumpPrefix('mail.');
dumpPrefix('live2d.');
dumpPrefix('resources.');
dumpPrefix('seo.');
dumpPrefix('editor.');
dumpPrefix('comments.');
dumpPrefix('comment.');
dumpPrefix('home.');
dumpPrefix('config_generator.');
