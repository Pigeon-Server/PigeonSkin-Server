import { defaultSiteDescription, indexablePage, pageCanonical, languageAlternates, plainDescription, type PageMetadata } from '@pigeon-skin/shared/seo';
import { localeTag, normalizeLocale, DEFAULT_LOCALE } from '@pigeon-skin/shared/locales';
import { i18nPlugin } from '@/stores/i18n';

export function baseMetadata(path: string, search: string, settings: Record<string, string>, title: string): PageMetadata {
  const origin = settings.site_url || location.origin;
  const locale = normalizeLocale(i18nPlugin.global.locale.value);
  const parameters = new URLSearchParams(search);
  if (locale !== DEFAULT_LOCALE) parameters.set('lang', locale); else parameters.delete('lang');
  return {
    locale,
    siteName: settings.site_name || 'Pigeon Skin Server',
    title,
    description: plainDescription(settings.meta_description || settings.site_description || (i18nPlugin.global as { t(key: string): string }).t('seo.description') || defaultSiteDescription),
    canonical: pageCanonical(origin, path, parameters.toString()),
    indexable: indexablePage(path, search),
  };
}

export function applyPageMetadata(metadata: PageMetadata): void {
  document.title = metadata.title;
  function meta(attribute: 'name' | 'property', key: string, value: string) {
    const elements = [...document.head.querySelectorAll<HTMLMetaElement>(`meta[${attribute}="${key}"]`)];
    const element = elements.shift() || document.createElement('meta');
    for (const duplicate of elements) duplicate.remove();
    element.setAttribute(attribute, key);
    element.content = value;
    if (!element.parentNode) document.head.appendChild(element);
  }
  meta('name', 'description', metadata.description);
  meta('name', 'robots', metadata.indexable ? 'index,follow,max-image-preview:large' : 'noindex,follow');
  meta('property', 'og:type', 'website');
  meta('property', 'og:site_name', metadata.siteName || 'Pigeon Skin Server');
  meta('property', 'og:title', metadata.title);
  meta('property', 'og:description', metadata.description);
  meta('property', 'og:url', metadata.canonical);
  meta('name', 'twitter:card', metadata.image ? 'summary_large_image' : 'summary');
  if (metadata.image) meta('property', 'og:image', metadata.image);
  else document.head.querySelector('meta[property="og:image"]')?.remove();
  const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]')];
  const canonical = links.shift() || document.createElement('link');
  for (const duplicate of links) duplicate.remove();
  canonical.rel = 'canonical'; canonical.href = metadata.canonical;
  if (!canonical.parentNode) document.head.appendChild(canonical);
  for (const alternate of document.head.querySelectorAll('link[rel="alternate"][hreflang]')) alternate.remove();
  if (metadata.indexable) for (const alternate of languageAlternates(metadata.canonical)) {
    if (metadata.alternateLocales && !metadata.alternateLocales.some(locale => localeTag(locale) === alternate.tag) && !(alternate.tag === 'x-default' && metadata.alternateLocales.includes(DEFAULT_LOCALE))) continue;
    const link = document.createElement('link');
    link.rel = 'alternate'; link.hreflang = alternate.tag; link.href = alternate.href;
    document.head.appendChild(link);
  }
  document.getElementById('page-structured-data')?.remove();
  if (metadata.indexable) {
    const script = document.createElement('script');
    script.id = 'page-structured-data'; script.type = 'application/ld+json';
    const origin = new URL(metadata.canonical).origin;
    script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', '@id': `${origin}/#website`, name: metadata.siteName || 'Pigeon Skin Server', url: `${origin}/` },
      ...(metadata.structuredData || [{ '@type': 'WebPage', name: metadata.title, description: metadata.description, url: metadata.canonical }]),
    ] });
    document.head.appendChild(script);
  }
}
