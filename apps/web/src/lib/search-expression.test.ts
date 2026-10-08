import { describe, expect, it } from 'vitest';
import { appendSearchExample, searchAst, searchFieldExample } from '@/lib/search-expression';
import { SEARCH_SCHEMAS, searchSchema } from '@pigeon-skin/shared/search';
import type { SearchField } from '@pigeon-skin/shared/search';
import { flattenMessages } from '@pigeon-skin/shared/messages';
import type { Locale } from '@pigeon-skin/shared/locales';
import chinese from '@pigeon-skin/shared/locales/zh_CN.json';
import traditional from '@pigeon-skin/shared/locales/zh_TW.json';
import english from '@pigeon-skin/shared/locales/en.json';
import spanish from '@pigeon-skin/shared/locales/es_ES.json';
import russian from '@pigeon-skin/shared/locales/ru_RU.json';
import japanese from '@pigeon-skin/shared/locales/ja_JP.json';

const DICTIONARIES: Record<string, Record<string, string>> = {
  zh_CN: flattenMessages(chinese),
  zh_TW: flattenMessages(traditional),
  en: flattenMessages(english),
  es_ES: flattenMessages(spanish),
  ru_RU: flattenMessages(russian),
  ja_JP: flattenMessages(japanese),
} satisfies Record<Locale, Record<string, string>>;

describe('search expression ui helpers', () => {
  it('appends an example instead of replacing what is already typed', () => {
    expect(appendSearchExample('', 'kind:skin')).toBe('kind:skin');
    expect(appendSearchExample('   ', 'kind:skin')).toBe('kind:skin');
    expect(appendSearchExample('kind:skin', 'likes>100')).toBe('kind:skin likes>100');
    // 末尾多余空格不会累积成双空格（相邻条件本身就是 AND）
    expect(appendSearchExample('kind:skin  ', 'likes>100')).toBe('kind:skin likes>100');
  });

  it('falls back to a literal keyword when the expression does not parse', () => {
    // 解析不了的输入不做错误反馈：整串当成一个短语去搜，与后端一致
    expect(searchAst('', 'textures')).toBeNull();
    expect(searchAst('kind:skin likes>10', 'textures')).toMatchObject({ type: 'and' });
    expect(searchAst('nope:1', 'textures')).toEqual({ type: 'term', value: 'nope:1', phrase: true });
    expect(searchAst('"未闭合', 'textures')).toEqual({ type: 'term', value: '"未闭合', phrase: true });
    expect(searchAst('..', 'textures')).toEqual({ type: 'term', value: '..', phrase: true });
    // 字段是否可用按入口而定：同一个字段在另一个入口就是普通词
    expect(searchAst('role:admin', 'adminUsers')).toMatchObject({ type: 'field', field: 'role' });
    expect(searchAst('role:admin', 'textures')).toMatchObject({ type: 'term' });
  });

  it('generates a usable example for every field of every schema', () => {
    for (const key of Object.keys(SEARCH_SCHEMAS) as (keyof typeof SEARCH_SCHEMAS)[]) {
      for (const field of searchSchema(key).fields) {
        const example = searchFieldExample(field);
        expect(example.startsWith(`${field.name}`), `${key}.${field.name}`).toBe(true);
        // 示例必须自己能解析成字段条件，否则帮助面板会教出错误写法
        expect(searchAst(example, key), `${key}:${example}`).toMatchObject({ type: 'field', field: field.name });
      }
    }
  });

  it('has every field label and unit translated in all six languages', () => {
    for (const key of Object.keys(SEARCH_SCHEMAS) as (keyof typeof SEARCH_SCHEMAS)[]) {
      for (const field of searchSchema(key).fields) {
        for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
          expect(dictionary[field.labelKey], `${locale}:${key}.${field.name} label`).toBeDefined();
          if (field.unitKey) expect(dictionary[field.unitKey], `${locale}:${key}.${field.name} unit`).toBeDefined();
        }
      }
    }
  });

  it('prefers a representative enum value over the first one', () => {
    const field = (name: string): SearchField => searchSchema('adminUsers').fields.find(item => item.name === name)!;
    expect(searchFieldExample(field('role'))).toBe('role:admin');
    expect(searchFieldExample(searchSchema('translations').fields.find(item => item.name === 'locale')!)).toBe('locale:zh_CN');
  });
});
