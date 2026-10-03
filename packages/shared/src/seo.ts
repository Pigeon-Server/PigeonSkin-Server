export const defaultSiteDescription = '发现 Minecraft 皮肤与披风，管理游戏角色，查阅 CustomSkinLoader 配置与 Yggdrasil 外置登录指南。';

export function canonicalPagePath(path: string): string {
  const normalized = path.replace(/\/+$/, '') || '/';
  return normalized.replace(/^\/skinlib\/show\/(\d+)$/, '/skinlib/$1');
}

export function publicPage(path: string): boolean {
  return ['/', '/skinlib', '/manual'].includes(path) || /^\/skinlib\/[1-9]\d*$/.test(path) || /^\/manual\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
}

export function pageCanonical(origin: string, path: string, search = ''): string {
  const url = new URL(canonicalPagePath(path), origin);
  const parameters = new URLSearchParams(search);
  const page = Number(parameters.get('page'));
  const language = parameters.get('lang');
  if (language && normalizeLocale(language) !== DEFAULT_LOCALE) url.searchParams.set('lang', normalizeLocale(language));
  if (url.pathname === '/skinlib' && Number.isSafeInteger(page) && page > 1) url.searchParams.set('page', String(page));
  return url.href;
}

export function languageAlternates(canonical: string): Array<{ tag: string; href: string }> {
  const url = new URL(canonical);
  url.searchParams.delete('lang');
  return [...LOCALE_OPTIONS.map(option => {
    const parameters = new URLSearchParams(url.search);
    parameters.set('lang', option.value);
    return { tag: option.tag, href: pageCanonical(url.origin, url.pathname, parameters.toString()) };
  }), { tag: 'x-default', href: pageCanonical(url.origin, url.pathname, url.search) }];
}

export function indexablePage(path: string, search = ''): boolean {
  const normalized = canonicalPagePath(path);
  if (!publicPage(normalized)) return false;
  const parameters = new URLSearchParams(search);
  const page = parameters.get('page');
  if (normalized === '/skinlib' && page !== null && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) return false;
  return normalized !== '/skinlib' || ![...parameters.keys()].some(key => ['keyword', 'filter', 'sort', 'uploader', 'mine'].includes(key));
}

export function plainDescription(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export interface PageMetadata {
  locale?: Locale;
  alternateLocales?: readonly Locale[];
  siteName?: string;
  title: string;
  description: string;
  canonical: string;
  indexable: boolean;
  image?: string;
  structuredData?: Record<string, unknown>[];
}
import { DEFAULT_LOCALE, LOCALE_OPTIONS, normalizeLocale, type Locale } from './locale.ts';
