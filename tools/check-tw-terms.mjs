import fs from 'node:fs';

const tw = JSON.parse(fs.readFileSync('packages/shared/src/locales/zh_TW.json', 'utf8'));

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

const flatTW = flatten(tw);

const mainlandTerms = [
  { term: '鏈接', tw: '連結' },
  { term: '刷新', tw: '重新整理' },
  { term: '默認', tw: '預設' },
  { term: '服務器', tw: '伺服器' },
  { term: '登錄', tw: '登入' },
  { term: '註銷', tw: '登出/註銷' },
  { term: '字符', tw: '字元' },
  { term: '信息', tw: '訊息/資訊' },
  { term: '內存', tw: '記憶體' },
  { term: '支持', tw: '支援' },
  { term: '緩存', tw: '快取' },
  { term: '客戶端', tw: '用戶端/客戶端' },
  { term: '網絡', tw: '網路' },
  { term: '郵箱', tw: '電子郵件/信箱' },
  { term: '郵件', tw: '郵件' }, // normal
  { term: '二維碼', tw: 'QR Code/行動條碼' }
];

const results = [];
for (const [key, val] of Object.entries(flatTW)) {
  for (const m of mainlandTerms) {
    if (val.includes(m.term)) {
      results.push({ key, val, term: m.term, replace: m.tw });
    }
  }
}

console.log(`Found ${results.length} occurrences of terms in zh_TW:`);
for (const r of results) {
  console.log(`[${r.key}]: "${r.term}" => "${r.replace}" in "${r.val}"`);
}
