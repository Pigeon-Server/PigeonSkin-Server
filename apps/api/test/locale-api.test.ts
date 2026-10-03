import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOCALES } from '@pigeon-skin/shared/locales';
import { makeAdmin, runMigrations } from './setup.ts';

beforeAll(runMigrations);
async function account(admin = false) {
  const name = 'L' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${name}@example.com`, password: 'locale-preferences-test', playerName: name }) });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
function request(path: string, cookie: string, method = 'GET', json?: unknown) {
  return SELF.fetch(`https://x/api/v1${path}`, { method, headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}
describe('six-language preferences and overrides', () => {
  it('saves each supported language and restores it in the session', async () => {
    const cookie = await account();
    for (const locale of LOCALES) {
      expect((await request('/me/preferences', cookie, 'PATCH', { locale })).status).toBe(200);
      const session = await (await request('/auth/session', cookie)).json<{ locale: string }>();
      expect(session.locale).toBe(locale);
    }
    expect((await request('/me/preferences', cookie, 'PATCH', { locale: 'fr_FR' })).status).toBe(422);
  });
  it('keeps translation overrides isolated across all six languages', async () => {
    const cookie = await account(true);
    for (const locale of LOCALES) {
      expect((await request('/admin/translations', cookie, 'PUT', { locale, key: 'common.save', value: `save-${locale}` })).status).toBe(200);
      const data = await (await request(`/translations?locale=${locale}`, '')).json<{ items: Array<{ key: string; value: string }> }>();
      expect(data.items).toContainEqual({ key: 'common.save', value: `save-${locale}` });
    }
    expect((await request('/translations?locale=fr_FR', '')).status).toBe(422);
  });
  it('rejects unknown keys, malformed syntax and missing parameters', async () => {
    const cookie = await account(true);
    for (const input of [
      { key: 'unknown.message', value: 'Unknown' },
      { key: 'mail.security_body', value: 'Missing code' },
      { key: 'common.save', value: 'Invalid {name' },
      { key: 'security.title', value: 'Extra {name}' },
    ]) expect((await request('/admin/translations', cookie, 'PUT', { locale: 'en', ...input })).status, input.key).toBe(422);
    expect((await request('/admin/translations', cookie, 'PUT', { locale: 'en', key: 'mail.security_body', value: 'Code :code' })).status).toBe(200);
    const data = await (await request('/translations?locale=en', '')).json<{ items: Array<{ key: string; value: string }> }>();
    expect(data.items).toContainEqual({ key: 'mail.security_body', value: 'Code {code}' });
  });
});
