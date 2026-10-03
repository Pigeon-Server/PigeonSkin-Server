import { compile, createCoreContext, fallbackWithLocaleChain, registerMessageCompiler, resolveValue, translate as translateMessage } from '@intlify/core-base';
import zh_CN from './locales/zh_CN.json' with { type: 'json' };
import zh_TW from './locales/zh_TW.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import es_ES from './locales/es_ES.json' with { type: 'json' };
import ru_RU from './locales/ru_RU.json' with { type: 'json' };
import ja_JP from './locales/ja_JP.json' with { type: 'json' };
import { FALLBACK_LOCALE, russianPluralRule, type Locale } from './locale.ts';
import { withTranslations, type LocaleMessages, type TranslationOverride } from './messages.ts';

export * from './locale.ts';
export const UI_MESSAGES: Record<Locale, LocaleMessages> = { zh_CN, zh_TW, en, es_ES, ru_RU, ja_JP };
export type TranslateKey = string;
registerMessageCompiler(compile);

export function validateMessage(locale: Locale, key: string, message: string): void {
  compile(message, { locale, key, onError: error => { throw error; } });
}

export function createT(locale: Locale, overrides: readonly TranslationOverride[] = []) {
  const context = createCoreContext({
    locale, fallbackLocale: FALLBACK_LOCALE,
    messages: { ...UI_MESSAGES, [locale]: overrides.length ? withTranslations(UI_MESSAGES[locale], overrides) : UI_MESSAGES[locale] },
    pluralRules: { ru_RU: russianPluralRule },
    messageResolver: resolveValue, localeFallbacker: fallbackWithLocaleChain,
    missingWarn: false, fallbackWarn: false,
  });
  return (key: string, vars: Record<string, string | number> = {}, plural?: number): string => {
    const value = translateMessage(context, key, vars, plural === undefined ? {} : { plural });
    return typeof value === 'string' ? value : key;
  };
}

export function translate(locale: Locale, key: string, vars: Record<string, string | number> = {}, plural?: number): string {
  return createT(locale)(key, vars, plural);
}
