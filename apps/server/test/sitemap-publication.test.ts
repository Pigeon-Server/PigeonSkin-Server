import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import type { Bindings } from '../src/core/env.ts';
import { runMigrations } from './setup.ts';
import { publishSitemap, serveSitemap } from '../src/services/sitemap-publication.ts';

beforeEach(runMigrations);
const bindings = () => ({ ...env, OFFICIAL_CATALOG_ENABLED: 'false' }) as Bindings;

describe('R2 sitemap 发布', () => {
  it('首次生成后，索引、分片和 robots 的反复访问不读 D1', async () => {
    const source = bindings();
    expect(await publishSitemap(source)).toBe(true);
    const prepare = vi.fn(() => { throw new Error('D1 must not be read'); });
    const reader = { ...source, DB: { prepare } } as unknown as Bindings;
    for (let repeat = 0; repeat < 3; repeat++) for (const path of ['/sitemap.xml', '/sitemap-1.xml', '/robots.txt']) {
      const result = await serveSitemap(new Request(`https://local.example${path}`), reader, createExecutionContext());
      expect(result.status).toBe(200);
      expect((await result.text()).length).toBeGreaterThan(0);
      const head = await serveSitemap(new Request(`https://local.example${path}`, { method: 'HEAD' }), reader, createExecutionContext());
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe(result.headers.get('content-type'));
      expect(await head.text()).toBe('');
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('部署域名变化后发布新地址，未变化的检查更新刷新时间', async () => {
    const source = { ...bindings(), APP_URL: 'https://first.example' };
    await publishSitemap(source);
    const before = await (await env.BUCKET.get('seo/sitemap/manifest.json'))!.json<{ builtAt: number; checkedAt: number }>();
    const now = vi.spyOn(Date, 'now').mockReturnValue(before.checkedAt + 3_600_001);
    try {
      await publishSitemap(source);
      const checked = await (await env.BUCKET.get('seo/sitemap/manifest.json'))!.json<{ builtAt: number; checkedAt: number }>();
      expect(checked.builtAt).toBe(before.builtAt);
      expect(checked.checkedAt).toBeGreaterThan(before.checkedAt);
      await publishSitemap({ ...source, APP_URL: 'https://second.example' });
      const response = await serveSitemap(new Request('https://second.example/sitemap.xml'), source, createExecutionContext());
      const body = await response.text();
      expect(body).toContain('https://second.example/');
      expect(body).not.toContain('https://first.example/');
    } finally { now.mockRestore(); }
  });

  it('R2 正文未完整写入时保留已发布清单', async () => {
    const source = bindings();
    await publishSitemap(source);
    const before = await (await env.BUCKET.get('seo/sitemap/manifest.json'))!.text();
    await env.DB.prepare("UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap'").run();
    const bucket = new Proxy(env.BUCKET, { get(target, name) {
      if (name === 'put') return async () => { throw new Error('R2 unavailable'); };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(publishSitemap({ ...source, BUCKET: bucket })).rejects.toThrow('R2 unavailable');
    expect(await (await env.BUCKET.get('seo/sitemap/manifest.json'))!.text()).toBe(before);
  });

  it('仅手册变化时复用 R2 材质目录，不重新扫描材质表', async () => {
    const source = bindings();
    await publishSitemap(source);
    await env.DB.prepare("UPDATE public_cache_versions SET version=version+1 WHERE scope='manual'").run();
    const prepare = env.DB.prepare.bind(env.DB);
    const queries: string[] = [];
    const database = new Proxy(env.DB, { get(target, name) {
      if (name === 'prepare') return (query: string) => { queries.push(query); return prepare(query); };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await publishSitemap({ ...source, DB: database });
    expect(queries.filter(query => /\bfrom\s+"?textures"?/i.test(query))).toHaveLength(0);
  });

  it('收藏更新不改变 sitemap 版本，改为私密后重建移除 URL', async () => {
    const source = bindings();
    const texture = await env.DB.prepare("INSERT INTO textures(hash,kind,name,size_bytes,width,height,visibility,created_at,updated_at) VALUES(?,'skin','Local',1,64,64,'public',0,0) RETURNING id").bind('a'.repeat(64)).first<{ id: number }>();
    await publishSitemap(source);
    const revision = await env.DB.prepare("SELECT version FROM public_cache_versions WHERE scope='sitemap'").first();
    await env.DB.prepare('UPDATE textures SET likes=likes+1 WHERE id=?').bind(texture!.id).run();
    expect(await env.DB.prepare("SELECT version FROM public_cache_versions WHERE scope='sitemap'").first()).toEqual(revision);
    const previous = await serveSitemap(new Request('https://local.example/sitemap.xml'), source, createExecutionContext());
    expect(await previous.text()).toContain(`/skinlib/${texture!.id}`);
    await env.DB.prepare("UPDATE textures SET visibility='private' WHERE id=?").bind(texture!.id).run();
    await publishSitemap(source);
    const updated = await serveSitemap(new Request('https://local.example/sitemap.xml'), source, createExecutionContext());
    expect(await updated.text()).not.toContain(`/skinlib/${texture!.id}</loc>`);
  });
});
