import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_OPTIONS, UI_MESSAGES, normalizeLocale, isLocale, localeTag, translate, createT } from '../src/i18n.ts';
import { getMessage, flattenMessages, parseTranslationOverrides, withTranslations } from '../src/messages.ts';

describe('shared locale messages', () => {
  it('supports the six locales and normalizes browser tags', () => {
    expect(LOCALES).toEqual(['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP']);
    expect(LOCALE_OPTIONS.map(option => option.value)).toEqual(LOCALES);
    expect(isLocale('fr_FR')).toBe(false);
    const inputs = { zh_HANS_CN: 'zh_CN', 'zh-Hans-CN': 'zh_CN', zh_TW: 'zh_TW', 'zh-Hant-TW': 'zh_TW', 'zh-HK': 'zh_TW', en_US: 'en', 'es-MX': 'es_ES', ru: 'ru_RU', 'ja-JP': 'ja_JP' };
    for (const [input, expected] of Object.entries(inputs)) expect(normalizeLocale(input)).toBe(expected);
    expect(normalizeLocale('de-DE')).toBe('en');
    expect(normalizeLocale(null)).toBe('zh_CN');
    for (const locale of LOCALES) expect(() => new Intl.DateTimeFormat(localeTag(locale))).not.toThrow();
  });
  it('keeps complete nested resources and detects language contamination', () => {
    const english = flattenMessages(UI_MESSAGES.en);
    for (const locale of LOCALES) {
      const dictionary = flattenMessages(UI_MESSAGES[locale]);
      expect(Object.keys(dictionary)).toHaveLength(1523);
      expect(Object.keys(dictionary).sort(), locale).toEqual(Object.keys(english).sort());
      expect(Object.keys(UI_MESSAGES[locale]).every(key => !key.includes('.'))).toBe(true);
      if (locale === 'zh_CN' || locale === 'zh_TW') {
        expect(Object.values(dictionary).filter(value => /[㐀-鿿]/.test(value)).length / Object.keys(dictionary).length).toBeGreaterThan(0.85);
      }
    }
    expect(translate('zh_CN', 'security.bind')).toBe('绑定');
    expect(translate('zh_CN', 'security.title')).toBe('账户安全');
    expect(translate('en', 'security.bind')).toBe('Connect');
    expect(translate('en', 'security.title')).toBe('Account security');
  });
  it('shares Vue interpolation, literal characters, linked messages and plurals', () => {
    const original = UI_MESSAGES.en.test;
    UI_MESSAGES.en.test = { repeated: '{name} {name} {name}', literal: "{'@'}{'|'}", linked: '@:security.title' };
    try {
      expect(translate('en', 'test.repeated', { name: 'Alex' })).toBe('Alex Alex Alex');
      expect(translate('en', 'test.literal')).toBe('@|');
      expect(translate('en', 'test.linked')).toBe('Account security');
      expect(translate('en', 'common.count', { count: 1 }, 1)).toBe('1 item');
      expect(translate('en', 'common.count', { count: 2 }, 2)).toBe('2 items');
      expect(translate('ru_RU', 'common.count', { count: 22 }, 22)).toBe('22 элемента');
    } finally {
      if (original === undefined) delete UI_MESSAGES.en.test;
      else UI_MESSAGES.en.test = original;
    }
  });
  it('falls back without depending on old dictionaries', () => {
    const mail = UI_MESSAGES.ja_JP.mail as Record<string, string>;
    const value = mail.security_title;
    delete mail.security_title;
    try { expect(translate('ja_JP', 'mail.security_title')).toBe('Account security code'); }
    finally { if (value !== undefined) mail.security_title = value; }
  });
  it('isolates overrides and rejects prototype and branch replacements', () => {
    const overrides = [
      { key: 'security.title', value: 'Custom {name}' },
      { key: '__proto__.polluted', value: 'x' },
      { key: 'security', value: 'x' },
      { key: 'unknown.key', value: 'x' },
    ];
    const messages = withTranslations(UI_MESSAGES.en, overrides);
    expect(getMessage(messages, 'security.title')).toBe('Custom {name}');
    expect(getMessage(UI_MESSAGES.en, 'security.title')).toBe('Account security');
    expect(getMessage(messages, 'unknown.key')).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(createT('en', overrides)('security.title', { name: 'Alex' })).toBe('Custom Alex');
  });
  it('validates translation API items before merge', () => {
    expect(parseTranslationOverrides([{ key: 'common.save', value: 'Save now' }], UI_MESSAGES.en)).toEqual([{ key: 'common.save', value: 'Save now' }]);
    for (const value of [null, {}, [{ key: 'missing.key', value: 'x' }], [{ key: 'common.save', value: 1 }]]) {
      expect(() => parseTranslationOverrides(value, UI_MESSAGES.en)).toThrow();
    }
  });
});
