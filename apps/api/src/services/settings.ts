// 运行时设置的读写。
//
// 设置分两类，这个边界很重要：
//
// 所有写入都过 SETTING_REGISTRY 校验：类型、取值范围、枚举。没有注册表的话，
// 一次后台误操作就能把 score_per_kb_public 写成 "abc"，而错误会在用户上传时
// 才以"积分算错"的形式暴露出来。
import { createDb, settings } from '@pigeon-skin/db';
import { and, eq } from 'drizzle-orm';
import { fail } from '../framework.ts';
import { restrictedEmailListSchema } from '@pigeon-skin/shared/schemas';
import { SETTING_DEFAULTS, type Bindings, type SettingKey } from '../env.ts';
import { invalidateSettingsCache } from '../lib.ts';
import { isLocale, normalizeLocale } from '@pigeon-skin/shared/i18n';
import { inspectSigningKey } from './ygg-key.ts';
import { configurationValues, SECRET_PLACEHOLDER } from './configuration.ts';
import { importPKCS8 } from 'jose';

export interface SettingsEnv {
  DB: Bindings['DB'];
  ENVIRONMENT?: Bindings['ENVIRONMENT'];
}

export type SettingKind = 'string' | 'integer' | 'boolean' | 'markdown' | 'enum';

interface SettingSpec {
  kind: SettingKind;
  /** 整数范围，或字符串长度上限 */
  min?: number;
  max?: number;
  values?: readonly string[];
  /** 可按语言覆盖（旧版把 locale 编码在键名后缀里） */
  localizable?: boolean;
  /** 仅超管可写 */
  superAdminOnly?: boolean;
  secret?: boolean;
}

/**
 * 设置注册表。加设置项必须同时加到这里，否则写入会被拒绝 ——
 * 这是刻意的摩擦，避免设置表变成"什么都能塞"的杂物间。
 */
export const SETTING_REGISTRY: Readonly<Record<SettingKey, SettingSpec>> = {
  votes_enabled: { kind: 'boolean' },
  pigeon_api_window_seconds: { kind: 'integer', min: 1, max: 3600 },
  pigeon_api_request_limit: { kind: 'integer', min: 1, max: 10000 },
  site_name: { kind: 'string', max: 100, localizable: true },
  csl_first: { kind: 'enum', values: ['mojang', 'self'] },
  theme_color: { kind: 'string', max: 7 },
  site_description: { kind: 'string', max: 500, localizable: true },
  registration_enabled: { kind: 'boolean' },
  regs_per_ip: { kind: 'integer', min: -1, max: 1000 },
  require_email_verification: { kind: 'boolean' },
  register_with_player_name: { kind: 'boolean' },
  player_name_rule: { kind: 'enum', values: ['official', 'cjk', 'utf8', 'custom'] },
  player_name_length_min: { kind: 'integer', min: 1, max: 50 },
  player_name_length_max: { kind: 'integer', min: 1, max: 50 },
  initial_score: { kind: 'integer', min: 0, max: 1_000_000 },
  score_per_player: { kind: 'integer', min: 0, max: 1_000_000 },
  free_player_count: { kind: 'integer', min: 0, max: 1_000_000 },
  max_player_count: { kind: 'integer', min: -1, max: 1_000_000 },
  score_per_kb_public: { kind: 'integer', min: 0, max: 10_000 },
  score_per_kb_private: { kind: 'integer', min: 0, max: 10_000 },
  score_per_closet_item: { kind: 'integer', min: 0, max: 1_000_000 },
  refund_on_delete: { kind: 'boolean' },
  max_upload_size_kb: { kind: 'integer', min: 1, max: 100_000 },
  max_texture_width: { kind: 'integer', min: 64, max: 65_536 },
  allow_texture_download: { kind: 'boolean' },
  allow_anonymous_download: { kind: 'boolean' },
  official_resources_auto_update: { kind: 'boolean' },
  private_texture_status: { kind: 'enum', values: ['403', '404'] },
  sign_score_min: { kind: 'integer', min: 0, max: 1_000_000 },
  sign_score_max: { kind: 'integer', min: 0, max: 1_000_000 },
  sign_gap_hours: { kind: 'integer', min: 1, max: 720 },
  score_award_per_texture: { kind: 'integer', min: 0, max: 1_000_000 },
  clawback_award_on_delete: { kind: 'boolean' },
  score_award_per_like: { kind: 'integer', min: 0, max: 1_000_000 },
  reporter_score_delta: { kind: 'integer', min: -1_000_000, max: 1_000_000 },
  reporter_reward_score: { kind: 'integer', min: 0, max: 1_000_000 },
  player_name_regexp: { kind: 'string', max: 500, superAdminOnly: true },
  texture_name_regexp: { kind: 'string', max: 500, superAdminOnly: true },

  // Phase A / 插件内置化
  meta_extras: { kind: 'string', max: 2_000 },
  sign_reset_mode: { kind: 'enum', values: ['rolling', 'daily'] },
  textures_description_limit: { kind: 'integer', min: 0, max: 100_000 },
  adsense_client_id: { kind: 'string', max: 100 },
  gtag_id: { kind: 'string', max: 50 },
  mojang_verification_score_award: { kind: 'integer', min: 0, max: 1_000_000 },
  ygg_connect_enabled: { kind: 'boolean' },
  oauth_enabled: { kind: 'boolean' },
  ygg_disable_authserver: { kind: 'boolean' },
  ygg_uuid_algorithm: { kind: 'enum', values: ['v3', 'v4'] },
  ygg_token_expire_1: { kind: 'integer', min: 60, max: 2_592_000 },
  ygg_token_expire_2: { kind: 'integer', min: 60, max: 5_184_000 },
  ygg_tokens_limit: { kind: 'integer', min: 1, max: 100 },
  ygg_rate_limit: { kind: 'integer', min: 0, max: 60000 },
  ygg_skin_domain: { kind: 'string', max: 500 },
  ygg_search_profile_max: { kind: 'integer', min: 1, max: 100 },
  ygg_show_config_section: { kind: 'boolean' },
  ygg_enable_ali: { kind: 'boolean' },
  ygg_private_key: { kind: 'string', max: 8_000, secret: true, superAdminOnly: true },
  comments_enabled: { kind: 'boolean' },
  comments_ai_moderation: { kind: 'boolean' },
  // AI 网关：全局并发上限 + 材质翻译/审核开关 + 每任务模型/提示词覆盖
  ai_max_concurrency: { kind: 'integer', min: 1, max: 10 },
  ai_timeout_seconds: { kind: 'integer', min: 5, max: 300 },
  ai_reasoning: { kind: 'enum', values: ['default', 'disabled', 'enabled'] },
  texture_ai_translation: { kind: 'boolean' },
  texture_ai_moderation: { kind: 'boolean' },
  notification_ai_translation: { kind: 'boolean' },
  ai_comments_moderation_model: { kind: 'string', max: 100 },
  ai_comments_moderation_prompt: { kind: 'string', max: 8_000 },
  ai_comments_moderation_mode: { kind: 'enum', values: ['', 'generative', 'discriminative'] },
  ai_texture_translate_model: { kind: 'string', max: 100 },
  ai_texture_translate_prompt: { kind: 'string', max: 8_000 },
  ai_texture_moderate_model: { kind: 'string', max: 100 },
  ai_texture_moderate_prompt: { kind: 'string', max: 8_000 },
  ai_texture_moderate_mode: { kind: 'enum', values: ['', 'generative', 'discriminative'] },
  ai_discriminative_threshold: { kind: 'integer', min: 10, max: 90 },
  restricted_email_allow: { kind: 'string', max: 10_000 },
  restricted_email_deny: { kind: 'string', max: 10_000 },
  sitemap_max_urls: { kind: 'integer', min: 100, max: 50_000 },
} as const;

/** 不在注册表里但需要可写、且仅超管的设置项 */
export const EXTRA_SETTINGS: Readonly<Record<string, SettingSpec>> = {
  search_google_enabled: { kind: 'boolean', superAdminOnly: true },
  search_google_property: { kind: 'string', max: 500, superAdminOnly: true },
  search_google_credentials: { kind: 'string', max: 16_000, secret: true, superAdminOnly: true },
  search_bing_enabled: { kind: 'boolean', superAdminOnly: true },
  search_bing_key: { kind: 'string', max: 128, secret: true, superAdminOnly: true },
  search_baidu_enabled: { kind: 'boolean', superAdminOnly: true },
  search_baidu_token: { kind: 'string', max: 500, secret: true, superAdminOnly: true },
  site_url: { kind: 'string', max: 500, superAdminOnly: true },
  mail_from: { kind: 'string', max: 320, superAdminOnly: true },
  mail_driver: { kind: 'enum', values: ['resend', 'smtp'], superAdminOnly: true },
  smtp_host: { kind: 'string', max: 255, superAdminOnly: true },
  smtp_port: { kind: 'integer', min: 0, max: 65_535, superAdminOnly: true },
  smtp_encryption: { kind: 'enum', values: ['starttls', 'ssl', 'none'], superAdminOnly: true },
  smtp_username: { kind: 'string', max: 320, superAdminOnly: true },
  smtp_password: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  // 人机验证凭据。site_key 语义随 driver 变化：Turnstile site key /
  // reCAPTCHA site key / 腾讯 CaptchaAppId / 阿里 SceneId。secret 同理：
  // 各驱动的服务端密钥；阿里驱动下存 AccessKeySecret。image（自绘图案）
  // 用 SESSION_SECRET 签题，无凭据可配。
  captcha_driver: { kind: 'enum', values: ['', 'turnstile', 'recaptcha_v2', 'recaptcha_v3', 'tencent', 'aliyun', 'image'], superAdminOnly: true },
  captcha_site_key: { kind: 'string', max: 500, superAdminOnly: true },
  captcha_secret: { kind: 'string', max: 1000, secret: true, superAdminOnly: true },
  aliyun_captcha_access_key_id: { kind: 'string', max: 200, superAdminOnly: true },
  recaptcha_v3_threshold: { kind: 'integer', min: 0, max: 100, superAdminOnly: true },
  resend_api_key: { kind: 'string', max: 1000, secret: true, superAdminOnly: true },
  rate_limit_enabled: { kind: 'boolean', superAdminOnly: true },
  // 皮肤库反爬守卫：匿名访客按 IP 紧桶计数并渐进式人机验证（默认开启）
  skinlib_guard_enabled: { kind: 'boolean', superAdminOnly: true },
  github_client_id: { kind: 'string', max: 500, superAdminOnly: true },
  github_client_secret: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  littleskin_client_id: { kind: 'string', max: 500, superAdminOnly: true },
  littleskin_client_secret: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  littleskin_api_root: { kind: 'string', max: 500, superAdminOnly: true },
  microsoft_client_id: { kind: 'string', max: 500, superAdminOnly: true },
  microsoft_client_secret: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  mojang_client_id: { kind: 'string', max: 500, superAdminOnly: true },
  mojang_client_secret: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  // AI 网关驱动（空 = 跟随部署 env；openai = 任意 OpenAI 兼容端点；anthropic；systemone = 判别模型）
  ai_driver: { kind: 'enum', values: ['', 'openai', 'anthropic', 'systemone'], superAdminOnly: true },
  // 通用 API Key：按所选驱动作为 OpenAI/Anthropic 的 Bearer 凭据
  ai_api_key: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  openai_base_url: { kind: 'string', max: 500, superAdminOnly: true },
  // 判别模型凭据：TypeSafe System One（Jev）Key，及自托管经 REST 调 Cloudflare Clef 的凭据
  ai_systemone_api_key: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  ai_cloudflare_account_id: { kind: 'string', max: 200, superAdminOnly: true },
  ai_cloudflare_api_token: { kind: 'string', max: 2000, secret: true, superAdminOnly: true },
  custom_css: { kind: 'string', max: 100_000 },
  custom_js: { kind: 'string', max: 100_000, superAdminOnly: true },
  announcement: { kind: 'markdown', max: 20_000, localizable: true },
  config_generator_intro: { kind: 'markdown', max: 20_000, localizable: true },
  content_policy: { kind: 'markdown', max: 20_000, localizable: true },
  copyright_text: { kind: 'string', max: 2_000, localizable: true },
  copyright_preset: { kind: 'integer', min: 0, max: 6, localizable: true },
  icp_beian: { kind: 'string', max: 100 },
  public_security_beian: { kind: 'string', max: 100 },
  home_background_url: { kind: 'string', max: 500 },
  home_background_tablet_url: { kind: 'string', max: 500 },
  home_background_mobile_url: { kind: 'string', max: 500 },
  login_background_url: { kind: 'string', max: 500 },
  login_background_tablet_url: { kind: 'string', max: 500 },
  login_background_mobile_url: { kind: 'string', max: 500 },
  favicon_url: { kind: 'string', max: 500 },
  navbar_color: { kind: 'string', max: 30 },
  sidebar_color: { kind: 'string', max: 30 },
  transparent_navbar: { kind: 'boolean' },
  // 首页展示项。旧版 hide_intro 反转成 show（否定式键名容易写反逻辑）
  home_show_intro: { kind: 'boolean' },
  home_fixed_background: { kind: 'boolean' },
  // 首页风格：modern=新版（hero+精选画廊）；classic=旧版 Blessing Skin 欢迎页（splash+特性介绍）
  home_style: { kind: 'enum', values: ['modern', 'classic'] },
  meta_keywords: { kind: 'string', max: 500 },
  meta_description: { kind: 'string', max: 500 },
};

function specOf(key: string): SettingSpec | undefined {
  return (SETTING_REGISTRY as Record<string, SettingSpec>)[key] ?? EXTRA_SETTINGS[key];
}

/** 本地化设置的默认语言。与 SETTING_DEFAULTS 的语言保持一致。 */
export const DEFAULT_LOCALE = '';

export const EXTRA_DEFAULTS: Record<string, string> = {
  search_google_enabled: 'false', search_google_property: '', search_google_credentials: '',
  search_bing_enabled: 'false', search_bing_key: '', search_baidu_enabled: 'false', search_baidu_token: '',
  captcha_driver: '', captcha_site_key: '', captcha_secret: '',
  aliyun_captcha_access_key_id: '', recaptcha_v3_threshold: '50',
  skinlib_guard_enabled: 'true',
  site_url: '', mail_from: '', mail_driver: 'resend',
  ai_driver: '', ai_api_key: '', openai_base_url: '',
  ai_systemone_api_key: '', ai_cloudflare_account_id: '', ai_cloudflare_api_token: '',
  smtp_host: '', smtp_port: '0', smtp_encryption: 'starttls', smtp_username: '', smtp_password: '',
  config_generator_intro: '',
  custom_css: '', custom_js: '', announcement: '', content_policy: '',
  copyright_text: '', copyright_preset: '0', home_background_url: '', home_background_tablet_url: '', home_background_mobile_url: '',
  login_background_url: '', login_background_tablet_url: '', login_background_mobile_url: '', favicon_url: '',
  icp_beian: '', public_security_beian: '',
  navbar_color: '', sidebar_color: '', transparent_navbar: 'false',
  home_show_intro: 'true', home_fixed_background: 'false', home_style: 'modern', meta_keywords: '', meta_description: '',
};

// ── 读 ───────────────────────────────────────────────────────────────────────

/**
 * 读全部全局设置（locale = ''），叠加到内置默认值之上。
 *
 * locale 用 '' 而不是 NULL：SQLite 主键里的 NULL 彼此不相等，
 * 用 NULL 的话 (key, NULL) 行不会唯一。
 */
export async function readAll(env: SettingsEnv): Promise<Record<string, string>> {
  const rows = await createDb(env.DB)
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.locale, DEFAULT_LOCALE));

  const values: Record<string, string> = { ...SETTING_DEFAULTS, ...EXTRA_DEFAULTS };
  for (const r of rows) values[r.key] = r.value;
  return values;
}

/**
 * 读某语言的设置：以全局值为底，用该语言的覆盖盖上。
 * 对应旧版的 option_localized()。
 */
export async function readLocalized(
  env: SettingsEnv,
  locale: string,
): Promise<Record<string, string>> {
  const values = locale && normalizeLocale(locale) !== 'en' ? await readLocalized(env, 'en') : await readAll(env);
  if (locale === DEFAULT_LOCALE) return values;

  const rows = await createDb(env.DB)
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.locale, normalizeLocale(locale)));

  for (const r of rows) values[r.key] = r.value;
  return values;
}

/** 供公开接口使用的子集。绝不把 custom_js、正则等内部配置暴露出去。 */
const PUBLIC_KEYS = [
  'votes_enabled',
  'site_name', 'site_description', 'registration_enabled', 'register_with_player_name',
  'csl_first', 'config_generator_intro',
  'theme_color',
  'require_email_verification', 'player_name_rule', 'player_name_length_min',
  'player_name_length_max', 'initial_score', 'score_per_player', 'score_per_kb_public',
  'score_per_kb_private', 'score_per_closet_item', 'max_upload_size_kb',
  'max_texture_width', 'allow_texture_download', 'allow_anonymous_download', 'sign_score_min', 'sign_score_max',
  'sign_gap_hours', 'announcement', 'content_policy', 'copyright_text',
  'copyright_preset', 'home_background_url', 'home_background_tablet_url', 'home_background_mobile_url',
  'login_background_url', 'login_background_tablet_url', 'login_background_mobile_url', 'favicon_url', 'navbar_color',
  'icp_beian', 'public_security_beian',
  'sidebar_color', 'transparent_navbar', 'meta_keywords', 'meta_description',
  'sign_reset_mode', 'home_show_intro', 'home_fixed_background', 'home_style', 'custom_css',
  'meta_extras', 'adsense_client_id', 'gtag_id', 'ygg_show_config_section',
  'ygg_skin_domain', 'ygg_enable_ali', 'comments_enabled',
  'textures_description_limit',
  'mojang_verification_score_award',
] as const;

export async function readPublic(
  env: SettingsEnv,
  locale: string,
): Promise<Record<string, string>> {
  const all = await readLocalized(env, locale);
  const out: Record<string, string> = {};
  for (const key of PUBLIC_KEYS) {
    if (all[key] !== undefined) out[key] = all[key];
  }
  return out;
}

export async function localizedKeys(env: SettingsEnv, locale: string): Promise<string[]> {
  if (!locale) return [];
  const rows = await createDb(env.DB).select({ key: settings.key }).from(settings).where(eq(settings.locale, locale));
  return rows.map(row => row.key);
}

// ── 写 ───────────────────────────────────────────────────────────────────────

/** 校验单个值。返回规范化后的字符串，或抛 422。 */
export function validateSetting(key: string, raw: unknown): string {
  if (key === 'icp_beian' || key === 'public_security_beian') {
    if (typeof raw !== 'string') throw fail.invalid(undefined, { [key]: 'invalid_record_number' });
    const value = raw.trim();
    if (value.length > 100 || /[<>\u0000-\u001f\u007f]/.test(value)) throw fail.invalid(undefined, { [key]: 'invalid_record_number' });
    if (key === 'public_security_beian' && value && !/^(?:[\u4e00-\u9fff]{1,10}\s*公网安备\s*)?\d{14}\s*号?$/.test(value)) throw fail.invalid(undefined, { [key]: 'invalid_record_number' });
    return value;
  }
  if (key === 'restricted_email_allow' || key === 'restricted_email_deny') {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw)); } catch { throw fail.invalid('common.invalid_request', { [key]: 'invalid_domain_list' }); }
    const list = restrictedEmailListSchema.safeParse({ domains: parsed });
    if (!list.success) throw fail.invalid('common.invalid_request', { [key]: 'invalid_domain_list' });
    return JSON.stringify(list.data.domains);
  }
  if (key === 'theme_color' && !/^#[0-9a-fA-F]{6}$/.test(String(raw))) {
    throw fail.invalid('common.invalid_request', { theme_color: 'invalid_color' });
  }
  const spec = specOf(key);
  if (!spec) {
    // 不在注册表里的键一律拒绝：设置表不该变成"什么都能塞"的杂物间
    throw fail.invalid('common.invalid_request', { [key]: 'unknown_setting' });
  }

  switch (spec.kind) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw ? 'true' : 'false';
      if (raw === 'true' || raw === 'false') return raw;
      throw fail.invalid('common.invalid_request', { [key]: 'invalid_boolean' });
    }
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) {
        throw fail.invalid('common.invalid_request', { [key]: 'invalid_integer' });
      }
      if (spec.min !== undefined && n < spec.min) {
        throw fail.invalid('common.invalid_request', { [key]: 'below_minimum' });
      }
      if (spec.max !== undefined && n > spec.max) {
        throw fail.invalid('common.invalid_request', { [key]: 'above_maximum' });
      }
      return String(n);
    }
    case 'enum': {
      const s = String(raw);
      if (!spec.values?.includes(s)) {
        throw fail.invalid('common.invalid_request', { [key]: 'invalid_enum_value' });
      }
      return s;
    }
    default: {
      const s = String(raw);
      if (spec.max !== undefined && s.length > spec.max) {
        throw fail.invalid('common.invalid_request', { [key]: 'too_long' });
      }
      return s;
    }
  }
}

export interface SettingWrite {
  key: string;
  /** 留空表示写全局值。exactOptionalPropertyTypes 下要显式允许 undefined */
  locale?: string | undefined;
  value: unknown;
}

export interface WriteContext {
  /** 写 custom_js 需要超管 */
  isSuperAdmin: boolean;
}

/**
 * 批量写入。逐条校验，任一条非法则整批不写 —— 半成功会让后台界面与
 * 实际配置不一致，比直接失败更难排查。
 */
export async function writeMany(
  env: SettingsEnv,
  writes: readonly SettingWrite[],
  ctx: WriteContext,
): Promise<number> {
  if (writes.length === 0) return 0;

  const now = Date.now();
  const rows = writes.flatMap((w) => {
    const spec = specOf(w.key);
    if (spec?.superAdminOnly && !ctx.isSuperAdmin) {
      throw fail.forbidden('admin.forbidden');
    }
    if (spec?.secret && w.value === SECRET_PLACEHOLDER) return [];
    if (w.locale && !isLocale(w.locale)) throw fail.invalid();
    // 不可本地化的键拒绝带 locale，避免产生永远读不到的行
    const locale = spec?.localizable ? (w.locale ?? DEFAULT_LOCALE) : DEFAULT_LOCALE;
    return [{ key: w.key, locale, value: validateSetting(w.key, w.value), updatedAt: now }];
  });

  for (const row of rows) {
    if (row.key === 'search_bing_key' && row.value && !/^[a-zA-Z0-9-]{8,128}$/.test(row.value)) throw fail.invalid(undefined, { [row.key]: 'invalid_key' });
    if (row.key === 'search_google_credentials' && row.value) {
      try {
        const account = JSON.parse(row.value) as { type: string; client_email: string; private_key: string };
        if (account.type !== 'service_account' || !/^[^\s@]+@[^\s@]+$/.test(account.client_email)) throw new Error('invalid_account');
        await importPKCS8(account.private_key, 'RS256');
      } catch { throw fail.invalid(undefined, { [row.key]: 'invalid_credentials' }); }
    }
    if (['site_url', 'littleskin_api_root', 'openai_base_url', 'favicon_url', 'home_background_url', 'home_background_tablet_url', 'home_background_mobile_url', 'login_background_url', 'login_background_tablet_url', 'login_background_mobile_url'].includes(row.key) && row.value) {
      let url: URL;
      try { url = new URL(row.value); } catch { throw fail.invalid('common.invalid_request', { [row.key]: 'invalid_url' }); }
      const local = env.ENVIRONMENT === 'development' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (row.key === 'openai_base_url') {
        // LLM 网关常跑在本地（Ollama/vLLM），允许任意 http(s) 地址
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail.invalid('common.invalid_request', { [row.key]: 'invalid_url' });
      } else if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash || (row.key === 'site_url' && (url.pathname !== '/' || url.search))) throw fail.invalid('common.invalid_request', { [row.key]: 'invalid_url' });
    }
    // mail_from 允许完整 `名称 <邮箱>`、纯邮箱，或只写显示名（smtp 驱动下
    // 发送时自动用 SMTP 账号补全邮箱，见 email.ts resolveMailFrom）。
    // 换行可注入邮件头，任何写法都禁止；含尖括号时必须是完整地址形式。
    if (row.key === 'mail_from' && row.value) {
      const trimmed = row.value.trim();
      if (/[\r\n]/.test(trimmed) || (trimmed.includes('<') && !/^(?:[^<>\r\n]+ <)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(trimmed))) {
        throw fail.invalid('common.invalid_request', { mail_from: 'invalid_email' });
      }
    }
    // 主机名/IPv4/带方括号的 IPv6 字面量；裸 IPv6 要求写 [::1] 形式，避免与端口拼接歧义
    if (row.key === 'smtp_host' && row.value && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:.]+\])$/.test(row.value)) throw fail.invalid('common.invalid_request', { smtp_host: 'invalid_host' });
    if (row.key === 'ygg_private_key' && row.value && !(await inspectSigningKey(row.value)).valid) {
      throw fail.invalid('integration.invalid_key', { ygg_private_key: 'invalid_key' });
    }
  }

  // 交叉校验必须针对"写入之后"的状态，且在写入**之前**完成。
  // 否则会有两个后果：写入成功了却返回错误；以及一旦数据落到不一致状态，
  // 所有后续写入都被永久拦住，连修都修不回来。
  const current = { ...await configurationValues(env as Bindings), ...await readAll(env) };
  const prospective = { ...current };
  for (const row of rows) {
    if (row.locale === DEFAULT_LOCALE) prospective[row.key] = row.value;
  }
  assertConsistent(prospective);
  for (const [engine, credential] of [['google', 'search_google_credentials'], ['bing', 'search_bing_key'], ['baidu', 'search_baidu_token']]) {
    if (prospective[`search_${engine}_enabled`] === 'true' && !prospective[credential!]) throw fail.invalid(undefined, { [`search_${engine}_enabled`]: 'not_configured' });
  }
  if (prospective.search_google_property) {
    const root = new URL(prospective.site_url || (env as Bindings).APP_URL || 'https://invalid.example');
    const property = prospective.search_google_property;
    if (property !== `${root.origin}/` && !(property.startsWith('sc-domain:') && (root.hostname === property.slice(10) || root.hostname.endsWith(`.${property.slice(10)}`)))) throw fail.invalid(undefined, { search_google_property: 'invalid_property' });
  }
  // 每个驱动所需的凭据不同：阿里用 AccessKey 对（secret 存 AccessKeySecret），
  // 其余用 site_key + secret。驱动关着时不校验凭据，允许提前只填一半。
  const captchaDriver = prospective.captcha_driver ?? '';
  if (captchaDriver && captchaDriver !== 'image') {
    const missing: string[] = [];
    if (!prospective.captcha_site_key) missing.push('captcha_site_key');
    if (!prospective.captcha_secret) missing.push('captcha_secret');
    if (captchaDriver === 'aliyun' && !prospective.aliyun_captcha_access_key_id) missing.push('aliyun_captcha_access_key_id');
    if (missing.length) throw fail.invalid('common.invalid_request', { [missing[0]!]: 'not_configured' });
  }
  if (prospective.mail_driver === 'smtp' && !prospective.smtp_host) throw fail.invalid('common.invalid_request', { smtp_host: 'not_configured' });
  if (prospective.ygg_connect_enabled === 'true') {
    const key = await env.DB.prepare('SELECT kid FROM connect_keys WHERE retired_at IS NULL').first();
    const client = await env.DB.prepare('SELECT id FROM connect_clients WHERE enabled = 1').first();
    if (!key || !client) throw fail.invalid(undefined, { ygg_connect_enabled: 'not_configured' });
  }

  const db = createDb(env.DB);
  for (const row of rows) {
    await db.insert(settings)
      .values(row)
      .onConflictDoUpdate({
        target: [settings.key, settings.locale],
        set: { value: row.value, updatedAt: now },
      });
  }

  // 让本 isolate 的读缓存失效，否则"改了设置但没生效"会持续到 TTL 到期
  invalidateSettingsCache();

  return rows.length;
}

/** 单键写入糖衣（内部走 writeMany 走完整校验与缓存失效） */
export async function writeSetting(
  env: SettingsEnv, key: SettingKey, value: string,
  ctx: { isSuperAdmin: boolean } = { isSuperAdmin: false },
): Promise<void> {
  await writeMany(env, [{ key, value }], ctx);
}

/** 键与键之间的约束。单键的取值范围由 SETTING_REGISTRY 负责。 */
function assertConsistent(values: Record<string, string>): void {
  if (Number(values.ygg_token_expire_1) > Number(values.ygg_token_expire_2)) {
    throw fail.invalid('common.invalid_request', { ygg_token_expire_2: 'below_minimum' });
  }
  if (Number(values['sign_score_min']) > Number(values['sign_score_max'])) {
    throw fail.invalid('common.invalid_request', { sign_score_max: 'below_minimum' });
  }
  if (Number(values['player_name_length_min']) > Number(values['player_name_length_max'])) {
    throw fail.invalid('common.invalid_request', { player_name_length_max: 'below_minimum' });
  }
  // resend 没有 SMTP 账号可供自动补全：纯显示名的 mail_from 无法投递，写入时拦下
  if (values.mail_driver === 'resend' && values.mail_from && !values.mail_from.includes('<') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.mail_from.trim())) {
    throw fail.invalid('common.invalid_request', { mail_from: 'invalid_email' });
  }
}

/** 删除某语言的覆盖，回落到全局值 */
export async function clearLocalized(env: SettingsEnv, key: string, locale: string): Promise<void> {
  if (locale === DEFAULT_LOCALE) {
    throw fail.invalid('common.invalid_request', { locale: 'required' });
  }
  await createDb(env.DB).delete(settings)
    .where(and(eq(settings.key, key), eq(settings.locale, locale)));
}
