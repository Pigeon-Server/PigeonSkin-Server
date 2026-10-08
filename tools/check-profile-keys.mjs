import fs from 'node:fs';

const locales = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'];
const data = {};
for (const loc of locales) {
  data[loc] = JSON.parse(fs.readFileSync(`packages/shared/src/locales/${loc}.json`, 'utf8'));
}

const keys = [
  'user.profile_skins',
  'user.profile_capes',
  'user.profile_players',
  'user.profile_since'
];

function getByPath(obj, path) {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

for (const key of keys) {
  console.log(`\nKey: ${key}`);
  for (const loc of locales) {
    console.log(`  [${loc}]: ${getByPath(data[loc], key)}`);
  }
}
