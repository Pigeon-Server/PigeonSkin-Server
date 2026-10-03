import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createI18n } from 'vue-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en, messages, loadLocaleMessages } from '@/locales';
import { LOCALES, russianPluralRule, type Locale } from '@pigeon-skin/shared/locales';
import { ERROR_CODES } from '@pigeon-skin/shared';
import { flattenMessages } from '@pigeon-skin/shared/messages';

function flatten(data: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(data).flatMap(([key, value]) => typeof value === 'string' ? [[prefix + key, value]] : Object.entries(flatten(value as Record<string, unknown>, prefix + key + '.'))));
}
let dictionaries: Record<Locale, Record<string, string>>;
beforeAll(async () => {
  await Promise.all(LOCALES.map(loadLocaleMessages));
  dictionaries = Object.fromEntries(LOCALES.map(locale => [locale, flatten(messages[locale]!)])) as Record<Locale, Record<string, string>>;
});
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name)) : item.name.endsWith('.vue') ? [resolve(dir, item.name)] : []);
}
describe('translations', () => {
  it('labels and filters every recorded audit action', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../api/src/services/audit.ts', import.meta.url)), 'utf8');
    const view = readFileSync(fileURLToPath(new URL('../views/admin/AuditLog.vue', import.meta.url)), 'utf8');
    const actions = [...source.matchAll(/\| '(admin\.[\w.]+)'/g)].map(match => match[1]!);
    for (const action of actions) {
      expect(view, action).toContain(`'${action}'`);
      const key = `admin.action.${action.replace('admin.', '').replaceAll('.', '_')}`;
      for (const language of Object.values(dictionaries)) expect(language[key], key).toBeDefined();
    }
  });
  it('selects English singular and plural resource counts', () => {
    const instance: any = createI18n({ legacy: false, locale: 'en', messages: { en: en as any } });
    expect(instance.global.t('common.count', { count: '0' }, { plural: 0 })).toBe('0 items');
    expect(instance.global.t('common.count', { count: '1' }, { plural: 1 })).toBe('1 item');
    expect(instance.global.t('common.count', { count: '1,000' }, { plural: 1000 })).toBe('1,000 items');
  });
  it('selects Russian grammatical forms for resource counts', () => {
    const instance: any = createI18n({ legacy: false, locale: 'ru_RU', messages: messages as any, pluralRules: { ru_RU: russianPluralRule } });
    for (const [count, expected] of [[1, '1 элемент'], [2, '2 элемента'], [5, '5 элементов'], [11, '11 элементов'], [21, '21 элемент'], [22, '22 элемента'], [25, '25 элементов']] as const) {
      expect(instance.global.t('common.count', { count }, { plural: count })).toBe(expected);
    }
  });
  it('keeps both languages synchronized', () => {
    for (const locale of LOCALES) expect(Object.keys(dictionaries[locale]).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it('translates every application key in each bundled locale', () => {
    const localeDirectory = fileURLToPath(new URL('../../../../packages/shared/src/locales/', import.meta.url));
    const expected = Object.keys(dictionaries.en).sort();
    for (const locale of LOCALES) {
      const translated = flattenMessages(JSON.parse(readFileSync(resolve(localeDirectory, `${locale}.json`), 'utf8')));
      expect(Object.keys(translated).sort(), locale).toEqual(expected);
    }
  });
  it('preserves every interpolation parameter in every language', () => {
    for (const locale of LOCALES) for (const [key, message] of Object.entries(dictionaries.en)) {
      // 复数语言（如 en）同一参数会出现多次；无复数语言（zh/ja）只出现一次，按参数名去重后比较
      const parameters = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!))].sort();
      expect(parameters(dictionaries[locale][key]!), `${locale}:${key}`).toEqual(parameters(message));
    }
  });
  it('translates every API error and every static component key', () => {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const keys = new Set([...ERROR_CODES, ...files(source).flatMap(path => [...readFileSync(path, 'utf8').matchAll(/i18n\.t\(\s*['"]([\w.-]+)['"]\s*(?=[,)])/g)].map(match => match[1]!))]);
    for (const suffix of ['walk', 'run', 'fly', 'idle']) keys.add('skinlib.animation_' + suffix);
    for (const suffix of ['transparent', 'white', 'gray', 'black']) keys.add('skinlib.background_' + suffix);
    for (const key of ['default_skin_name', 'default_cape_name', 'copy_name', 'unsaved', 'saving', 'frame_title', 'wrong_kind']) keys.add('editor.' + key);
    for (const language of Object.values(dictionaries)) for (const key of keys) expect(language[key], key).toBeDefined();
  });
  it('translates every setting label and route title', () => {
    const registry = readFileSync(fileURLToPath(new URL('../../../api/src/services/settings.ts', import.meta.url)), 'utf8');
    const settingKeys = [...registry.matchAll(/\n {2}([\w]+): \{ kind:/g)].map(match => `admin.setting.${match[1]}`);
    const router = readFileSync(fileURLToPath(new URL('../router/index.ts', import.meta.url)), 'utf8');
    const routeKeys = [...router.matchAll(/title: ['"]([\w.-]+)['"]/g)].map(match => match[1]!);
    for (const language of Object.values(dictionaries)) for (const key of [...settingKeys, ...routeKeys]) expect(language[key], key).toBeDefined();
  });
  it('routes whose view manages its own SEO metadata are marked seoSelf', () => {
    // 自管 SEO 的视图（自己调用 applyPageMetadata）必须带 seoSelf（或 manual 布局），
    // 否则 App.vue 的兜底 watch 会与视图互相覆写 robots/title。
    const viewsWithApplyPageMetadata = ['views/skinlib/Show.vue', 'views/Manual.vue'];
    const router = readFileSync(fileURLToPath(new URL('../router/index.ts', import.meta.url)), 'utf8');
    for (const view of viewsWithApplyPageMetadata) {
      const source = readFileSync(fileURLToPath(new URL(`../${view}`, import.meta.url)), 'utf8');
      expect(source).toContain('applyPageMetadata');
      const modulePath = `@/${view.replace('.vue', '.vue')}`;
      const routes = router.split('{ path:').filter(entry => entry.includes(modulePath));
      expect(routes.length, `${view} 应有对应路由`).toBeGreaterThan(0);
      for (const entry of routes) {
        expect(entry.includes('seoSelf: true') || entry.includes("layout: 'manual'"), `${view} 的路由缺少 seoSelf meta`).toBe(true);
      }
    }
  });
  it('compiles every message and interpolates repeated values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance: any = createI18n({ legacy: false, messages: messages as any, locale: 'zh_CN' });
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      instance.global.locale.value = locale as Locale;
      for (const [key, message] of Object.entries(dictionary)) {
        const values = Object.fromEntries([...message.matchAll(/\{(\w+)\}/g)].map(match => [match[1], '42']));
        expect(instance.global.t(key, values), key).toEqual(expect.any(String));
      }
    }
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore(); error.mockRestore();
  });
});
