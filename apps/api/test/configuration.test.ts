import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { runMigrations, makeAdmin } from './setup.ts';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { CONFIGURATION, resolveConfiguration } from '../src/services/configuration.ts';

let baselineCookie = '';
beforeAll(async () => { await runMigrations(); baselineCookie = await admin(); });
beforeEach(async () => {
  const keys = [...Object.keys(CONFIGURATION), 'home_background_url', 'home_background_tablet_url', 'home_background_mobile_url', 'login_background_url', 'login_background_tablet_url', 'login_background_mobile_url'];
  await env.DB.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).run();
  expect((await settings(baselineCookie, { site_name: 'Pigeon Skin Server' })).status).toBe(200);
});
async function admin(role = 'super_admin') {
  const email = `config-${crypto.randomUUID()}@example.com`, password = 'configuration-9-pass';
  const registered = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: `Cfg${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }) });
  expect(registered.status).toBe(201);
  const { id } = await registered.json<{ id: number }>();
  await makeAdmin(id);
  if (role !== 'super_admin') await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  const logged = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  return logged.headers.get('set-cookie')!.split(';')[0]!;
}
async function settings(cookie: string, entries: Record<string, string>) {
  return SELF.fetch('https://x/api/v1/admin/settings', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ settings: Object.entries(entries).map(([key, value]) => ({ key, value })) }) });
}
async function legacyFetch(path: string, cookie = '') {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(new Request(`https://x${path}`, { headers: { cookie } }), { ...env, GITHUB_CLIENT_ID: 'legacy-client', GITHUB_CLIENT_SECRET: 'legacy-secret', MICROSOFT_CLIENT_ID: 'legacy-microsoft', MICROSOFT_CLIENT_SECRET: 'legacy-microsoft-secret' } as Bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
describe('Web configuration', () => {
  it('stores responsive home and login image variants and publishes them', async () => {
    const cookie = await admin();
    const values = {
      home_background_url: 'https://cdn.example/home-desktop.webp',
      home_background_tablet_url: 'https://cdn.example/home-tablet.webp',
      home_background_mobile_url: 'https://cdn.example/home-mobile.webp',
      login_background_url: 'https://cdn.example/login-desktop.webp',
      login_background_tablet_url: 'https://cdn.example/login-tablet.webp',
      login_background_mobile_url: 'https://cdn.example/login-mobile.webp',
    };
    expect((await settings(cookie, values)).status).toBe(200);
    expect(await (await SELF.fetch('https://x/api/v1/settings/public')).json()).toMatchObject(values);
  });
  it('stores global filing numbers, publishes them, and supports clearing each field', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { icp_beian: ' 京ICP备12345678号-1 ', public_security_beian: '京公网安备11010102000001号' })).status).toBe(200);
    for (const locale of ['zh_CN', 'en']) {
      const response = await SELF.fetch(`https://x/api/v1/settings/public?locale=${locale}`);
      expect(await response.json()).toMatchObject({ icp_beian: '京ICP备12345678号-1', public_security_beian: '京公网安备11010102000001号' });
    }
    expect((await settings(cookie, { icp_beian: '' })).status).toBe(200);
    expect(await (await SELF.fetch('https://x/api/v1/settings/public')).json()).toMatchObject({ icp_beian: '', public_security_beian: '京公网安备11010102000001号' });
    expect((await settings(cookie, { public_security_beian: '' })).status).toBe(200);
    expect(await (await SELF.fetch('https://x/api/v1/settings/public')).json()).toMatchObject({ public_security_beian: '' });
  });
  it('rejects malformed filing numbers and HTML without overwriting saved values', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { public_security_beian: '京公网安备11010102000001号' })).status).toBe(200);
    for (const value of ['1101010200000', '110101020000001', '<img src=x>', 'javascript:alert(1)']) {
      expect((await settings(cookie, { public_security_beian: value })).status).toBe(422);
    }
    expect((await settings(cookie, { icp_beian: '<script>alert(1)</script>' })).status).toBe(422);
    expect(await (await SELF.fetch('https://x/api/v1/settings/public')).json()).toMatchObject({ public_security_beian: '京公网安备11010102000001号' });
  });
  it('edits provider credentials through the Web API and returns only a secret placeholder', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { github_client_id: 'web-client', github_client_secret: 'web-secret' })).status).toBe(200);
    const response = await SELF.fetch('https://x/api/v1/admin/settings', { headers: { cookie } });
    const body = await response.json<{ values: Record<string, string>; specs: Record<string, { secret?: boolean }> }>();
    expect(body.values.github_client_id).toBe('web-client'); expect(body.values.github_client_secret).toBe('********'); expect(body.specs.github_client_secret!.secret).toBe(true);
    expect(JSON.stringify(body)).not.toContain('web-secret');
    const providers = await (await SELF.fetch('https://x/api/v1/oauth/providers')).json<{ providers: Array<{ id: string }> }>();
    expect(providers.providers.some(p => p.id === 'github')).toBe(true);
    expect((await settings(cookie, { github_client_secret: '********' })).status).toBe(200);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'github_client_secret' AND locale = ''").first<{ value: string }>())!.value).toBe('web-secret');
  });
  it('preserves legacy credentials until explicitly replaced or cleared in the UI', async () => {
    const cookie = await admin();
    const before = await (await legacyFetch('/api/v1/admin/settings', cookie)).json<{ values: Record<string, string> }>();
    expect(before.values.github_client_id).toBe('legacy-client'); expect(before.values.github_client_secret).toBe('********');
    expect((await settings(cookie, { github_client_secret: '' })).status).toBe(200);
    const provider = await (await legacyFetch('/api/v1/oauth/providers')).json<{ providers: Array<{ id: string }> }>();
    expect(provider.providers.some(p => p.id === 'github')).toBe(false);
  });
  it('rejects credential changes and hides them from ordinary administrators', async () => {
    const owner = await admin();
    await settings(owner, { resend_api_key: 'private-mail-key' });
    const cookie = await admin('admin');
    expect((await settings(cookie, { resend_api_key: 'other-key' })).status).toBe(403);
    const read = await (await SELF.fetch('https://x/api/v1/admin/settings', { headers: { cookie } })).json<{ values: Record<string, string> }>();
    expect(read.values.resend_api_key).toBeUndefined();
    const pub = await (await SELF.fetch('https://x/api/v1/settings/public')).text(); expect(pub).not.toContain('private-mail-key'); expect(pub).not.toContain('resend_api_key');
  });
  it('uses the configured canonical URL in protocol metadata', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { site_url: 'https://skin.example.com', mail_from: 'Skin Server <mail@example.com>' })).status).toBe(200);
    const metadata = await (await SELF.fetch('https://x/api/yggdrasil')).json<{ meta: { links: { homepage: string } } }>(); expect(metadata.meta.links.homepage).toBe('https://skin.example.com');
    const state = await (await SELF.fetch('https://x/api/v1/admin/integrations', { headers: { cookie } })).json<{ apiRoot: string }>(); expect(state.apiRoot).toBe('https://skin.example.com/api/yggdrasil');
    expect((await settings(cookie, { site_url: 'javascript:alert(1)' })).status).toBe(422);
    expect((await settings(cookie, { mail_from: 'bad\r\nInjected' })).status).toBe(422);
    // mail_from 允许纯显示名与纯邮箱;含尖括号必须是完整地址形式
    expect((await settings(cookie, { mail_from: 'foo<bar' })).status).toBe(422);
    expect((await settings(cookie, { mail_from: 'noreply@example.com' })).status).toBe(200);
    // resend 驱动没有账号可供补全,纯显示名无法投递,写入时拦下
    expect((await settings(cookie, { mail_from: 'Pigeon Skin' })).status).toBe(422);
    // 切到 smtp 驱动后同一值合法
    expect((await settings(cookie, { mail_driver: 'smtp' })).status).toBe(422); // smtp 缺 host
    expect((await settings(cookie, { mail_driver: 'smtp', smtp_host: 'mail.example.test', mail_from: 'Pigeon Skin' })).status).toBe(200);
  });
  it('configures the captcha driver and business switches without exposing the secret', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { captcha_driver: 'turnstile' })).status).toBe(422);
    expect((await settings(cookie, { captcha_driver: 'turnstile', captcha_site_key: 'public-site-key', captcha_secret: 'private-secret', rate_limit_enabled: 'false' })).status).toBe(200);
    const pub = await (await SELF.fetch('https://x/api/v1/settings/public')).json<{ captcha_driver: string; captcha_site_key: string }>();
    expect(pub.captcha_driver).toBe('turnstile'); expect(pub.captcha_site_key).toBe('public-site-key'); expect(JSON.stringify(pub)).not.toContain('private-secret');
    const bindings = await resolveConfiguration(env as Bindings);
    expect(bindings.RATE_LIMIT_ENABLED).toBe('false'); expect(bindings.DERIVATIVES_ENABLED).toBe('true');
    expect(bindings.CAPTCHA_DRIVER).toBe('turnstile'); expect(bindings.CAPTCHA_SECRET).toBe('private-secret');
  });
  it('rejects aliyun captcha without the access key and accepts it with one', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { captcha_driver: 'aliyun', captcha_site_key: 'scene-id', captcha_secret: 'access-key-secret' })).status).toBe(422);
    expect((await settings(cookie, { captcha_driver: 'aliyun', captcha_site_key: 'scene-id', captcha_secret: 'access-key-secret', aliyun_captcha_access_key_id: 'AKID' })).status).toBe(200);
    expect((await settings(cookie, { captcha_driver: '' })).status).toBe(200);
  });
  it('accepts the image captcha driver without credentials and serves challenges anonymously', async () => {
    const cookie = await admin();
    expect((await settings(cookie, { captcha_driver: 'image' })).status).toBe(200);
    const pub = await (await SELF.fetch('https://x/api/v1/settings/public')).json<{ captcha_driver: string; captcha_site_key: string }>();
    expect(pub.captcha_driver).toBe('image');
    expect(pub.captcha_site_key).toBe('');
    const challenge = await SELF.fetch('https://x/api/v1/auth/captcha/challenge');
    expect(challenge.status).toBe(200);
    const body = await challenge.json<{ challengeId: string; svg: string; ttlSeconds: number }>();
    expect(body.challengeId).toContain('.');
    expect(body.svg).toContain('<svg');
    // 驱动关闭时出题端点返回空题面
    await settings(cookie, { captcha_driver: '' });
    const off = await (await SELF.fetch('https://x/api/v1/auth/captcha/challenge')).json<{ challengeId: string }>();
    expect(off.challengeId).toBe('');
  });
  it('keeps Microsoft fallback for verification while rejecting mixed application credentials', async () => {
    const cookie = await admin();
    const initial = await (await legacyFetch('/api/v1/admin/integrations', cookie)).json<{ mojang: { configured: boolean; usesMicrosoft: boolean } }>(); expect(initial.mojang).toMatchObject({ configured: true, usesMicrosoft: true });
    await settings(cookie, { mojang_client_id: 'independent' });
    const partial = await (await legacyFetch('/api/v1/admin/integrations', cookie)).json<typeof initial>(); expect(partial.mojang.configured).toBe(false);
    await settings(cookie, { mojang_client_secret: 'independent-secret' });
    const configured = await (await legacyFetch('/api/v1/admin/integrations', cookie)).json<typeof initial>(); expect(configured.mojang).toMatchObject({ configured: true, usesMicrosoft: false });
  });
});
