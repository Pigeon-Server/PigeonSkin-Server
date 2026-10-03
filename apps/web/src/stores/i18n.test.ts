import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import english from '@pigeon-skin/shared/locales/en.json';
import chinese from '@pigeon-skin/shared/locales/zh_CN.json';
import spanish from '@pigeon-skin/shared/locales/es_ES.json';
import russian from '@pigeon-skin/shared/locales/ru_RU.json';

const fixtures = vi.hoisted(() => ({ delays: {} as Record<string, Promise<void>>, load: vi.fn() }));
vi.mock('@/locales', () => ({
  en: english, messages: { en: english, zh_CN: chinese },
  loadLocaleMessages: async (locale: string) => {
    await fixtures.load(locale);
    await fixtures.delays[locale];
    return ({ en: english, zh_CN: chinese, es_ES: spanish, ru_RU: russian } as Record<string, unknown>)[locale];
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = (value: string) => new Response(JSON.stringify({ items: [{ key: 'common.save', value }] }));

beforeEach(async () => {
  vi.resetModules(); fixtures.load.mockReset(); fixtures.delays = {};
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('location', { search: '?lang=zh_CN', protocol: 'http:' });
  vi.stubGlobal('document', { documentElement: { lang: '' }, cookie: '' });
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
  const store = await import('./i18n');
  await store.reloadTranslations('zh_CN');
});
afterEach(() => vi.unstubAllGlobals());

describe('locale state and translation overrides', () => {
  it('switches complete resources and keeps preferences aligned', async () => {
    const store = await import('./i18n');
    await store.setLocale('es_ES');
    await nextTick();
    expect(store.useI18n().t('common.save')).toBe(spanish.common.save);
    expect(document.documentElement.lang).toBe('es');
    expect(localStorage.getItem('locale')).toBe('es_ES');
    expect(document.cookie).toContain('locale=es_ES');
    expect(store.useI18n().n(1234)).toBe(new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(1234));
  });
  it('does not let a slower language selection replace the latest selection', async () => {
    const store = await import('./i18n');
    const slow = deferred<void>(); fixtures.delays.ru_RU = slow.promise;
    const previous = store.setLocale('ru_RU');
    await store.setLocale('es_ES');
    slow.resolve(); await previous;
    expect(store.i18nPlugin.global.locale.value).toBe('es_ES');
  });
  it('does not commit failed resource loading and allows retry', async () => {
    const store = await import('./i18n');
    fixtures.load.mockRejectedValueOnce(new Error('offline'));
    await expect(store.setLocale('ru_RU')).rejects.toThrow('offline');
    expect(store.i18nPlugin.global.locale.value).toBe('zh_CN');
    await store.setLocale('ru_RU');
    expect(store.useI18n().t('common.save')).toBe(russian.common.save);
  });
  it('does not reset overrides when preparing an installed language', async () => {
    const store = await import('./i18n');
    vi.mocked(fetch).mockResolvedValueOnce(response('保存覆盖'));
    await store.reloadTranslations('zh_CN');
    await store.prepareLocale('zh_CN');
    expect(store.useI18n().t('common.save')).toBe('保存覆盖');
    expect(store.baseMessages.zh_CN).toEqual(chinese);
  });
  it('ignores an older override response for the same language', async () => {
    const store = await import('./i18n');
    const stale = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => stale.promise).mockResolvedValueOnce(response('最新保存'));
    const first = store.reloadTranslations('zh_CN');
    const latest = store.reloadTranslations('zh_CN');
    await latest; stale.resolve(response('过期保存')); await first;
    expect(store.useI18n().t('common.save')).toBe('最新保存');
  });
  it('rejects malformed override payload without replacing the locale bundle', async () => {
    const store = await import('./i18n');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ key: 'missing.key', value: 'Broken' }] })));
    await expect(store.reloadTranslations('zh_CN')).rejects.toThrow('Invalid translation override');
    expect(store.useI18n().t('common.save')).toBe(chinese.common.save);
  });
});
