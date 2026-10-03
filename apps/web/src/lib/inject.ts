// 全局注入：站点设置驱动的一次性 head/body 注入。
//   • adsense_client_id → pagead 脚本（带 data- 标记，防止重复注入）
//   • gtag_id → gtag snippet
//   • custom_css → <style id="custom-css">
//   • meta_description / meta_keywords / meta_extras → head meta
// 设置可能到达较晚（网络慢），用 watch 等键出现后再注入。
import { watch } from 'vue';
import { useSiteSettings } from '@/stores/site';

const ADSENSE_ID = 'adsense-script';
const GTAG_ID = 'gtag-script';
const CSS_ID = 'custom-css';
const META_EXTRAS_ID = 'meta-extras';

function head(): HTMLElement {
  return document.head;
}

function injectAdsense(clientId: string): void {
  if (document.getElementById(ADSENSE_ID)) return;
  const s = document.createElement('script');
  s.id = ADSENSE_ID;
  s.async = true;
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(clientId)}`;
  s.crossOrigin = 'anonymous';
  head().appendChild(s);
}

function injectGtag(gtagId: string): void {
  if (document.getElementById(GTAG_ID)) return;
  const s = document.createElement('script');
  s.id = GTAG_ID;
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagId)}`;
  head().appendChild(s);
  const inline = document.createElement('script');
  inline.text = [
    `window.dataLayer = window.dataLayer || [];`,
    `function gtag(){dataLayer.push(arguments);}`,
    `gtag('js', new Date());`,
    `gtag('config', ${JSON.stringify(gtagId)});`,
  ].join('\n');
  head().appendChild(inline);
}

function injectCustomCss(css: string): void {
  let style = document.getElementById(CSS_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = CSS_ID;
    head().appendChild(style);
  }
  style.textContent = css;
}

function injectMeta(key: 'description' | 'keywords', content: string): void {
  let el = head().querySelector(`meta[name="${key}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.name = key;
    head().appendChild(el);
  }
  el.content = content;
}

/** meta_extras：管理员自定义的附加 meta 标签片段（一次成型，整体替换） */
function injectMetaExtras(raw: string): void {
  for (const element of head().querySelectorAll('[data-site-meta]')) element.remove();
  if (!raw.trim()) return;
  const parsed = new DOMParser().parseFromString(raw, 'text/html');
  const safeHref = (value: string) => {
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' || url.origin === location.origin ? url.href : '';
    } catch { return ''; }
  };
  for (const source of Array.from(parsed.head.querySelectorAll('meta'))) {
    const name = source.getAttribute('name')?.trim().toLowerCase() || '';
    const property = source.getAttribute('property')?.trim().toLowerCase() || '';
    const content = source.getAttribute('content')?.trim() || '';
    const allowedName = /^(description|keywords|author|application-name|theme-color|robots|google-site-verification|msvalidate\.01|twitter:[a-z0-9:_-]+)$/.test(name);
    const allowedProperty = /^og:[a-z0-9:_-]+$/.test(property);
    if ((!allowedName && !allowedProperty) || !content || content.length > 2048) continue;
    const node = document.createElement('meta');
    node.setAttribute(name ? 'name' : 'property', name || property);
    node.content = content;
    node.setAttribute('data-site-meta', META_EXTRAS_ID);
    head().appendChild(node);
  }
  for (const source of Array.from(parsed.head.querySelectorAll('link'))) {
    const rel = source.getAttribute('rel')?.trim().toLowerCase() || '';
    const href = safeHref(source.getAttribute('href') || '');
    if (!href || !['canonical', 'alternate'].includes(rel)) continue;
    const node = document.createElement('link');
    node.rel = rel; node.href = href;
    if (rel === 'alternate') {
      const lang = source.getAttribute('hreflang');
      const type = source.getAttribute('type');
      if (lang && /^[a-z0-9-]{2,35}$/i.test(lang)) node.hreflang = lang;
      if (type && /^[a-z0-9.+/-]{1,80}$/i.test(type)) node.type = type;
    }
    node.setAttribute('data-site-meta', META_EXTRAS_ID);
    head().appendChild(node);
  }
}

export function startGlobalInjection(): void {
  const customScript = document.createElement('script');
  customScript.src = '/api/v1/site-script.js';
  customScript.defer = true;
  document.head.appendChild(customScript);
  const site = useSiteSettings();
  void site.fetch();

  // 设置到达后（或已缓存时立即）按需注入；值变空则移除已注入内容
  watch(
    site.settings,
    (s) => {
      const adsense = s['adsense_client_id'] ?? '';
      if (adsense) injectAdsense(adsense);

      const gtag = s['gtag_id'] ?? '';
      if (gtag) injectGtag(gtag);

      injectCustomCss(s['custom_css'] ?? '');
      injectMeta('keywords', s['meta_keywords'] ?? '');
      injectMetaExtras(s['meta_extras'] ?? '');
      let icon = head().querySelector('link[data-site-icon]') as HTMLLinkElement | null;
      if (s['favicon_url']) {
        if (!icon) {
          icon = document.createElement('link');
          icon.rel = 'icon';
          icon.setAttribute('data-site-icon', '');
          head().appendChild(icon);
        }
        icon.href = s['favicon_url'];
      } else {
        icon?.remove();
      }
    },
    { immediate: true, deep: false },
  );
}
