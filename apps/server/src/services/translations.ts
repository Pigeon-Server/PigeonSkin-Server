
import { type Bindings } from './../core/env.ts';
import { createT, type Locale } from './../core/i18n.ts';
import type { TranslationOverride } from '@pigeon-skin/shared/messages';
import { readPublicCache, invalidatePublicCache, type PublicCacheEnv } from '../core/public-cache.ts';

export function invalidateTranslationCache() { invalidatePublicCache(); }

export async function translationOverrides(env: PublicCacheEnv, locale: Locale): Promise<TranslationOverride[]> {
  return readPublicCache(env, `translations:${locale}`, ['translations'], async () => {
    const { results } = await env.DB.prepare('SELECT key,value FROM translation_overrides WHERE locale = ? ORDER BY key').bind(locale).all<TranslationOverride>();
    return results.filter(row => typeof row.key === 'string' && typeof row.value === 'string');
  });
}

export async function serviceTranslator(env: Pick<Bindings, 'DB'>, locale: Locale) {
  return createT(locale, await translationOverrides(env, locale));
}
