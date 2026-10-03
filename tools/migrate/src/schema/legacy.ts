// 旧库 schema 知识 —— 迁移工具关于"旧系统长什么样"的唯一事实来源。
//
// 这里记录的是**最终有效形态**（应用全部 20 个迁移之后），不是最初的
// create_all_tables。旧库的列会随版本变化，所以一切都要先探测再使用。
//
// 对应文档：docs/rewrite/10-migration-mapping.md

/** 迁移工具必须读的旧表；缺失即为阻塞项 */
export const REQUIRED_LEGACY_TABLES = [
  'users',
  'players',
  'textures',
  'options',
] as const;

/** 可选读的旧表；存在就迁，缺失只报告不阻塞 */
export const OPTIONAL_LEGACY_TABLES = [
  'user_closet',
  'reports',
  'notifications',
  'language_lines',
] as const;

export const MIGRATED_PLUGIN_TABLES = [
  'uuid', 'textures_description', 'ps_ApiKeys', 'ps_ModPackList',
  'ps_VoteData', 'ps_VoteList', 'ps_VoteRecord', 'ps_VoteRequire',
] as const;

/**
 * 只用于"识别并丢弃"的表。它们不需要迁移，但要在报告里点名，
 * 让运维知道这些东西被有意丢弃了，而不是被忘了。
 */
export const DROPPED_LEGACY_TABLES = [
  'jobs',
  'failed_jobs',
  'migrations',
  'password_resets',
  'scopes',
  'oauth_auth_codes',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_clients',
  'oauth_personal_access_clients',
] as const;

/** 幽灵表：某处引用过但没有任何迁移创建它们 */
export const PHANTOM_LEGACY_TABLES = ['password_resets', 'failed_jobs'] as const;

// ── 旧库的 datetime 语义 ─────────────────────────────────────────────────────
// 全部 datetime 列由 Laravel/Carbon 按应用时区写入，而该时区在
// config/app.php:96 硬编码为 'Asia/Shanghai'，列里不带偏移量与时区。
export const LEGACY_DEFAULT_TIMEZONE = 'Asia/Shanghai';

// ── 密码算法 ─────────────────────────────────────────────────────────────────
// 算法由部署级环境变量 PWD_METHOD 决定，不在行里。因此必须从旧 .env 读，
// 而不是逐行嗅探哈希字符串（裸十六进制家族有歧义：64 位可能是 sha256 也可能是 salted2sha256）。
export const PWD_METHOD_TO_ALGO: Readonly<Record<string, LegacyPasswordAlgo>> = {
  BCRYPT: 'bcrypt',
  ARGON2I: 'argon2i',
  PHP_PASSWORD_HASH: 'bcrypt', // PHP 8 上 PASSWORD_DEFAULT 就是 bcrypt
  MD5: 'md5',
  SALTED2MD5: 'salted2md5',
  SHA256: 'sha256',
  SALTED2SHA256: 'salted2sha256',
  SHA512: 'sha512',
  SALTED2SHA512: 'salted2sha512',
};

export type LegacyPasswordAlgo =
  | 'bcrypt' | 'argon2i' | 'md5' | 'salted2md5'
  | 'sha256' | 'salted2sha256' | 'sha512' | 'salted2sha512';

/** 需要旧站 SALT 环境变量的算法；其余都不需要（bcrypt 的盐在哈希串里） */
export const ALGOS_REQUIRING_LEGACY_SALT: ReadonlySet<LegacyPasswordAlgo> = new Set([
  'salted2md5', 'salted2sha256', 'salted2sha512',
]);

// ── options → settings 映射 ──────────────────────────────────────────────────
// 见 docs/rewrite/10-migration-mapping.md §6.1

export type OptionTransform =
  /** 值可直接照搬 */
  | { kind: 'copy' }
  /** 字符串 'true'/'false' → 布尔 */
  | { kind: 'boolean' }
  /** 同 boolean，但语义取反（旧键是否定式命名） */
  | { kind: 'boolean-inverted' }
  /** 数值字符串 → 整数 */
  | { kind: 'integer' }
  /** 逗号分隔对 → 两个键（sign_score → min/max） */
  | { kind: 'pair'; secondKey: string }
  /** 需要专门处理，由 mapper 实现 */
  | { kind: 'special'; note: string };

export interface OptionMapping {
  readonly to: string;
  readonly transform: OptionTransform;
}

export const OPTION_KEY_MAP: Readonly<Record<string, OptionMapping>> = {
  ps_cleaningFrequency: { to: 'pigeon_api_window_seconds', transform: { kind: 'integer' } },
  ps_usageTimes: { to: 'pigeon_api_request_limit', transform: { kind: 'integer' } },
  site_name: { to: 'site_name', transform: { kind: 'copy' } },
  site_description: { to: 'site_description', transform: { kind: 'copy' } },
  announcement: { to: 'announcement', transform: { kind: 'copy' } },
  content_policy: { to: 'content_policy', transform: { kind: 'copy' } },
  copyright_text: { to: 'copyright_text', transform: { kind: 'copy' } },
  copyright_prefer: { to: 'copyright_preset', transform: { kind: 'integer' } },
  regs_per_ip: {
    to: 'regs_per_ip',
    transform: { kind: 'special', note: '-1 表示关闭注册，要拆成 registration_enabled=false' },
  },
  require_verification: { to: 'require_email_verification', transform: { kind: 'boolean' } },
  register_with_player_name: { to: 'register_with_player_name', transform: { kind: 'boolean' } },
  player_name_rule: { to: 'player_name_rule', transform: { kind: 'copy' } },
  custom_player_name_regexp: { to: 'player_name_regexp', transform: { kind: 'copy' } },
  player_name_length_min: { to: 'player_name_length_min', transform: { kind: 'integer' } },
  player_name_length_max: { to: 'player_name_length_max', transform: { kind: 'integer' } },
  user_initial_score: { to: 'initial_score', transform: { kind: 'integer' } },
  sign_score: {
    to: 'sign_score_min',
    transform: { kind: 'pair', secondKey: 'sign_score_max' },
  },
  sign_gap_time: { to: 'sign_gap_hours', transform: { kind: 'integer' } },
  score_per_storage: {
    to: 'score_per_kb_public',
    transform: { kind: 'special', note: "默认值是字符串 'true'，要当数字 1 用" },
  },
  private_score_per_storage: { to: 'score_per_kb_private', transform: { kind: 'integer' } },
  score_per_player: { to: 'score_per_player', transform: { kind: 'integer' } },
  score_per_closet_item: { to: 'score_per_closet_item', transform: { kind: 'integer' } },
  return_score: { to: 'refund_on_delete', transform: { kind: 'boolean' } },
  score_award_per_texture: { to: 'score_award_per_texture', transform: { kind: 'integer' } },
  take_back_scores_after_deletion: { to: 'clawback_award_on_delete', transform: { kind: 'boolean' } },
  score_award_per_like: { to: 'score_award_per_like', transform: { kind: 'integer' } },
  reporter_score_modification: { to: 'reporter_score_delta', transform: { kind: 'integer' } },
  reporter_reward_score: { to: 'reporter_reward_score', transform: { kind: 'integer' } },
  max_upload_file_size: { to: 'max_upload_size_kb', transform: { kind: 'integer' } },
  max_texture_width: { to: 'max_texture_width', transform: { kind: 'integer' } },
  texture_name_regexp: { to: 'texture_name_regexp', transform: { kind: 'copy' } },
  allow_downloading_texture: { to: 'allow_texture_download', transform: { kind: 'boolean' } },
  status_code_for_private: { to: 'private_texture_status', transform: { kind: 'integer' } },
  home_pic_url: { to: 'home_background_url', transform: { kind: 'copy' } },
  favicon_url: { to: 'favicon_url', transform: { kind: 'copy' } },
  navbar_color: { to: 'navbar_color', transform: { kind: 'copy' } },
  sidebar_color: { to: 'sidebar_color', transform: { kind: 'copy' } },
  transparent_navbar: { to: 'transparent_navbar', transform: { kind: 'boolean' } },
  custom_css: { to: 'custom_css', transform: { kind: 'copy' } },
  custom_js: { to: 'custom_js', transform: { kind: 'copy' } },
  meta_keywords: { to: 'meta_keywords', transform: { kind: 'copy' } },
  meta_description: { to: 'meta_description', transform: { kind: 'copy' } },
  hide_intro: { to: 'home_show_intro', transform: { kind: 'boolean-inverted' } },
  fixed_bg: { to: 'home_fixed_background', transform: { kind: 'boolean' } },
};

/** 有意丢弃的旧选项；报告里点名，避免运维以为配置被忘了 */
export const DROPPED_OPTION_KEYS: Readonly<Record<string, string>> = {
  version: '由部署的 commit / 包版本取代',
  cdn_address: '被 Cloudflare 吸收',
  auto_detect_asset_url: '被 Cloudflare 吸收',
  force_ssl: '所有流量在边缘就是 HTTPS',
  plugins_enabled: '无插件系统（D10）',
  enable_avatar_cache: '衍生图不可变且被 CDN 缓存，开关失去意义',
  enable_preview_cache: '同上',
  recaptcha_sitekey: 'Turnstile 取代 reCAPTCHA',
  recaptcha_secretkey: '同上',
  recaptcha_invisible: '同上',
  sign_after_zero: '按文档 01 §4 的精简方案删除（只保留滚动小时制）',
  meta_extras: '原始 <meta> 注入，由 SPA 的 head 管理取代',
};

/** 支持按语言覆盖的旧选项键（旧库把 locale 编码在键名后缀里） */
export const LOCALIZABLE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'site_name',
  'site_description',
  'announcement',
  'content_policy',
  'copyright_text',
  'copyright_prefer',
]);

/** 旧的 locale 别名 → 新 locale（见 docs/rewrite/10-migration-mapping.md §3） */
export const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  zh_HANS_CN: 'zh_CN',
  zh_HANT_TW: 'zh_TW',
  en_US: 'en',
  ru: 'ru_RU',
};

/**
 * 从键名里拆出 {baseKey, locale}。旧库把本地化变体存成 `site_name_en`。
 * 返回 null 表示这个键不是已知的本地化变体。
 */
export function splitLocalizedOptionKey(
  optionName: string,
  knownLocales: readonly string[],
): { baseKey: string; locale: string } | null {
  // 从最长后缀开始匹配，避免 site_name_zh_CN 被切成 site_name_zh
  const candidates = [...knownLocales].sort((a, b) => b.length - a.length);
  for (const locale of candidates) {
    const suffix = `_${locale}`;
    if (optionName.endsWith(suffix)) {
      const baseKey = optionName.slice(0, -suffix.length);
      if (LOCALIZABLE_OPTION_KEYS.has(baseKey)) return { baseKey, locale };
    }
  }
  return null;
}
