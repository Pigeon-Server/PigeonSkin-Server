import { computed, ref } from 'vue';
import { manualPages, localizedManualPages, manualSiteUrl, renderManualContent, resolveManualDocuments, type ManualDocument } from '@pigeon-skin/shared/manual';
import { normalizeLocale, type Locale } from '@pigeon-skin/shared/locales';
import { i18nPlugin } from '@/stores/i18n';
import { manualContent } from '@/content/manual';
import { ApiError, manualApi } from '@/api';
import { useSiteSettings } from '@/stores/site';

interface Snapshot { items: ManualDocument[]; overrides: ManualDocument[] }
const snapshots = ref<Partial<Record<Locale, Snapshot>>>({});
const knownDocuments = ref<ManualDocument[]>([]);
const deletedRevisions = new Map<string, number>();
const errors = ref<Partial<Record<Locale, string>>>({});
const configuredUrl = ref('');
const pending = new Map<Locale, Promise<void>>();
const loadingLocales = ref<Partial<Record<Locale, boolean>>>({});
const currentLocale = computed(() => normalizeLocale(i18nPlugin.global.locale.value));
const documents = computed(() => snapshots.value[currentLocale.value]?.items || []);
const loaded = computed(() => !!snapshots.value[currentLocale.value]);
const loading = computed(() => !!loadingLocales.value[currentLocale.value]);
const error = computed(() => errors.value[currentLocale.value] || '');

export function useManualStore() {
  const site = useSiteSettings();
  const siteUrl = computed(() => manualSiteUrl(configuredUrl.value || site.get('site_url'), location.origin));
  function documentsFor(locale: Locale) { return snapshots.value[locale]?.items || []; }
  function overridesFor(locale: Locale) { return snapshots.value[locale]?.overrides || []; }
  function errorFor(locale: Locale) { return errors.value[locale] || ''; }
  function pagesFor(locale: Locale, includeUntranslated = false) {
    const t = (key: string) => i18nPlugin.global.t(key, {}, { locale });
    const resolved = documentsFor(locale);
    const items = [...resolved];
    if (includeUntranslated) for (const snapshot of Object.values(snapshots.value)) for (const document of snapshot.items) {
      if (!items.some(item => item.slug === document.slug)) items.push(document);
    }
    const builtin = localizedManualPages(t);
    return [...builtin.map(page => {
      const document = resolved.find(item => item.slug === page.slug);
      return { ...page, title: document?.title ?? page.title, description: document?.description ?? page.description, group: document?.group ?? page.group };
    }), ...items.filter(document => !manualPages.some(page => page.slug === document.slug)).map(document => ({ slug: document.slug, title: document.title, description: document.description, group: document.group || t('manual.custom_group') }))];
  }
  function groupsFor(locale: Locale, includeUntranslated = false) {
    const catalog = pagesFor(locale, includeUntranslated);
    return [...new Set(catalog.map(page => page.group))].map(title => ({ title, pages: catalog.filter(page => page.group === title) }));
  }
  const groups = computed(() => groupsFor(currentLocale.value));
  const pages = computed(() => groups.value.flatMap(group => group.pages));
  function rawContent(slug: string, locale = currentLocale.value) { return documentsFor(locale).find(item => item.slug === slug)?.content ?? manualContent(slug, locale); }
  function contentLocale(slug: string) { return documents.value.find(item => item.slug === slug)?.locale || currentLocale.value; }
  function content(slug: string) { return renderManualContent(rawContent(slug), siteUrl.value, site.get('site_name')); }
  function search(query: string) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return pages.value.filter(page => terms.every(term => `${page.title} ${page.description} ${content(page.slug)}`.toLocaleLowerCase().includes(term)));
  }
  async function fetch(force = false, locale = currentLocale.value) {
    if (pending.has(locale)) return pending.get(locale);
    if (snapshots.value[locale] && !force) return;
    loadingLocales.value[locale] = true; errors.value[locale] = '';
    const task = manualApi.list(locale).then(data => {
      const incoming = new Map<string, ManualDocument>();
      for (const item of [...data.items, ...data.overrides]) incoming.set(`${item.locale || 'zh_CN'}:${item.slug}`, item);
      for (const item of knownDocuments.value) if ((item.locale || 'zh_CN') === locale && !data.overrides.some(document => document.slug === item.slug)) deletedRevisions.set(`${locale}:${item.slug}`, item.updatedAt);
      const known = new Map(knownDocuments.value.filter(item => (item.locale || 'zh_CN') !== locale).map(item => [`${item.locale || 'zh_CN'}:${item.slug}`, item]));
      for (const [key, item] of incoming) if (item.updatedAt > (deletedRevisions.get(key) || 0) && item.updatedAt >= (known.get(key)?.updatedAt || 0)) known.set(key, item);
      knownDocuments.value = [...known.values()];
      snapshots.value[locale] = { items: resolveManualDocuments(knownDocuments.value, locale), overrides: data.overrides };
      configuredUrl.value = data.siteUrl;
    }).catch(e => { errors.value[locale] = e instanceof ApiError ? e.code : 'common.network'; }).finally(() => {
      loadingLocales.value[locale] = false; pending.delete(locale);
    });
    pending.set(locale, task);
    await task;
  }
  function modify(document: ManualDocument | undefined, slug: string, locale: Locale) {
    const key = `${locale}:${slug}`;
    if (!document) deletedRevisions.set(key, knownDocuments.value.find(item => item.slug === slug && (item.locale || 'zh_CN') === locale)?.updatedAt || 0);
    const items = knownDocuments.value.filter(item => item.slug !== slug || (item.locale || 'zh_CN') !== locale);
    if (document) { deletedRevisions.delete(key); items.push(document); }
    knownDocuments.value = items;
    for (const key of Object.keys(snapshots.value) as Locale[]) snapshots.value[key] = {
      items: resolveManualDocuments(items, key), overrides: items.filter(item => (item.locale || 'zh_CN') === key),
    };
  }
  function update(document: ManualDocument) { modify(document, document.slug, document.locale || currentLocale.value); }
  function remove(slug: string, locale = currentLocale.value) { modify(undefined, slug, locale); }
  return { documents, pages, groups, siteUrl, loaded, loading, error, fetch, rawContent, content, contentLocale, search, update, remove, documentsFor, overridesFor, pagesFor, groupsFor, errorFor };
}
