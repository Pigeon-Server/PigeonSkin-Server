import fs from 'node:fs';

const en = JSON.parse(fs.readFileSync('packages/shared/src/locales/en.json', 'utf8'));
const cn = JSON.parse(fs.readFileSync('packages/shared/src/locales/zh_CN.json', 'utf8'));

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

const flatEN = flatten(en);
const flatCN = flatten(cn);

// 检查英语中重复单词（例如 "the the", "to to" 等）
const doubleWordRegex = /\b([a-zA-Z]{2,})\s+\1\b/i;
const doubleWords = [];
for (const [key, val] of Object.entries(flatEN)) {
  const m = val.match(doubleWordRegex);
  if (m) {
    doubleWords.push({ key, val, word: m[1] });
  }
}
console.log('=== Double words in EN:', doubleWords);

// 检查英语中括号或引号不匹配
const bracketIssues = [];
for (const [key, val] of Object.entries(flatEN)) {
  const openParen = (val.match(/\(/g) || []).length;
  const closeParen = (val.match(/\)/g) || []).length;
  if (openParen !== closeParen) {
    bracketIssues.push({ key, val, type: 'parenthesis' });
  }
  const openBracket = (val.match(/\[/g) || []).length;
  const closeBracket = (val.match(/\]/g) || []).length;
  if (openBracket !== closeBracket) {
    bracketIssues.push({ key, val, type: 'square bracket' });
  }
}
console.log('=== Bracket mismatch in EN:', bracketIssues);

// 检查常见英文拼写错误
const typoList = [
  'teh', 'adn', 'occured', 'succesful', 'seperate', 'recieve', 'untill',
  'refered', 'transfered', 'cancelation', 'definately', 'accomodate',
  'availabe', 'unavaliable', 'authentification', 'verfication', 'configration',
  'cant', 'dont', 'wont', 'isnt', 'arent', 'didnt', 'doesnt' // missing apostrophe
];

const typoIssues = [];
for (const [key, val] of Object.entries(flatEN)) {
  for (const typo of typoList) {
    const r = new RegExp(`\\b${typo}\\b`, 'i');
    if (r.test(val)) {
      typoIssues.push({ key, val, typo });
    }
  }
}
console.log('=== Typo issues in EN:', typoIssues);
