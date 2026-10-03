import { describe, expect, it } from 'vitest';
import { canonicalPagePath, indexablePage, pageCanonical, languageAlternates } from '@pigeon-skin/shared/seo';

describe('规范网址与索引范围', () => {
  it('旧地址和跟踪参数指向同一规范页', () => {
    expect(canonicalPagePath('/skinlib/show/42/')).toBe('/skinlib/42');
    expect(pageCanonical('https://skin.example', '/skinlib/show/42', '?utm_source=search#detail')).toBe('https://skin.example/skinlib/42');
  });
  it('保留分页并排除任意筛选组合和账号页面', () => {
    expect(pageCanonical('https://skin.example', '/skinlib', '?page=2&utm_source=search')).toBe('https://skin.example/skinlib?page=2');
    expect(indexablePage('/skinlib', '?page=2')).toBe(true);
    expect(indexablePage('/skinlib', '?mine=true')).toBe(false);
    expect(indexablePage('/skinlib', '?keyword=test')).toBe(false);
    expect(indexablePage('/profile')).toBe(false);
    expect(indexablePage('/manual/customskinloader')).toBe(true);
  });
  it('gives each language its own URL without duplicating the selected language parameter', () => {
    const alternates = languageAlternates('https://skin.example/skinlib?lang=ja_JP&page=2');
    expect(alternates).toHaveLength(7);
    expect(alternates.find(item => item.tag === 'en')?.href).toBe('https://skin.example/skinlib?lang=en&page=2');
    expect(alternates.find(item => item.tag === 'zh-CN')?.href).toBe('https://skin.example/skinlib?page=2');
    expect(new Set(alternates.filter(item => item.tag !== 'x-default').map(item => item.href)).size).toBe(6);
  });
});
