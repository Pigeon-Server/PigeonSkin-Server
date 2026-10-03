import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeAdmin, runMigrations } from './setup.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import type { ManualDocumentInput } from '@pigeon-skin/shared/manual';
beforeAll(runMigrations);
async function account(admin: boolean) {
  const email = `manual-${crypto.randomUUID()}@example.com`, password = 'manual-test-password';
  const registered = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: 'M'+crypto.randomUUID().replaceAll('-', '').slice(0, 10) }) });
  expect(registered.status).toBe(201);
  const { id } = await registered.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const logged = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  expect(logged.status).toBe(200);
  return logged.headers.get('set-cookie')!.split(';')[0]!;
}
const document = { title: '客户端接入', description: '本站的外置登录指南', content: '## 配置\n\n`{{site_url}}/api/yggdrasil`', revision: 0 };
function save(cookie: string, body: ManualDocumentInput & { group?: string } = document, slug = 'yggdrasil', locale?: string) {
  return SELF.fetch(`https://x/api/v1/admin/manual/${slug}${locale ? `?locale=${locale}` : ''}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
}
describe('内置用户手册', () => {
  it('分别保存各语言版本，英文回退与目标语言修订号互不混用', async () => {
    const cookie = await account(true);
    const slug = `localized-${Date.now()}`;
    const english = await save(cookie, { ...document, title: 'English manual', content: 'English content' }, slug, 'en');
    expect(english.status).toBe(200);
    const en = await english.json<{ updatedAt: number }>();
    const read = (locale: string) => SELF.fetch(`https://x/api/v1/manual?locale=${locale}`).then(response => response.json<{ items: Array<{ slug: string; locale: string; content: string; updatedAt: number }>; overrides: Array<{ slug: string }> }>());
    const inherited = await read('ja_JP');
    expect(inherited.items.find(item => item.slug === slug)?.locale).toBe('en');
    expect(inherited.overrides.some(item => item.slug === slug)).toBe(false);
    expect((await save(cookie, { ...document, title: '日本語', content: '日本語の内容', revision: en.updatedAt }, slug, 'ja_JP')).status).toBe(409);
    const japanese = await save(cookie, { ...document, title: '日本語', content: '日本語の内容' }, slug, 'ja_JP');
    expect(japanese.status).toBe(200);
    const ja = await japanese.json<{ updatedAt: number }>();
    expect((await read('ja_JP')).items.find(item => item.slug === slug)?.content).toBe('日本語の内容');
    expect((await read('en')).items.find(item => item.slug === slug)?.content).toBe('English content');
    expect((await save(cookie, { ...document, content: 'English update', revision: en.updatedAt }, slug, 'en')).status).toBe(200);
    expect((await read('ja_JP')).items.find(item => item.slug === slug)?.content).toBe('日本語の内容');
    expect((await save(cookie, { ...document, revision: 0 }, slug, 'ja_JP')).status).toBe(409);
    expect((await SELF.fetch(`https://x/api/v1/admin/manual/${slug}?locale=ja_JP&revision=${ja.updatedAt}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
    expect((await read('ja_JP')).items.find(item => item.slug === slug)?.content).toBe('English update');
    expect((await save(cookie, document, slug, 'fr_FR')).status).toBe(422);
  });
  it('只有其他语言的自定义文档不会泄露为中文或英文版本', async () => {
    const cookie = await account(true);
    const slug = `japanese-${Date.now()}`;
    expect((await save(cookie, { ...document, title: '日本語のみ' }, slug, 'ja_JP')).status).toBe(200);
    for (const locale of ['en', 'zh_CN']) {
      const data = await (await SELF.fetch(`https://x/api/v1/manual?locale=${locale}`)).json<{ items: Array<{ slug: string }> }>();
      expect(data.items.some(item => item.slug === slug)).toBe(false);
    }
    const data = await (await SELF.fetch(`https://x/api/v1/manual?locale=ja_JP`)).json<{ items: Array<{ slug: string; availableLocales: string[] }> }>();
    expect(data.items.find(item => item.slug === slug)?.availableLocales).toEqual(['ja_JP']);
  });
  it('公开读取，只有管理员可以保存或恢复', async () => {
    expect((await SELF.fetch('https://x/api/v1/manual')).status).toBe(200);
    expect((await save('')).status).toBe(401);
    const cookie = await account(false);
    expect((await save(cookie)).status).toBe(403);
    expect((await SELF.fetch('https://x/api/v1/admin/manual/yggdrasil?revision=0', { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(403);
  });
  it('保存原始 Markdown，公开返回配置地址，防止覆盖别人的修改，并可恢复内置版本', async () => {
    const cookie = await account(true);
    await env.DB.prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES ('site_url', '', 'https://skin.example.com', 1) ON CONFLICT(key,locale) DO UPDATE SET value=excluded.value").run();
    invalidateSettingsCache();
    const response = await save(cookie);
    expect(response.status).toBe(200);
    const saved = await response.json<{ content: string; updatedAt: number }>();
    expect(saved.content).toBe(document.content);
    const read = await (await SELF.fetch('https://x/api/v1/manual')).json<{ siteUrl: string; items: Array<{ slug: string; title: string }> }>();
    expect(read.siteUrl).toBe('https://skin.example.com');
    expect(read.items.find(page => page.slug === 'yggdrasil')!.title).toBe(document.title);
    expect((await save(cookie)).status).toBe(409);
    expect((await save(cookie, { ...document, content: '更新内容', revision: saved.updatedAt })).status).toBe(200);
    const current = await (await SELF.fetch('https://x/api/v1/manual')).json<{ items: Array<{ slug: string; updatedAt: number }> }>();
    const revision = current.items.find(page => page.slug === 'yggdrasil')!.updatedAt;
    expect((await SELF.fetch(`https://x/api/v1/admin/manual/yggdrasil?revision=${saved.updatedAt}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(409);
    expect((await SELF.fetch(`https://x/api/v1/admin/manual/yggdrasil?revision=${revision}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
    const reset = await (await SELF.fetch('https://x/api/v1/manual')).json<{ items: Array<{ slug: string }> }>();
    expect(reset.items.some(page => page.slug === 'yggdrasil')).toBe(false);
  });
  it('拒绝未知文档以及超长或不合法的输入', async () => {
    const cookie = await account(true);
    expect((await save(cookie, document, 'invalid_slug')).status).toBe(422);
    expect((await save(cookie, { ...document, title: '' })).status).toBe(422);
    expect((await save(cookie, { ...document, content: 'a'.repeat(200001) })).status).toBe(422);
    expect((await save(cookie, { ...document, revision: -1 })).status).toBe(422);
  });
  it('允许新增分类和文档页，新增页可公开读取并删除', async () => {
    const cookie = await account(true);
    const response = await save(cookie, { ...document, group: '服务器接入', title: '连接服务器' }, 'server-connection');
    expect(response.status).toBe(200);
    const saved = await response.json<{ updatedAt: number }>();
    const read = await (await SELF.fetch('https://x/api/v1/manual')).json<{ items: Array<{ slug: string; group: string }> }>();
    expect(read.items.find(page => page.slug === 'server-connection')!.group).toBe('服务器接入');
    expect((await SELF.fetch(`https://x/api/v1/admin/manual/server-connection?revision=${saved.updatedAt}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
    const after = await (await SELF.fetch('https://x/api/v1/manual')).json<{ items: Array<{ slug: string }> }>();
    expect(after.items.some(page => page.slug === 'server-connection')).toBe(false);
  });
});
