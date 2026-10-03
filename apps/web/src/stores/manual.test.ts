import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@pigeon-skin/shared/locales';
import type { ManualDocument } from '@pigeon-skin/shared/manual';
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
const locale = ref<Locale>('ja_JP');
vi.mock('@/stores/i18n', () => ({ i18nPlugin: { global: { locale, t: (key: string) => key } } }));
vi.mock('@/stores/site', () => ({ useSiteSettings: () => ({ get: () => '' }) }));
vi.mock('@/content/manual', () => ({ manualContent: (slug: string, locale: Locale) => `${locale}:${slug}` }));
vi.mock('@/api', () => ({ manualApi: { list }, ApiError: class extends Error { code = 'error'; } }));
beforeEach(() => { vi.resetModules(); list.mockReset(); locale.value = 'ja_JP'; });
const document = (locale: Locale, content: string): ManualDocument => ({ slug: 'yggdrasil', locale, title: content, description: '', content, updatedAt: 19, group: 'Guides' });

describe('manual language snapshots', () => {
  it('keeps untranslated built-in titles in the target language even when the editor lists other translations', async () => {
    const { useManualStore } = await import('./manual');
    const store = useManualStore();
    const japanese = document('ja_JP', '日本語のタイトル');
    list.mockResolvedValue({ siteUrl: 'https://skin.example', items: [japanese], overrides: [japanese] });
    await store.fetch();
    expect(store.pagesFor('en', true).find(page => page.slug === 'yggdrasil')?.title).toBe('manual.pages.yggdrasil.title');
  });
  it('does not replace the selected language when another language request completes later', async () => {
    const { useManualStore } = await import('./manual');
    const store = useManualStore();
    let japanese!: (value: unknown) => void;
    let english!: (value: unknown) => void;
    list.mockImplementation((language: Locale) => new Promise(resolve => { if (language === 'ja_JP') japanese = resolve; else english = resolve; }));
    const ja = store.fetch();
    locale.value = 'en';
    const en = store.fetch();
    const englishDocument = document('en', 'English');
    english({ siteUrl: 'https://skin.example', items: [englishDocument], overrides: [englishDocument] });
    await en;
    const japaneseDocument = document('ja_JP', '日本語');
    japanese({ siteUrl: 'https://skin.example', items: [japaneseDocument], overrides: [japaneseDocument] });
    await ja;
    expect(store.documents.value[0]?.content).toBe('English');
    expect(store.documentsFor('ja_JP')[0]?.content).toBe('日本語');
    store.update(document('ja_JP', '日本語更新'));
    expect(store.documents.value[0]?.content).toBe('English');
    expect(store.pagesFor('en', true).find(page => page.slug === 'yggdrasil')?.title).toBe('English');
  });
  it('keeps English fallback separate from the current language override', async () => {
    const { useManualStore } = await import('./manual');
    const store = useManualStore();
    list.mockResolvedValue({ siteUrl: 'https://skin.example', items: [document('en', 'English')], overrides: [] });
    await store.fetch();
    expect(store.rawContent('yggdrasil')).toBe('English');
    expect(store.overridesFor('ja_JP')).toEqual([]);
    store.update(document('ja_JP', '日本語'));
    expect(store.rawContent('yggdrasil')).toBe('日本語');
    expect(store.overridesFor('ja_JP')).toHaveLength(1);
    store.remove('yggdrasil', 'ja_JP');
    expect(store.rawContent('yggdrasil')).toBe('English');
    expect(store.overridesFor('ja_JP')).toEqual([]);
  });
});
