import fs from 'node:fs';

const locales = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'];
const data = {};
for (const loc of locales) {
  data[loc] = JSON.parse(fs.readFileSync(`packages/shared/src/locales/${loc}.json`, 'utf8'));
}

const keys = [
  'admin.ai_fetch_models',
  'admin.ai_model_clear',
  'admin.ai_model_custom',
  'admin.ai_models_empty',
  'admin.ai_models_fetch_failed',
  'admin.ai_models_unavailable',
  'admin.ai_test',
  'admin.ai_test_fail',
  'admin.option_default'
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
