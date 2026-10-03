const cache = new Map<string, string>();
export function cachedTexturePreview(key: string) { return cache.get(key); }
export function cacheTexturePreview(key: string, value: string) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > 128) cache.delete(cache.keys().next().value!);
}
