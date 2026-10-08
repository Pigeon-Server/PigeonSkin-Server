import fs from 'node:fs';

const locales = ['zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'];
const manuals = {};
for (const loc of locales) {
  manuals[loc] = JSON.parse(fs.readFileSync(`apps/web/src/content/manual/localized/${loc}.json`, 'utf8'));
}

for (const loc of locales) {
  console.log(`\n=== Manual for ${loc} ===`);
  const m = manuals[loc];
  console.log(`Pages count: ${Object.keys(m).length}`);
  for (const [pageKey, pageData] of Object.entries(m)) {
    // 检查 pageData 是否有 title, summary, content
    if (!pageData.title || !pageData.summary || !pageData.content) {
      console.log(`[${loc}][${pageKey}] Missing field:`, Object.keys(pageData));
    }
    // 检查大括号配对
    const openBraces = (pageData.content.match(/\{/g) || []).length;
    const closeBraces = (pageData.content.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      console.log(`[${loc}][${pageKey}] Unmatched braces in content`);
    }
  }
}
