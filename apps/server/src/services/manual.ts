import { manualDocumentInput, manualPages, validManualSlug, resolveManualDocuments, type ManualDocument } from '@pigeon-skin/shared/manual';
import { isLocale, type Locale } from '@pigeon-skin/shared/locales';
import type { Bindings } from '../env.ts';

export function manualStorageLocale(locale: Locale): string { return locale === 'zh_CN' ? '' : locale; }

export async function readManualDocuments(env: Pick<Bindings, 'DB'>): Promise<ManualDocument[]> {
  const rows = await env.DB.prepare('SELECT slug, locale, value, updated_at FROM manual_documents').all<{ slug: string; locale: string; value: string; updated_at: number }>();
  const items: ManualDocument[] = [];
  for (const row of rows.results) {
    const slug = row.slug;
    const locale = row.locale || 'zh_CN';
    if (!validManualSlug(slug) || !isLocale(locale)) continue;
    try {
      const parsed = manualDocumentInput.safeParse({ ...JSON.parse(row.value), revision: row.updated_at });
      if (parsed.success) items.push({ slug, locale, title: parsed.data.title, description: parsed.data.description, content: parsed.data.content, group: parsed.data.group || manualPages.find(page => page.slug === slug)?.group || 'Custom documents', updatedAt: row.updated_at });
    } catch { continue; }
  }
  return items;
}

export async function readLocalizedManual(env: Pick<Bindings, 'DB'>, locale: Locale) {
  const documents = await readManualDocuments(env);
  return { items: resolveManualDocuments(documents, locale), overrides: documents.filter(document => document.locale === locale) };
}
