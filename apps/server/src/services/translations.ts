import type { Bindings } from '../env.ts';
import { createT, type Locale } from '@pigeon-skin/shared/i18n';
import type { TranslationOverride } from '@pigeon-skin/shared/messages';

let cache = new WeakMap<Bindings['DB'], Map<Locale, { expiresAt: number; entries: TranslationOverride[] }>>();

export function invalidateTranslationCache() { cache = new WeakMap(); }

export async function translationOverrides(env: Pick<Bindings, 'DB'>, locale: Locale): Promise<TranslationOverride[]> {
  const cached = cache.get(env.DB)?.get(locale);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  const { results } = await env.DB.prepare('SELECT key,value FROM translation_overrides WHERE locale = ?').bind(locale).all<TranslationOverride>();
  const entries = results.filter(row => typeof row.key === 'string' && typeof row.value === 'string');
  if (!cache.has(env.DB)) cache.set(env.DB, new Map());
  cache.get(env.DB)!.set(locale, { expiresAt: Date.now() + 60_000, entries });
  return entries;
}

export async function serviceTranslator(env: Pick<Bindings, 'DB'>, locale: Locale) {
  return createT(locale, await translationOverrides(env, locale));
}
