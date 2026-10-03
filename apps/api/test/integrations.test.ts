import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations, makeAdmin } from './setup.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';

beforeAll(runMigrations);
const password = 'integration-tests-9';
async function account(name: string, admin = false) {
  const registered = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, playerName: name.slice(0, 16), password }),
  });
  expect(registered.status).toBe(201);
  const { id } = await registered.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const logged = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: `${name}@example.com`, password }),
  });
  return { id, cookie: logged.headers.get('set-cookie')!.split(';')[0]! };
}
function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function configuredFetch(path: string, cookie: string) {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(`https://x${path}`, { headers: { cookie } }),
    {
      ...env,
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'secret-must-never-be-returned',
    } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
afterEach(() => {
  fetchMock.deactivate();
});

describe('built-in feature UI contracts', () => {
  it('renders the real broadcast email preview only for administrators', async () => {
    const user = await account('mail_preview_user');
    expect((await request('/api/v1/admin/notifications/email-preview', user.cookie, 'POST', { title: 'Notice', content: '<script>bad()</script>', locale: 'en' })).status).toBe(403);
    const admin = await account('mail_preview_admin', true);
    const response = await request('/api/v1/admin/notifications/email-preview', admin.cookie, 'POST', { title: 'Notice', content: '<script>bad()</script>', locale: 'en' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const preview = await response.json<{ subject: string; html: string; text: string }>();
    expect(preview.subject).toBe('Notice');
    expect(preview.html).not.toContain('<script>');
    expect(preview.html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(preview.text).toContain('<script>bad()</script>');
  });
  it('reports credential readiness and callbacks without exposing credentials', async () => {
    const admin = await account('config_admin', true);
    const user = await account('config_user');
    expect((await request('/api/v1/admin/restricted-email-domains/allow', admin.cookie, 'PUT', { domains: ['invalid@domain'] })).status).toBe(422);
    expect((await configuredFetch('/api/v1/admin/integrations', user.cookie)).status).toBe(403);
    const response = await configuredFetch('/api/v1/admin/integrations', admin.cookie);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('secret-must-never-be-returned');
    expect(text).not.toContain('test-client-id');
    expect(JSON.parse(text).providers[0]).toMatchObject({
      id: 'github',
      configured: true,
      clientId: true,
      clientSecret: true,
    });
    const providers = await configuredFetch('/api/v1/oauth/providers', '');
    expect((await providers.json<{ providers: { id: string }[] }>()).providers).toContainEqual({
      id: 'github',
      displayName: 'GitHub',
    });
  });
  it('stores upload descriptions and rejects excessive text before charging or creating a texture', async () => {
    const admin = await account('description_admin', true);
    const user = await account('description_user');
    expect(
      (
        await request('/api/v1/admin/settings', admin.cookie, 'PATCH', {
          settings: [{ key: 'textures_description_limit', value: 12 }],
        })
      ).status,
    ).toBe(200);
    function form(description: string) {
      const body = new FormData();
      body.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
      body.set('name', 'Description texture');
      body.set('description', description);
      return body;
    }
    const rejected = await SELF.fetch('https://x/api/v1/textures', {
      method: 'POST',
      headers: { cookie: user.cookie },
      body: form('This text is too long'),
    });
    expect(rejected.status).toBe(422);
    const score = await (await request('/api/v1/me/score', user.cookie)).json<{ score: number }>();
    expect(score.score).toBe(1000);
    const uploaded = await SELF.fetch('https://x/api/v1/textures', {
      method: 'POST',
      headers: { cookie: user.cookie },
      body: form('**Skin**'),
    });
    expect(uploaded.status).toBe(201);
    const texture = await uploaded.json<{ id: number }>();
    const description = await request(`/api/v1/textures/${texture.id}/description`, user.cookie);
    expect((await description.json<{ description: string }>()).description).toBe('**Skin**');
  });
  it('uses a real RSA public key and prevents invalid key settings from partially saving', async () => {
    const admin = await account('key_admin', true);
    const rejected = await request('/api/v1/admin/settings', admin.cookie, 'PATCH', {
      settings: [
        { key: 'gtag_id', value: 'G-UNSAVED' },
        { key: 'ygg_private_key', value: 'invalid' },
      ],
    });
    expect(rejected.status).toBe(422);
    const unchanged = await (
      await request('/api/v1/admin/settings', admin.cookie)
    ).json<{ values: Record<string, string> }>();
    expect(unchanged.values.gtag_id).not.toBe('G-UNSAVED');
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-512',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const privateBase64 = btoa(
      String.fromCharCode(
        ...new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer),
      ),
    );
    const privatePem = `-----BEGIN PRIVATE KEY-----\n${privateBase64}\n-----END PRIVATE KEY-----`;
    expect(
      (
        await request('/api/v1/admin/settings', admin.cookie, 'PATCH', {
          settings: [{ key: 'ygg_private_key', value: privatePem }],
        })
      ).status,
    ).toBe(200);
    const root = await SELF.fetch('https://x/api/yggdrasil/');
    expect(root.status).toBe(200);
    const metadata = await root.json<{ signaturePublickey: string }>();
    expect(metadata.signaturePublickey).toContain('BEGIN PUBLIC KEY');
    expect(metadata.signaturePublickey).not.toContain(privateBase64);
    const encoded = metadata.signaturePublickey.replace(/-----[^-]+-----|\s+/g, '');
    const publicKey = await crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
      false,
      ['verify'],
    );
    const payload = new TextEncoder().encode('texture signature');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, payload);
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, payload)).toBe(
      true,
    );
    const status = await (
      await request('/api/v1/admin/integrations', admin.cookie)
    ).json<{ signingKey: { valid: boolean; bits: number } }>();
    expect(status.signingKey).toMatchObject({ valid: true, bits: 4096 });
  }, 15000);
  it('enforces the configurable authentication interval and exposes protected log entries', async () => {
    const admin = await account('log_admin', true);
    const user = await account('log_user');
    expect(
      (
        await request('/api/v1/admin/settings', admin.cookie, 'PATCH', {
          settings: [{ key: 'ygg_rate_limit', value: 10000 }],
        })
      ).status,
    ).toBe(200);
    const input = { username: 'log_user@example.com', password };
    expect(
      (await request('/api/yggdrasil/authserver/authenticate', '', 'POST', input)).status,
    ).toBe(200);
    expect(
      (await request('/api/yggdrasil/authserver/authenticate', '', 'POST', input)).status,
    ).toBe(403);
    expect((await request('/api/v1/admin/yggdrasil/logs', user.cookie)).status).toBe(403);
    const logged = await (
      await request('/api/v1/admin/yggdrasil/logs?action=authenticate', admin.cookie)
    ).json<{ items: Array<{ action: string; body: string }> }>();
    expect(logged.items).toContainEqual(
      expect.objectContaining({ action: 'authenticate', body: 'lo***@example.com', userId: user.id }),
    );
    expect(
      (
        await request('/api/v1/admin/settings', admin.cookie, 'PATCH', {
          settings: [{ key: 'ygg_rate_limit', value: 0 }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await request('/api/yggdrasil/authserver/authenticate', '', 'POST', input)).status,
    ).toBe(200);
  });
  it('binds social login to the signed-in user without switching their account', async () => {
    const user = await account('bind_user');
    const authorization = await configuredFetch('/auth/oauth/github', user.cookie);
    const state = new URL(authorization.headers.get('location')!).searchParams.get('state')!;
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get('https://github.com')
      .intercept({ path: '/login/oauth/access_token', method: 'POST' })
      .reply(200, { access_token: 'test-access-token' });
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: '/user', method: 'GET' })
      .reply(200, { id: 1234, email: 'different@example.com', name: 'Provider name' });
    fetchMock.get('https://api.github.com').intercept({ path: '/user/emails', method: 'GET' }).reply(200, [{ email: 'different@example.com', primary: true, verified: true }]);
    const response = await configuredFetch(
      `/auth/oauth/github/callback?code=test-code&state=${state}`,
      `${user.cookie}; ${authorization.headers.get('set-cookie')!.split(';')[0]}`,
    );
    expect(response.headers.get('location')).toBe('/profile?oauth_success=1');
    const bindings = await (
      await request('/api/v1/me/oauth', user.cookie)
    ).json<{ bindings: Array<{ provider: string }> }>();
    expect(bindings.bindings).toContainEqual(expect.objectContaining({ provider: 'github' }));
    const session = await (
      await request('/api/v1/auth/session', user.cookie)
    ).json<{ id: number }>();
    expect(session.id).toBe(user.id);
    fetchMock.assertNoPendingInterceptors();
  });
});
