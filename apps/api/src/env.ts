// Worker 绑定与环境配置的类型。
//
import type { D1Database, DurableObjectNamespace, R2Bucket, Queue } from '@cloudflare/workers-types';
import type { SearchQueueMessage } from './services/search-submissions.ts';
import type { EmailQueueMessage } from './services/email.ts';

export interface Bindings {
  /** D1 数据库 */
  DB: D1Database;
  /** R2 桶：纹理与衍生图 */
  BUCKET: R2Bucket;
  /** 衍生图生成器（按 hash 命名实例，见 src/do/derivatives.ts） */
  DERIVATIVES: DurableObjectNamespace;
  OFFICIAL_RESOURCES: DurableObjectNamespace;
  /** 前端静态资源（Worker 同源托管 SPA） */
  ASSETS: Fetcher;
  SEARCH_SUBMISSIONS?: Queue<SearchQueueMessage>;
  EMAIL_NOTIFICATIONS?: Queue<EmailQueueMessage>;

  // ── 限流（Workers 原生 Rate Limiting binding，wrangler.jsonc ratelimits）──
  /** 全 API 通用桶 */
  RL_GLOBAL?: { limit(params: { key: string }): Promise<{ success: boolean }> };
  /** 认证端点的更紧桶 */
  RL_AUTH?: { limit(params: { key: string }): Promise<{ success: boolean }> };

  // ── 运行环境与业务配置的兼容绑定 ────────────────────────────────────────
  ENVIRONMENT: 'development' | 'preview' | 'production';
  /** 规范 Origin，用于邮件链接与绝对 URL */
  APP_URL: string;
  MAIL_FROM: string;
  /** Turnstile 开关。自托管部署可关掉。 */
  TURNSTILE_ENABLED: string;
  /** 是否下发预生成的衍生图 */
  DERIVATIVES_ENABLED: string;
  OFFICIAL_CATALOG_ENABLED?: string;
  /** 限流开关 */
  RATE_LIMIT_ENABLED?: string;

  // ── Secrets（wrangler secret put）────────────────────────────────────────
  /** 会话与签名链接的签名密钥 */
  SESSION_SECRET?: string;
  MFA_ENCRYPTION_KEY?: string;
  SETUP_TOKEN?: string;
  DEPLOY_HOOK_URL?: string;
  UPDATE_MANIFEST_URL?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  RESEND_API_KEY?: string;
  /**
   * 旧站的 SALT 环境变量值。**仅迁移期需要**，用于验证 SALTED2* 家族的历史哈希。
   * 最后一个旧哈希升级完之后就该删除。
   */
  LEGACY_SALT?: string;

  // ── OAuth 社交登录（内置，原 oauth-* 插件）───────────────────────────────
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  LITTLESKIN_CLIENT_ID?: string;
  LITTLESKIN_CLIENT_SECRET?: string;
  LITTLESKIN_API_ROOT?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** mojang-verification 独立凭据（缺省回落 MICROSOFT_*） */
  MOJANG_CLIENT_ID?: string;
  MOJANG_CLIENT_SECRET?: string;

  /** Workers AI 审核评论用的绑定（wrangler ai） */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}

/** 判断是否启用了某个布尔型部署配置（'true' / '1' 都算开） */
export function flag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/** 运行时可改的设置项默认值。数据库 settings 表里有值时会覆盖它们。 */
export const SETTING_DEFAULTS = {
  votes_enabled: 'true',
  pigeon_api_window_seconds: '30',
  pigeon_api_request_limit: '60',
  site_name: 'Pigeon Skin Server',
  csl_first: 'self',
  theme_color: '#52647a',
  site_description: '',
  registration_enabled: 'true',
  regs_per_ip: '3',
  require_email_verification: 'false',
  register_with_player_name: 'true',
  player_name_rule: 'official',
  player_name_length_min: '3',
  player_name_length_max: '16',
  initial_score: '1000',
  score_per_player: '100',
  free_player_count: '0',
  max_player_count: '-1',
  score_per_kb_public: '1',
  score_per_kb_private: '10',
  score_per_closet_item: '0',
  refund_on_delete: 'true',
  max_upload_size_kb: '1024',
  max_texture_width: '8192',
  allow_texture_download: 'false',
  private_texture_status: '403',
  sign_score_min: '10',
  sign_score_max: '100',
  sign_gap_hours: '24',

  // 高级积分项。默认全为 0 / 关闭，让它们在默认配置下是完全惰性的 ——
  // 旧版把"举报押金""按收藏奖励"这类容易让人困惑的机制也放在主界面上，
  // 这里收进高级项但保留键名语义，既精简界面又不丢兼容性。
  score_award_per_texture: '0',
  clawback_award_on_delete: 'true',
  score_award_per_like: '0',
  reporter_score_delta: '0',
  reporter_reward_score: '0',

  // 这两个正则由 API 在注册与上传时直接读取，所以放在一等设置里。
  // 空字符串表示不限制。
  player_name_regexp: '',
  texture_name_regexp: '',

  // ── Phase A：对齐旧版补齐 ────────────────────────────────────────────────
  // SEO（旧版 meta 分组）
  meta_extras: '',
  // 签到重置模式：rolling=按 sign_gap_hours 滚动冷却；daily=每日 0 点（UTC+8）后可再签
  sign_reset_mode: 'rolling',
  // ── 插件内置化：原插件设置键收编 ──────────────────────────────────────────
  // texture-description
  textures_description_limit: '0',
  // google-adsense / gtag-js（前端注入）
  adsense_client_id: '',
  gtag_id: '',
  // mojang-verification
  mojang_verification_score_award: '0',
  // yggdrasil-api（10 项）
  ygg_uuid_algorithm: 'v4',
  ygg_token_expire_1: '604800',
  ygg_token_expire_2: '1209600',
  ygg_tokens_limit: '10',
  ygg_rate_limit: '1000',
  ygg_skin_domain: '',
  ygg_search_profile_max: '20',
  ygg_show_config_section: 'true',
  ygg_enable_ali: 'false',
  ygg_private_key: '',
  ygg_connect_enabled: 'false',
  oauth_enabled: 'true',
  ygg_disable_authserver: 'false',
  // 评论区（Workers AI 审核）
  comments_enabled: 'true',
  comments_ai_moderation: 'true',
  official_resources_auto_update: 'true',
  // restricted-email-domains（JSON 数组字符串）
  restricted_email_allow: '[]',
  restricted_email_deny: '[]',
  // sitemap 纳入的 URL 上限（纹理+玩家各取 min）
  sitemap_max_urls: '20000',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
