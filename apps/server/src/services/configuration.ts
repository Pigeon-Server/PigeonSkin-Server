

import { currentCacheGeneration } from './../core/cache-generation.ts';
import { type Bindings } from './../core/env.ts';
import { AppError } from './../core/framework.ts';
export const CONFIGURATION = {
  site_url: { binding: 'APP_URL', fallback: '' },
  mail_from: { binding: 'MAIL_FROM', fallback: 'noreply@example.com' },
  mail_driver: { binding: 'MAIL_DRIVER', fallback: 'resend' },
  smtp_host: { binding: 'SMTP_HOST', fallback: '' },
  smtp_port: { binding: 'SMTP_PORT', fallback: '0' },
  smtp_encryption: { binding: 'SMTP_ENCRYPTION', fallback: 'starttls' },
  smtp_username: { binding: 'SMTP_USERNAME', fallback: '' },
  smtp_password: { binding: 'SMTP_PASSWORD', fallback: '' },
  // 人机验证（captcha.ts）：driver 空 = 关闭。旧的 turnstile_* 设置在
  // configurationValues 里推导为 captcha_driver = 'turnstile'，无需用户手动迁移。
  captcha_driver: { binding: 'CAPTCHA_DRIVER', fallback: '' },
  captcha_site_key: { binding: 'CAPTCHA_SITE_KEY', fallback: '' },
  captcha_secret: { binding: 'CAPTCHA_SECRET', fallback: '' },
  aliyun_captcha_access_key_id: { binding: 'ALIYUN_CAPTCHA_ACCESS_KEY_ID', fallback: '' },
  recaptcha_v3_threshold: { binding: 'RECAPTCHA_V3_THRESHOLD', fallback: '50' },
  resend_api_key: { binding: 'RESEND_API_KEY', fallback: '' },
  rate_limit_enabled: { binding: 'RATE_LIMIT_ENABLED', fallback: 'true' },
  // 皮肤库反爬守卫（限流 + 渐进式人机验证）：默认开启，可在后台关闭
  skinlib_guard_enabled: { binding: 'SKINLIB_GUARD_ENABLED', fallback: 'true' },
  github_client_id: { binding: 'GITHUB_CLIENT_ID', fallback: '' },
  github_client_secret: { binding: 'GITHUB_CLIENT_SECRET', fallback: '' },
  // OAuth 授权回调地址：留空回落 APP_URL 拼接的默认值。对应 PHP 版 .env 的
  // *_REDIRECT_URI —— 第三方应用登记的回调与站点部署地址不一致时（如反代
  // 域名、多域名）可在这里显式指定，发起授权与换取令牌都用同一个值。
  github_redirect_uri: { binding: 'GITHUB_REDIRECT_URI', fallback: '' },
  littleskin_client_id: { binding: 'LITTLESKIN_CLIENT_ID', fallback: '' },
  littleskin_client_secret: { binding: 'LITTLESKIN_CLIENT_SECRET', fallback: '' },
  littleskin_api_root: { binding: 'LITTLESKIN_API_ROOT', fallback: 'https://littleskin.cn/api' },
  littleskin_redirect_uri: { binding: 'LITTLESKIN_REDIRECT_URI', fallback: '' },
  microsoft_client_id: { binding: 'MICROSOFT_CLIENT_ID', fallback: '' },
  microsoft_client_secret: { binding: 'MICROSOFT_CLIENT_SECRET', fallback: '' },
  microsoft_redirect_uri: { binding: 'MICROSOFT_REDIRECT_URI', fallback: '' },
  mojang_client_id: { binding: 'MOJANG_CLIENT_ID', fallback: '' },
  mojang_client_secret: { binding: 'MOJANG_CLIENT_SECRET', fallback: '' },
  mojang_redirect_uri: { binding: 'MOJANG_REDIRECT_URI', fallback: '' },
  // AI 网关驱动：管理员可在 UI 切换驱动并自配 API 地址/Key，
  // 未在设置里写时回落到部署 env（Workers AI 绑定不受此控制）。
  ai_driver: { binding: 'AI_MODERATION_DRIVER', fallback: '' },
  ai_api_key: { binding: 'OPENAI_API_KEY', fallback: '' },
  openai_base_url: { binding: 'OPENAI_BASE_URL', fallback: '' },
  // 判别模型（System One / Clef）凭据：部署 env 兜底，UI 可覆盖
  ai_systemone_api_key: { binding: 'TYPESAFE_API_KEY', fallback: '' },
  ai_systemone_base_url: { binding: 'SYSTEMONE_BASE_URL', fallback: '' },
  ai_cloudflare_account_id: { binding: 'CLOUDFLARE_ACCOUNT_ID', fallback: '' },
  ai_cloudflare_api_token: { binding: 'CLOUDFLARE_API_TOKEN', fallback: '' },
} as const;
export const SECRET_PLACEHOLDER = '********';

export type ConfigurationSourceEnv = Pick<Bindings, 'DB'> & {
  [K in (typeof CONFIGURATION)[keyof typeof CONFIGURATION]['binding']]?: string | undefined;
} & Partial<Pick<Bindings, 'ANTHROPIC_API_KEY' | 'TURNSTILE_ENABLED' | 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET'>>;

// 原始存值（locale = '' 的行，不含默认值合并）的读缓存。configurationValues
// 在每个请求的 resolveConfiguration 里都要跑，直查等于每请求多一次 33 键 D1 查询。
// 按 env.DB 用 WeakMap 分桶：生产 isolate 只有一个 DB 实例，测试里不同 mock 互不污染。
// 不能复用 lib 的 settingsCache：readSettings 会合并 SETTING_DEFAULTS/EXTRA_DEFAULTS，
// 默认值会遮蔽"DB 未存但部署 env 绑定有值"的回落，也会让下方 Object.hasOwn 的
// 旧 Turnstile / ANTHROPIC_API_KEY 推导永远命中。
//
// 失效用代数 + 60 秒 TTL 双保险：WeakMap 的键不可枚举，写入只
// 能失效处理该请求的 isolate（generation 自增即可），其余 isolate 靠 TTL 收敛 ——
// 与 lib 的 settingsCache 同一策略。代数经 cache-generation.ts 共享：
// lib 的 invalidateSettingsCache 同步递增它，配置缓存无需动态导入即可同步失效。
const configurationCache = new WeakMap<object, { stored: Record<string, string>; generation: number; expiresAt: number }>();
const configurationInflight = new WeakMap<object, Promise<Record<string, string>>>();

export async function configurationValues(env: ConfigurationSourceEnv) {
  const db = env.DB as unknown as object;
  const now = Date.now();
  const cached = configurationCache.get(db);
  if (cached && cached.generation === currentCacheGeneration() && cached.expiresAt > now) return finalizeConfiguration(env, cached.stored);
  const inflight = configurationInflight.get(db);
  if (inflight) return finalizeConfiguration(env, await inflight);

  const load = (async () => {
    // 快照代数而非写库时再取：查询飞行期间若发生失效，旧快照带着旧代数
    // 入缓存，下个请求会立即判过期重新查库，不会把旧配置当成新值缓存 60 秒。
    const generation = currentCacheGeneration();
    const keys = Object.keys(CONFIGURATION);
    const result = await env.DB.prepare(`SELECT key, value FROM settings WHERE locale = '' AND key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>();
    const stored = Object.fromEntries(result.results.map(row => [row.key, row.value]));
    configurationCache.set(db, { stored, generation, expiresAt: Date.now() + 60_000 });
    return stored;
  })();
  configurationInflight.set(db, load);
  try {
    return finalizeConfiguration(env, await load);
  } finally {
    configurationInflight.delete(db);
  }
}

function finalizeConfiguration(env: ConfigurationSourceEnv, stored: Record<string, string>) {
  const values: Record<string, string> = {};
  for (const [key, spec] of Object.entries(CONFIGURATION)) {
    values[key] = Object.hasOwn(stored, key) ? stored[key]! : (env[spec.binding] ?? spec.fallback);
  }
  // 旧 Turnstile 设置推导：管理员没存过 captcha_driver 时，按旧开关与旧
  // site key/secret 推导驱动与凭据（DB 存值优先，其次部署 env 绑定）。
  // 语义与旧版 flag(TURNSTILE_ENABLED) 一致：开关没设就是禁用，密钥齐全
  // 也不启用——避免"删了开关留着密钥"的存量部署在升级后被静默开启验证码。
  if (!Object.hasOwn(stored, 'captcha_driver')) {
    const legacyEnabled = stored.turnstile_enabled ?? env.TURNSTILE_ENABLED;
    const legacySiteKey = stored.turnstile_site_key ?? env.TURNSTILE_SITE_KEY ?? '';
    const legacySecret = stored.turnstile_secret ?? env.TURNSTILE_SECRET ?? '';
    if ((legacyEnabled === 'true' || legacyEnabled === '1') && legacySiteKey && legacySecret) {
      values.captcha_driver = 'turnstile';
      values.captcha_site_key = legacySiteKey;
      values.captcha_secret = legacySecret;
    }
  }
  // ai_api_key 是 OpenAI/Anthropic 通用的；部署 env 只给了 ANTHROPIC_API_KEY 时兜底
  if (!Object.hasOwn(stored, 'ai_api_key') && !env.OPENAI_API_KEY && env.ANTHROPIC_API_KEY) values.ai_api_key = env.ANTHROPIC_API_KEY;
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
