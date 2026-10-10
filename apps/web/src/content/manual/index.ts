export { manualGroups, manualPages } from '@pigeon-skin/shared/manual';
import { matchSearch, parseSearchExpressionLenient, searchSchema } from '@pigeon-skin/shared/search';
import { marked, type Token } from 'marked';
import type { Locale } from '@pigeon-skin/shared/locales';
import english from './localized/en.json';
import traditional from './localized/zh_TW.json';
import spanish from './localized/es_ES.json';
import russian from './localized/ru_RU.json';
import japanese from './localized/ja_JP.json';
const sources = import.meta.glob('./*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const localized: Partial<Record<Locale, Record<string, string>>> = { en: english, zh_TW: traditional, es_ES: spanish, ru_RU: russian, ja_JP: japanese };
export function manualContent(slug: string, locale: Locale = 'zh_CN'): string {
  const key = slug || 'welcome';
  return locale === 'zh_CN' ? sources[`./${key}.md`] || english[key as keyof typeof english] || '' : localized[locale]?.[key] || english[key as keyof typeof english] || '';
}
export function manualSections(content: string) {
  const plainText = (tokens: Token[]): string => tokens.map(token => {
    if ('tokens' in token && Array.isArray(token.tokens)) return plainText(token.tokens);
    if ('text' in token && typeof token.text === 'string') return token.text;
    return ' ';
  }).join('');
  const sections = [{ id: 'overview', title: '', content: '' }];
  for (const token of marked.lexer(content)) {
    if (token.type === 'heading' && token.depth === 2) sections.push({ id: `section-${sections.length}`, title: plainText(token.tokens || []), content: '' });
    else sections.at(-1)!.content += token.raw;
  }
  return sections.map(section => ({ ...section, content: section.content.trim() }));
}
/**
 * 手册页面搜索。内置页与自定义页共用这一个实现，避免两套搜索语义并存。
 *
 * 空输入不过滤；解析不了的输入按普通关键词处理（与站内其他搜索一致）。
 */
export function searchManualPages(
  query: string,
  pages: readonly { slug: string; title: string; description: string; group: string }[],
  contentOf: (slug: string) => string,
): readonly { slug: string; title: string; description: string; group: string }[] {
  const schema = searchSchema('manual');
  const ast = parseSearchExpressionLenient(query, schema);
  if (!ast) return pages;
  return pages.filter(page => matchSearch(ast, schema, {
    title: page.title,
    body: `${page.description} ${contentOf(page.slug)}`,
    group: page.group,
  }));
}
