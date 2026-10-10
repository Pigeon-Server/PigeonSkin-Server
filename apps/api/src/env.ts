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
  /** 皮肤库反爬：匿名访客桶（按 IP 计数，默认 60 req/min） */
  RL_SKINLIB?: { limit(params: { key: string }): Promise<{ success: boolean }> };
  /** 皮肤库反爬：登录用户桶（按账号计数，默认 300 req/min） */
  RL_SKINLIB_USER?: { limit(params: { key: string }): Promise<{ success: boolean }> };

  // ── 运行环境与业务配置的兼容绑定 ────────────────────────────────────────
  ENVIRONMENT: 'development' | 'preview' | 'production';
  /** 规范 Origin，用于邮件链接与绝对 URL */
  APP_URL: string;
  MAIL_FROM: string;
  /** 邮件驱动：resend（HTTP API）或 smtp（直连 SMTP，走 cloudflare:sockets） */
  MAIL_DRIVER?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_ENCRYPTION?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  /** Turnstile 开关。自托管部署可关掉。已由 CAPTCHA_DRIVER 取代，仅迁移期读取。 */
  TURNSTILE_ENABLED: string;
  /** 是否下发预生成的衍生图 */
  DERIVATIVES_ENABLED: string;
  OFFICIAL_CATALOG_ENABLED?: string;
  /** 限流开关 */
  RATE_LIMIT_ENABLED?: string;
  /** 皮肤库反爬守卫开关（默认开）。关闭后皮肤库不再限流与挑战 */
  SKINLIB_GUARD_ENABLED?: string;

  // ── Secrets（wrangler secret put）────────────────────────────────────────
  /** 会话与签名链接的签名密钥 */
  SESSION_SECRET?: string;
  MFA_ENCRYPTION_KEY?: string;
  SETUP_TOKEN?: string;
  DEPLOY_HOOK_URL?: string;
  UPDATE_MANIFEST_URL?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /** 人机验证驱动：'' 关闭 | turnstile | recaptcha_v2 | recaptcha_v3 | tencent | aliyun */
  CAPTCHA_DRIVER?: string;
  CAPTCHA_SITE_KEY?: string;
  CAPTCHA_SECRET?: string;
  ALIYUN_CAPTCHA_ACCESS_KEY_ID?: string;
  /** reCAPTCHA v3 可信度分数阈值（0–100，50 = 0.50） */
  RECAPTCHA_V3_THRESHOLD?: string;
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

  // ── Node 自托管部署的 LLM 审核配置（Workers 上不存在，无绑定即 fail-open）──
  /** workers（默认，用平台 AI 绑定）| openai（任意 OpenAI 兼容端点）| anthropic | systemone（判别模型） */
  AI_MODERATION_DRIVER?: string;
  OPENAI_API_KEY?: string;
  /** 默认 https://api.openai.com/v1；可指向 Ollama/vLLM/OpenRouter 等 */
  OPENAI_BASE_URL?: string;
  OPENAI_MODERATION_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODERATION_MODEL?: string;
  /** TypeSafe System One（Jev 判别模型）API Key */
  TYPESAFE_API_KEY?: string;
  /** Node 自托管经 Cloudflare REST API 调用 Clef 判别模型时的账户与凭据 */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
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
  allow_anonymous_download: 'true',
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

  // ── AI 网关（ai-gateway.ts 任务注册表的可配置项）──────────────────────────
  // 全局并发上限：单次 processDueJobs 同时执行的 LLM 调用数
  ai_max_concurrency: '2',
  // 材质名/简介：AI 翻译与 AI 审核（默认关，需要管理员显式开启）
  texture_ai_translation: 'false',
  texture_ai_moderation: 'false',
  // 站点公告：AI 翻译（默认关，需要管理员显式开启）
  notification_ai_translation: 'false',
  // 单次 AI 调用超时（秒）。自托管推理模型（Qwen/DeepSeek-R1）可能远慢于托管 API
  ai_timeout_seconds: '25',
  // 思考模式：default=随模型；disabled=禁用思考（Qwen3 enable_thinking=false，快且直接输出结论）；
  // enabled=强制开启。仅对 OpenAI 兼容驱动通过 chat_template_kwargs 下发
  ai_reasoning: 'default',

  official_resources_auto_update: 'true',
  // restricted-email-domains（JSON 数组字符串）
  restricted_email_allow: '[]',
  restricted_email_deny: '[]',
  // sitemap 纳入的 URL 上限（纹理+玩家各取 min）
  sitemap_max_urls: '20000',

  // ── AI 网关每任务的可覆盖项 ────────────────────────────────────────────────
  // 键形如 ai_<task>_model / ai_<task>_prompt / ai_<task>_mode，空 = 用
  // ai-gateway.ts AI_JOB_DEFINITIONS 里的内置默认。
  ai_comments_moderation_model: '',
  ai_comments_moderation_prompt: '',
  ai_comments_moderation_mode: '',
  ai_texture_translate_model: '',
  ai_texture_translate_prompt: '',
  ai_texture_moderate_model: '',
  ai_texture_moderate_prompt: '',
  ai_texture_moderate_mode: '',
  // ── 判别模型驱动（System One / Clef）──────────────────────────────────────
  // 判别模型 noul 概率 ≥ 阈值判定违规。按整数百分数存储（10–90），50 = 0.5
  ai_discriminative_threshold: '50',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
