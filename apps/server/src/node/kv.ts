export class CacheKV {
  async get<T = string>(key: string, type: 'text' | 'json' | 'arrayBuffer' = 'text'): Promise<T | null> {
    const response = await caches.default.match(`https://public-kv.internal/${encodeURIComponent(key)}`);
    if (!response) return null;
    const expires = Number(response.headers.get('x-kv-expires'));
    if (expires && expires <= Date.now()) { await this.delete(key); return null; }
    return (type === 'json' ? await response.json() : type === 'arrayBuffer' ? await response.arrayBuffer() : await response.text()) as T;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    const expires = options?.expiration ? options.expiration * 1000 : options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0;
    await caches.default.put(`https://public-kv.internal/${encodeURIComponent(key)}`, new Response(value, { headers: { 'cache-control': 'public, max-age=31536000', 'x-kv-expires': String(expires) } }));
  }

  async delete(key: string): Promise<void> {
    await caches.default.delete(`https://public-kv.internal/${encodeURIComponent(key)}`);
  }
}
