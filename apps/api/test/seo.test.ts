import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './setup.ts';
import { createApp } from '../src/app.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { renderSearchContent } from '../src/services/seo.ts';
import type { Bindings } from '../src/env.ts';
import { bumpSitemap } from '../src/services/sitemap-cache.ts';

beforeAll(runMigrations);

const assets = {
  fetch: async (request: Request | URL | string) => {
    const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
    if (path === '/manual-content.json') return Response.json({ welcome: '欢迎阅读用户手册。', 'customskinloader': '## 配置游戏\n\n下载配置后加载皮肤。\n\n[新手指引](/manual/quick-start)' });
    if (path.startsWith('/assets/')) return new Response('asset', { headers: { 'content-type': 'text/javascript' } });
    return new Response('<!doctype html><html lang="zh-CN"><head><title>Pigeon Skin Server</title></head><body><div id="app"></div><script src="/assets/app.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
  },
} as unknown as Fetcher;

async function request(path: string) {
  invalidateSettingsCache();
  const context = createExecutionContext();
  const response = await createApp().fetch(new Request(`https://skin.example${path}`), { ...env, ASSETS: assets } as Bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

async function texture(visibility: string, name: string) {
  const hash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
  const result = await env.DB.prepare("INSERT INTO textures(hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at) VALUES (?, 'skin', 'default', ?, 100, ?, 64, 64, 1700000000000, 1700000000000) RETURNING id").bind(hash, name, visibility).first<{ id: number }>();
  return result!.id;
}

describe('公开 HTML 与搜索元数据', () => {
  it('按语言读取自定义手册正文，sitemap 收录日语专属页面', async () => {
    const slug = `locale-page-${Date.now()}`;
    await env.DB.prepare("INSERT INTO manual_documents(slug, locale, value, updated_at) VALUES (?, 'ja_JP', ?, 1700000000000)").bind(slug, JSON.stringify({ title: '日本語の手冊', description: '日本語の説明', content: '## 手順\n\n日本語の本文', group: 'Guides' })).run();
    const response = await request(`/manual/${slug}?lang=ja_JP`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('日本語の本文');
    expect(html).toContain('hreflang="ja"');
    expect(html).not.toContain('hreflang="en"');
    expect((await request(`/manual/${slug}?lang=en`)).status).toBe(404);
    await bumpSitemap();
    const sitemap = await (await request('/sitemap.xml')).text();
    expect(sitemap).toContain(`/manual/${slug}?lang=ja_JP`);
  });
  it('首页无需 JavaScript 即可读取正文与公开材质链接', async () => {
    const id = await texture('public', '公开皮肤');
    const response = await request('/');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`<a href="/skinlib/${id}">公开皮肤</a>`);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('Minecraft 皮肤与披风');
    expect(html).toContain('/manual/quick-start');
  });
  it('公开详情具有独立标题和真实结构化数据，私有详情不泄露正文', async () => {
    const publicId = await texture('public', '创作 <测试>');
    const privateId = await texture('private', '私有内容不得泄露');
    const response = await request(`/skinlib/${publicId}`);
    const html = await response.text();
    expect(html).toContain('创作 &lt;测试&gt;');
    expect(html).toContain('CreativeWork');
    expect(html).toContain('og:image');
    const privateResponse = await request(`/skinlib/${privateId}`);
    expect(privateResponse.headers.get('x-robots-tag')).toContain('noindex');
    expect(await privateResponse.text()).not.toContain('私有内容不得泄露');
  });
  it('手册正文与内链直接出现在 HTML，新增手册进入 sitemap', async () => {
    const html = await (await request('/manual/customskinloader')).text();
    expect(html).toContain('<h2 id="section-1">配置游戏</h2>');
    expect(html).toContain('下载配置后加载皮肤');
    expect(html).toContain('TechArticle');
    const slug = `seo-${Date.now()}`;
    await env.DB.prepare("INSERT INTO manual_documents(slug, locale, value, updated_at) VALUES (?, '', ?, ?)").bind(slug, JSON.stringify({ title: '服务器指南', description: '连接指南', content: '## 接入\n\n{{site_url}}', group: '帮助' }), 1700000000000).run();
    await bumpSitemap();
    const page = await (await request(`/manual/${slug}`)).text();
    expect(page).toContain('服务器指南');
    const sitemap = await (await request('/sitemap.xml')).text();
    expect(sitemap).toContain(`/manual/${slug}`);
    expect(sitemap).toContain('/manual/customskinloader');
    expect(sitemap).toContain('<lastmod>2023-11-14</lastmod>');
  });
  it('不存在的页面返回 404，后台和筛选页禁止索引，旧详情地址永久重定向', async () => {
    for (const path of ['/not-a-page', '/manual/unknown-document', '/skinlib/999999999', '/skinlib?page=1.5']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('x-robots-tag')).toContain('noindex');
    }
    for (const path of ['/admin', '/login', '/skinlib?keyword=search']) {
      const response = await request(path);
      expect(response.headers.get('x-robots-tag')).toContain('noindex');
    }
    const redirect = await request('/skinlib/show/123');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/skinlib/123');
  });
  it('robots 允许渲染依赖，静态资源保持原有响应', async () => {
    const robots = await (await request('/robots.txt')).text();
    expect(robots).toContain('Allow: /api/v1/textures');
    expect(robots).toContain('Allow: /api/v1/manual');
    const asset = await request('/assets/app.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript');
    expect(await asset.text()).toBe('asset');
  });
  it('Markdown 的脚本与危险链接不进入公开 HTML', () => {
    const html = renderSearchContent('<script>alert(1)</script>\n\n[点击](javascript:alert)\n\n![图片](data:text/html,bad)\n\n[手册](/manual)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="/manual"');
  });
  it('serves translated metadata and explicit language canonicals with hreflang links', async () => {
    const response = await request('/?lang=ja_JP');
    const html = await response.text();
    expect(response.headers.get('content-language')).toBe('ja');
    expect(html).toContain('lang="ja"');
    expect(html).toContain('lang=ja_JP');
    expect(html).toContain('hreflang="zh-TW"');
    expect(html).toContain('hreflang="x-default"');
    expect(html).not.toContain('Minecraft 皮肤与披风');
  });
});
