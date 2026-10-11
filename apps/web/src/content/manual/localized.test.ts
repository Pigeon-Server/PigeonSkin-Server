import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { LOCALES, russianPluralRule, FALLBACK_LOCALE } from '@pigeon-skin/shared/locales';
import { manualPages, localizedManualPages } from '@pigeon-skin/shared/manual';
import { marked } from 'marked';
import { manualContent, manualSections } from './index';
import type { LocaleMessages } from '@pigeon-skin/shared/messages';

// 手册测试只需要 (key) => string 的翻译：node 环境直接用 vue-i18n 的
// 消息编译（不经 i18n store —— 它顶层读浏览器全局）。
const baseMessages: Record<string, LocaleMessages> = {
  zh_CN: (await import('@pigeon-skin/shared/locales/zh_CN.json')).default,
  zh_TW: (await import('@pigeon-skin/shared/locales/zh_TW.json')).default,
  en: (await import('@pigeon-skin/shared/locales/en.json')).default,
  es_ES: (await import('@pigeon-skin/shared/locales/es_ES.json')).default,
  ru_RU: (await import('@pigeon-skin/shared/locales/ru_RU.json')).default,
  ja_JP: (await import('@pigeon-skin/shared/locales/ja_JP.json')).default,
};
const plugins = new Map<string, ReturnType<typeof createI18n>>();
function createT(locale: string) {
  if (!plugins.has(locale)) {
    plugins.set(locale, createI18n({
      legacy: false, locale, fallbackLocale: FALLBACK_LOCALE,
      pluralRules: { ru_RU: russianPluralRule },
      messages: baseMessages,
    }));
  }
  const i18n = plugins.get(locale)!;
  const global = i18n.global as unknown as { t(key: string, vars?: Record<string, unknown>, opts?: Record<string, unknown>): string };
  return (key: string) => global.t(key, undefined, { locale });
}

function links(content: string): string[] {
  const result: string[] = [];
  marked.walkTokens(marked.lexer(content), token => { if (token.type === 'link' || token.type === 'image') result.push(token.href); });
  return result.sort();
}
describe('localized manual', () => {
  it('provides all fifteen documents, headings and safe configuration links in all six languages', () => {
    for (const locale of LOCALES) for (const page of manualPages) {
      const source = manualContent(page.slug);
      const content = manualContent(page.slug, locale);
      expect(content.trim(), `${locale}:${page.slug}`).not.toBe('');
      expect(manualSections(content).length, `${locale}:${page.slug}`).toBe(manualSections(source).length);
      expect(links(content), `${locale}:${page.slug}`).toEqual(links(source));
      expect(content.match(/```[\s\S]*?```/g), `${locale}:${page.slug}`).toEqual(source.match(/```[\s\S]*?```/g));
      const translated = localizedManualPages(createT(locale)).find(item => item.slug === page.slug)!;
      expect(translated.title).not.toContain('manual.pages.');
    }
  });
});
