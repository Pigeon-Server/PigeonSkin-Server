export const SITEMAP_VERSION_KEY = 'https://sitemap.internal/__version__';

export async function bumpSitemap(): Promise<void> {
  try {
    const cache = caches.default;
    const hit = await cache.match(SITEMAP_VERSION_KEY);
    const current = hit ? Number(await hit.text()) || 1 : 1;
    await cache.put(SITEMAP_VERSION_KEY, new Response(String(current + 1), {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    }));
  } catch (error) { console.error('sitemap bump 失败', error); }
}
