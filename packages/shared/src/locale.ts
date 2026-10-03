export const LOCALES = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'] as const;
export type Locale = typeof LOCALES[number];

export const DEFAULT_LOCALE: Locale = 'zh_CN';
export const FALLBACK_LOCALE: Locale = 'en';
export const LOCALE_OPTIONS = [
  { value: 'zh_CN', name: '中文 (简体)', tag: 'zh-CN' },
  { value: 'zh_TW', name: '中文 (正體)', tag: 'zh-TW' },
  { value: 'en', name: 'English', tag: 'en' },
  { value: 'es_ES', name: 'Español', tag: 'es' },
  { value: 'ru_RU', name: 'Русский язык', tag: 'ru' },
  { value: 'ja_JP', name: '日本語', tag: 'ja' },
] as const;

export function localeTag(locale: Locale): string {
  return LOCALE_OPTIONS.find(option => option.value === locale)!.tag;
}

export function russianPluralRule(choice: number): number {
  const count = Math.abs(Math.trunc(choice));
  if (count % 10 === 1 && count % 100 !== 11) return 1;
  if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) return 2;
  return 0;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(tag: string | null | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE;
  const lower = tag.trim().replaceAll('_', '-').toLowerCase();
  if (/^zh-(?:hant(?:-|$)|tw(?:-|$)|hk(?:-|$)|mo(?:-|$))/.test(lower)) return 'zh_TW';
  if (/^zh(?:-|$)/.test(lower)) return 'zh_CN';
  if (/^en(?:-|$)/.test(lower)) return 'en';
  if (/^es(?:-|$)/.test(lower)) return 'es_ES';
  if (/^ru(?:-|$)/.test(lower)) return 'ru_RU';
  if (/^ja(?:-|$)/.test(lower)) return 'ja_JP';
  return FALLBACK_LOCALE;
}
