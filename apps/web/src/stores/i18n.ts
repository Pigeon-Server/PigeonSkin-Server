import { reactive, watch } from 'vue';
import { createI18n } from 'vue-i18n';
import { LOCALES, FALLBACK_LOCALE, localeTag, normalizeLocale, russianPluralRule, type Locale } from '@pigeon-skin/shared/locales';
import { getMessage, parseTranslationOverrides, withTranslations, type LocaleMessages } from '@pigeon-skin/shared/messages';
import { en, messages, loadLocaleMessages } from '@/locales';

export const baseMessages = reactive<Partial<Record<Locale, LocaleMessages>>>({ ...messages });
const installed = new Set<Locale>(['zh_CN', 'en']);
const versions = new Map<Locale, number>();
let selection = 0;
let stored: string | null = null;
try { stored = localStorage.getItem('locale'); } catch (error) { void error; }

export const i18nPlugin = createI18n({
  legacy: false,
  locale: normalizeLocale(new URLSearchParams(location.search).get('lang') || stored || navigator.language),
  fallbackLocale: FALLBACK_LOCALE,
  pluralRules: { ru_RU: russianPluralRule },
  messages: { ...messages },
  datetimeFormats: Object.fromEntries(LOCALES.map(locale => [localeTag(locale), {
    short: { year: 'numeric', month: 'short', day: 'numeric' },
    long: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  }])),
  numberFormats: Object.fromEntries(LOCALES.map(locale => [localeTag(locale), { decimal: { maximumFractionDigits: 2 } }])),
});

export async function prepareLocale(locale: Locale) {
  const dictionary = await loadLocaleMessages(locale);
  baseMessages[locale] = dictionary;
  if (!installed.has(locale)) {
    i18nPlugin.global.setLocaleMessage(locale, dictionary);
    installed.add(locale);
  }
  return dictionary;
}

export async function reloadTranslations(locale: Locale = normalizeLocale(i18nPlugin.global.locale.value)) {
  const version = (versions.get(locale) || 0) + 1;
  versions.set(locale, version);
  const dictionary = await prepareLocale(locale);
  const response = await fetch('/api/v1/translations?locale=' + locale);
  if (!response.ok) throw new Error('translations');
  const data: unknown = await response.json();
  const items = parseTranslationOverrides(data && typeof data === 'object' && 'items' in data ? data.items : undefined, dictionary);
  if (versions.get(locale) !== version) return;
  i18nPlugin.global.setLocaleMessage(locale, withTranslations(dictionary, items));
}

export async function setLocale(locale: Locale) {
  const version = ++selection;
  await prepareLocale(locale);
  if (selection !== version) return;
  i18nPlugin.global.locale.value = locale;
}

watch(i18nPlugin.global.locale, value => {
  const locale = normalizeLocale(value);
  document.documentElement.lang = localeTag(locale);
  try { localStorage.setItem('locale', locale); } catch (error) { void error; }
  document.cookie = 'locale=' + encodeURIComponent(locale) + '; Path=/; Max-Age=7200; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  void reloadTranslations(locale).catch(() => {});
}, { immediate: true });

export function useI18n() {
  const composer = i18nPlugin.global;
  return {
    locale: composer.locale,
    t: (key: string, vars: Record<string, string | number> = {}, plural?: number) => {
      const locale = normalizeLocale(composer.locale.value);
      const known = (baseMessages[locale] && getMessage(baseMessages[locale]!, key)) ?? getMessage(en, key);
      return composer.t(known === undefined ? 'common.internal_error' : key, vars, plural === undefined ? {} : { plural });
    },
    n: (value: number) => composer.n(value, { key: 'decimal', locale: localeTag(normalizeLocale(composer.locale.value)) }),
    d: (value: number | Date, format = 'long') => composer.d(value, { key: format, locale: localeTag(normalizeLocale(composer.locale.value)) }),
    setLocale,
  };
}
