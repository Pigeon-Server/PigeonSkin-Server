import { describe, expect, it } from 'vitest';
import { LOCALES } from '@pigeon-skin/shared/locales';
import { createT } from '@pigeon-skin/shared/i18n';
import { manualPages, localizedManualPages } from '@pigeon-skin/shared/manual';
import { marked } from 'marked';
import { manualContent, manualSections } from './index';

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
