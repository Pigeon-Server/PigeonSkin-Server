import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { LOCALES, translate } from '@pigeon-skin/shared/i18n';
import { processBroadcastEmail, renderEmail, type EmailQueueMessage } from '../src/services/email.ts';
import { sendEmail } from '../src/services/email.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { runMigrations } from './setup.ts';

afterEach(() => vi.unstubAllGlobals());

describe('localized email', () => {
  it('resolves database email configuration inside queue-style service calls', async () => {
    await runMigrations();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES('resend_api_key', '', 'stored-resend-key', ?) ON CONFLICT(key, locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(Date.now()),
      env.DB.prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES('mail_from', '', 'Stored <mail@example.test>', ?) ON CONFLICT(key, locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(Date.now()),
      env.DB.prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES('site_url', '', 'https://stored.example.test', ?) ON CONFLICT(key, locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(Date.now()),
    ]);
    invalidateSettingsCache();
    let request: { headers: Headers; body: Record<string, unknown> } | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      request = { headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return new Response(null, { status: 200 });
    });
    try {
      const result = await sendEmail({ DB: env.DB, MAIL_FROM: 'binding@example.test', APP_URL: 'https://binding.example.test' }, {
        kind: 'verify-email', to: 'user@example.test', token: 'token', locale: 'en',
      });
      expect(result).toEqual({ ok: true });
      expect(request?.headers.get('authorization')).toBe('Bearer stored-resend-key');
      expect(request?.body.from).toBe('Stored <mail@example.test>');
      expect(request?.body.html).toContain('https://stored.example.test/verify-email?token=token');
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key IN ('resend_api_key', 'mail_from', 'site_url') AND locale = ''").run();
      invalidateSettingsCache();
    }
  });
  it('uses database overrides with the same Vue literal and interpolation syntax', async () => {
    let payload: { subject: string; text: string } | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body));
      return new Response(null, { status: 200 });
    });
    const env = {
      RESEND_API_KEY: 'test', MAIL_FROM: 'noreply@example.com', APP_URL: 'https://skin.example',
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
        { key: 'mail.security_title', value: "Security {'@'} Skin" },
        { key: 'mail.security_body', value: 'Code {code}; repeat {code}' },
      ] }) }) }) },
    } as unknown as Parameters<typeof sendEmail>[0];
    await expect(sendEmail(env, { kind: 'security-code', to: 'test@example.com', code: '123456', locale: 'en' })).resolves.toEqual({ ok: true });
    expect(payload?.subject).toBe('Security @ Skin');
    expect(payload?.text).toContain('Code 123456; repeat 123456');
  });
  it('uses the selected language for every supported locale while keeping links and codes intact', () => {
    for (const locale of LOCALES) {
      const code = renderEmail({ kind: 'security-code', to: 'test@example.com', code: '123456', locale }, 'https://skin.example');
      expect(code.subject).toBe(translate(locale, 'mail.security_title'));
      expect(code.text).toContain('123456');
      const verify = renderEmail({ kind: 'verify-email', to: 'test@example.com', token: 'a&b', locale }, 'https://skin.example');
      expect(verify.text).toContain('https://skin.example/verify-email?token=a%26b');
      expect(verify.html).not.toContain('{code}');
    }
  });
  it('falls back to English and escapes user content', () => {
    const email = renderEmail({ kind: 'report-resolved', to: 'test@example.com', textureName: '<script>alert(1)</script>', outcome: 'resolved', locale: 'de_DE' }, 'https://skin.example');
    expect(email.subject).toBe('Your report was reviewed');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
  it('previews the same escaped mail layout used for queued broadcasts', () => {
    const preview = renderEmail({ kind: 'admin-broadcast', to: '', title: '<Notice>', content: '<img src=x onerror=alert(1)>', locale: 'en' }, 'https://skin.example');
    expect(preview.subject).toBe('<Notice>');
    expect(preview.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(preview.html).not.toContain('<img');
    expect(preview.text).toContain('<img src=x onerror=alert(1)>');
  });
  it('serializes recipients and advances through a cursor queue in small batches', async () => {
    let active = 0;
    let maximum = 0;
    const deliveries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      active++;
      maximum = Math.max(maximum, active);
      deliveries.push(String(JSON.parse(String(init.body)).to[0]));
      await Promise.resolve();
      active--;
      return new Response(null, { status: 200 });
    });
    const sent: EmailQueueMessage[] = [];
    const env = {
      APP_URL: 'https://skin.example', MAIL_FROM: 'Skin <noreply@skin.example>', RESEND_API_KEY: 'test',
      DB: { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ all: async () => ({ results: sql.includes('id >') ? Array.from({ length: 50 }, (_, index) => ({ id: index + 1, email: `u${index}@example.test`, locale: 'en' })) : [] }) }) }) },
      EMAIL_NOTIFICATIONS: { send: async (body: EmailQueueMessage) => { sent.push(body); } },
    } as unknown as Parameters<typeof processBroadcastEmail>[0];
    const message = { broadcastId: 'broadcast-1', receiver: 'all' as const, title: 'Update', content: 'Hello', afterId: 0 };
    await processBroadcastEmail(env, message);
    expect(deliveries).toHaveLength(50);
    expect(maximum).toBe(1);
    expect(sent).toEqual([{ ...message, afterId: 50 }]);
    expect(deliveries[0]).toBe('u0@example.test');
  });
});
