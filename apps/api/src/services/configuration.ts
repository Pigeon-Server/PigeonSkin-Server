import type { Bindings } from '../env.ts';
import { AppError } from '../framework.ts';

export const CONFIGURATION = {
  site_url: { binding: 'APP_URL', fallback: '' },
  mail_from: { binding: 'MAIL_FROM', fallback: 'noreply@example.com' },
  turnstile_enabled: { binding: 'TURNSTILE_ENABLED', fallback: 'false' },
  turnstile_site_key: { binding: 'TURNSTILE_SITE_KEY', fallback: '' },
  turnstile_secret: { binding: 'TURNSTILE_SECRET', fallback: '' },
  resend_api_key: { binding: 'RESEND_API_KEY', fallback: '' },
  rate_limit_enabled: { binding: 'RATE_LIMIT_ENABLED', fallback: 'true' },
  github_client_id: { binding: 'GITHUB_CLIENT_ID', fallback: '' },
  github_client_secret: { binding: 'GITHUB_CLIENT_SECRET', fallback: '' },
  littleskin_client_id: { binding: 'LITTLESKIN_CLIENT_ID', fallback: '' },
  littleskin_client_secret: { binding: 'LITTLESKIN_CLIENT_SECRET', fallback: '' },
  littleskin_api_root: { binding: 'LITTLESKIN_API_ROOT', fallback: 'https://littleskin.cn/api' },
  microsoft_client_id: { binding: 'MICROSOFT_CLIENT_ID', fallback: '' },
  microsoft_client_secret: { binding: 'MICROSOFT_CLIENT_SECRET', fallback: '' },
  mojang_client_id: { binding: 'MOJANG_CLIENT_ID', fallback: '' },
  mojang_client_secret: { binding: 'MOJANG_CLIENT_SECRET', fallback: '' },
} as const;
export const SECRET_PLACEHOLDER = '********';

export type ConfigurationSourceEnv = Pick<Bindings, 'DB'> & {
  [K in (typeof CONFIGURATION)[keyof typeof CONFIGURATION]['binding']]?: string | undefined;
};

export async function configurationValues(env: ConfigurationSourceEnv) {
  const keys = Object.keys(CONFIGURATION);
  const result = await env.DB.prepare(`SELECT key, value FROM settings WHERE locale = '' AND key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>();
  const stored = Object.fromEntries(result.results.map(row => [row.key, row.value]));
  const values: Record<string, string> = {};
  for (const [key, spec] of Object.entries(CONFIGURATION)) {
    values[key] = Object.hasOwn(stored, key) ? stored[key]! : (env[spec.binding] ?? spec.fallback);
  }
  if (!Object.hasOwn(stored, 'turnstile_enabled') && env.TURNSTILE_ENABLED === undefined && values.turnstile_site_key && values.turnstile_secret) values.turnstile_enabled = 'true';
  if (!values.site_url) values.site_url = env.APP_URL || 'http://localhost:8787';
  return values;
}
export async function resolveConfiguration(env: Bindings): Promise<Bindings> {
  const values = await configurationValues(env);
  const resolved = { ...env };
  for (const [key, spec] of Object.entries(CONFIGURATION)) resolved[spec.binding] = values[key]!;
  resolved.APP_URL = resolved.APP_URL.replace(/\/$/, '');
  let canonical: URL;
  try { canonical = new URL(resolved.APP_URL); } catch { throw new AppError('common.internal_error', 503); }
  const localDevelopment = resolved.ENVIRONMENT === 'development' && canonical.protocol === 'http:';
  if ((!localDevelopment && canonical.protocol !== 'https:') || canonical.username || canonical.password || canonical.hash || canonical.pathname !== '/' || canonical.search) throw new AppError('common.internal_error', 503);
  return resolved;
}
