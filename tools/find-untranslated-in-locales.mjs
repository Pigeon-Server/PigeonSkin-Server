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

// 检查 es_ES, ru_RU, ja_JP 中与 en 完全相同且长度较长（例如 > 8）的条目
for (const loc of ['es_ES', 'ru_RU', 'ja_JP']) {
  const matchesEn = [];
  for (const [key, val] of Object.entries(flat[loc])) {
    const enVal = flat.en[key];
    if (val === enVal && val.length > 8) {
      // 排除常见的专有名词或URL或占位符
      const ignored = [
        'CustomSkinLoader', 'Universal Skin Mod', 'Blessing Skin', 'Pigeon Skin Server',
        'Google AdSense', 'Google Analytics', 'Resend API', 'UUID v', 'MINECRAFT SKIN SERVER',
        'SKINS · CAPES · PLAYERS', '{used} / {total}', 'STARTTLS (587)', 'SSL/TLS (465)',
        'example.com', 'Turnstile', 'Live2D'
      ];
      if (!ignored.some(ig => val.includes(ig))) {
        matchesEn.push({ key, val, cn: flat.zh_CN[key] });
      }
    }
  }
  console.log(`\n=== Matches EN in ${loc} (${matchesEn.length}):`);
  for (const m of matchesEn) {
    console.log(`  [${m.key}]: "${m.val}" (CN: "${m.cn}")`);
  }
}
