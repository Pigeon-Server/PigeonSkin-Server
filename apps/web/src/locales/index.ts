import type { Locale } from '@pigeon-skin/shared/locales';
import type { LocaleMessages } from '@pigeon-skin/shared/messages';
import english from '@pigeon-skin/shared/locales/en.json';
import chinese from '@pigeon-skin/shared/locales/zh_CN.json';

export const messages: Partial<Record<Locale, LocaleMessages>> = { zh_CN: chinese, en: english };
export const zh_CN = chinese;
export const en = english;

const loaders = {
  zh_TW: () => import('@pigeon-skin/shared/locales/zh_TW.json'),
  es_ES: () => import('@pigeon-skin/shared/locales/es_ES.json'),
  ru_RU: () => import('@pigeon-skin/shared/locales/ru_RU.json'),
  ja_JP: () => import('@pigeon-skin/shared/locales/ja_JP.json'),
};
const pending = new Map<Locale, Promise<LocaleMessages>>();

export async function loadLocaleMessages(locale: Locale): Promise<LocaleMessages> {
  if (messages[locale]) return messages[locale]!;
  if (!pending.has(locale)) {
    const task = loaders[locale as keyof typeof loaders]().then(module => {
      messages[locale] = module.default;
      return module.default;
    }).finally(() => pending.delete(locale));
    pending.set(locale, task);
  }
  return pending.get(locale)!;
}
