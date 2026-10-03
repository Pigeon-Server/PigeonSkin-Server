// 共享契约 —— 跨前后端、跨 Worker 与迁移工具的唯一事实来源。
//
// 这里放的都是"双方必须一致"的东西：错误码、角色等级、业务限制常量。
// 一旦分散到各处，前后端校验就会漂移，而漂移的表现是用户看到莫名其妙的报错。

// ── 错误码 ───────────────────────────────────────────────────────────────────
// 后端只返回机器码，前端通过 i18next 映射为本地化文案（见 docs/rewrite D11）。
// 这样后端不需要知道任何一门语言，而前端能复用已有的翻译体系。

export const ERROR_CODES = [
  'security.invalid_code', 'security.challenge_expired', 'security.reauth_required',
  'security.unavailable', 'security.https_required', 'security.last_method',
  'security.email_change_required', 'security.method_exists',
  'auth.email_conflict',
  'manual.changed',
  'manual.asset_invalid', 'manual.asset_too_large', 'manual.asset_in_use',
  'pigeon.key_invalid', 'pigeon.scope_denied', 'pigeon.rate_limited',
  'votes.not_found', 'votes.closed', 'votes.already_voted', 'votes.changed',
  'votes.ineligible', 'votes.requirements_unavailable', 'votes.frozen', 'votes.disabled',
  'votes.legacy_review_required',
  'votes.export_limit',
  // 认证
  'auth.invalid_credentials',
  'auth.email_taken',
  'auth.player_name_taken',
  'auth.registration_disabled',
  'auth.too_many_registrations',
  'auth.captcha_required',
  'auth.captcha_failed',
  'auth.too_many_attempts',
  'auth.email_not_verified',
  'auth.mail_unavailable',
  'auth.invalid_token',
  'auth.token_expired',
  'auth.token_consumed',
  'auth.account_banned',
  'auth.session_expired',
  'auth.oauth_failed',
  'auth.oauth_denied',
  'auth.oauth_link_required',
  'auth.initialization_required',
  'auth.already_initialized',
  'auth.initialization_expired',
  'auth.oauth_unavailable',
  'auth.cannot_unbind_last',
  'comment.not_found',
  'comment.too_long',
  'comment.rejected',
  'comment.disabled',
  'auth.mojang_not_owned',
  'auth.mojang_already_verified',
  'auth.mojang_uuid_taken',
  'auth.mojang_not_verified',
  'email.domain_denied',
  'email.domain_not_allowed',
  'comment.rate_limited',
  'signature.too_long',
  // 用户与资料
  'user.not_found',
  'user.invalid_current_password',
  'user.email_unchanged',
  'user.nickname_invalid',
  'user.locale_unsupported',
  // 玩家
  'player.not_found',
  'player.name_invalid',
  'player.name_taken',
  'player.limit_reached',
  'player.texture_not_found',
  'player.texture_not_owned',
  'player.texture_wrong_kind',
  // 纹理
  'texture.not_found',
  'texture.changed',
  'integration.invalid_key',
  'auth.oauth_identity_taken',
  'texture.duplicate',
  'texture.name_invalid',
  'texture.file_missing',
  'texture.file_too_large',
  'texture.not_png',
  'texture.malformed',
  'texture.dimension_invalid',
  'texture.ratio_invalid',
  'texture.width_too_large',
  'texture.animated_not_supported',
  'texture.insufficient_score',
  'texture.private_access_denied',
  'texture.download_disabled',
  // 收藏
  'closet.not_found',
  'closet.already_collected',
  'closet.texture_private',
  'closet.insufficient_score',
  // 举报
  'report.already_reported',
  'report.self',
  'report.not_found',
  'report.already_reviewed',
  'report.reason_required',
  // 通知
  'notification.not_found',
  'notification.already_read',
  // 后台
  'admin.forbidden',
  'admin.cannot_modify_peer',
  'admin.cannot_modify_self',
  'admin.cannot_grant_role',
  'admin.invalid_role',
  // 通用
  'common.not_found',
  'common.forbidden',
  'common.unauthorized',
  'common.rate_limited',
  'common.invalid_request',
  'common.internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

/** 统一错误响应体。前端只依赖这三个字段。 */
export interface ApiErrorBody {
  readonly error: ErrorCode;
  readonly message?: string;
  /** 校验失败时的字段级细节，键为字段路径 */
  readonly fields?: Readonly<Record<string, string>>;
}

// ── 角色 ─────────────────────────────────────────────────────────────────────
// 旧版是 -1/0/1/2 的**有序等级**（不是权限位掩码），比较用 >=，因此角色累积。
// 保留这个语义：本产品从来只需要等级，不需要独立权限。

export const ROLES = ['banned', 'normal', 'admin', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

/** 等级数值。比较权限时用 roleRank(a) >= roleRank(b)。 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  banned: -1,
  normal: 0,
  admin: 1,
  super_admin: 2,
};

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

/** 旧库的 permission 整数 → 新角色 */
export function legacyPermissionToRole(permission: number): Role {
  switch (permission) {
    case -1: return 'banned';
    case 1: return 'admin';
    case 2: return 'super_admin';
    default: return 'normal';
  }
}

/** 能通过界面授予的角色。super_admin 只能由迁移工具或直接改库设置。 */
export const ASSIGNABLE_ROLES: readonly Role[] = ['banned', 'normal', 'admin'];

export function isAdmin(role: Role): boolean {
  return roleRank(role) >= ROLE_RANK.admin;
}

export function isSuperAdmin(role: Role): boolean {
  return roleRank(role) >= ROLE_RANK.super_admin;
}

/** a 是否有权修改 b（不能动同级或更高级别的人） */
export function canModifyUser(actor: Role, target: Role): boolean {
  return roleRank(actor) > roleRank(target);
}

// ── 业务限制 ─────────────────────────────────────────────────────────────────

export const LIMITS = {
  /** 密码长度。与旧版注册校验完全一致（min:8|max:32）。 */
  passwordMinLength: 8,
  passwordMaxLength: 32,

  /** 邮箱长度。旧列是 VARCHAR(100)，但旧版没有校验，超长会在数据库层失败。 */
  emailMaxLength: 100,

  /** 昵称长度。旧列是 VARCHAR(50)。 */
  nicknameMaxLength: 50,

  /** 纹理名长度。旧列是 VARCHAR(50)。 */
  textureNameMaxLength: 50,

  /** 玩家名长度。旧版默认 3–16，可由设置覆盖。 */
  playerNameMinLength: 3,
  playerNameMaxLength: 16,

  /** 上传大小上限（KB）。旧版默认 1024。 */
  maxUploadSizeKb: 1024,

  /** 纹理宽度上限。旧版默认 8192。 */
  maxTextureWidth: 8192,

  /** 纹理面积上限（像素）。独立的解压缩炸弹防护：8192×8192 是 6700 万像素。 */
  maxTextureArea: 16_777_216,

  /** PNG chunk 数量上限，防 chunk 洪水。 */
  maxPngChunks: 256,

  /** 分页每页条数上限，防止客户端拉爆。 */
  maxPageSize: 100,
  defaultPageSize: 24,

  /** 头像/预览衍生图的白名单尺寸。旧版接受任意整数，会被用来撑爆存储。 */
  derivativeSizes: [36, 45, 64, 100, 200] as const,
  /** 服务端生成衍生图时允许解码的源图面积上限（DO 内存约束；皮肤实际 ≤ 128²） */
  maxDerivativeSourceArea: 1_048_576,

  /** 会话空闲过期（秒）—— 与旧版 SESSION_LIFETIME=120 分钟一致 */
  sessionIdleSeconds: 2 * 60 * 60,
  /** 会话绝对过期（秒） */
  sessionAbsoluteSeconds: 30 * 24 * 60 * 60,
  /** "记住我"的绝对过期（秒） */
  sessionRememberSeconds: 90 * 24 * 60 * 60,
  /** 滑动续期的最小间隔（秒）—— 这是控制 D1 写量的关键 */
  sessionRenewIntervalSeconds: 15 * 60,

  /** 邮箱验证令牌有效期（秒）。旧版是永久有效，这里是有意收紧。 */
  verificationTokenSeconds: 24 * 60 * 60,
  /** 密码重置令牌有效期（秒）。旧版是 1 小时。 */
  passwordResetTokenSeconds: 60 * 60,

  /** 登录失败多少次后要求验证码（旧版是 3 次） */
  captchaAfterFailures: 3,
  /** 登录失败计数窗口（秒） */
  loginFailureWindowSeconds: 15 * 60,

  /** 同一 IP 的发信间隔（秒） */
  emailSendIntervalSeconds: 60,
  /** 找回密码的按 IP 限流（秒）—— 与旧版的 180 秒一致 */
  passwordResetIntervalSeconds: 180,
} as const;

// ── 纹理类型 ─────────────────────────────────────────────────────────────────
// 旧版用单一 type 字段存 steve/alex/cape。新版拆成 kind + model，
// 因为 CSL 响应里的键名（default/slim）只取决于 skin 的 model，与 cape 无关。

export const TEXTURE_KINDS = ['skin', 'cape'] as const;
export type TextureKind = (typeof TEXTURE_KINDS)[number];

export const TEXTURE_MODELS = ['default', 'slim'] as const;
export type TextureModel = (typeof TEXTURE_MODELS)[number];

/** CSL 协议里 skins 对象的键名 */
export type CslSkinModel = TextureModel;

/** 旧 type → 新 (kind, model) */
export function legacyTextureTypeToKindModel(
  legacyType: string,
): { kind: TextureKind; model: TextureModel | null } {
  switch (legacyType) {
    case 'alex': return { kind: 'skin', model: 'slim' };
    case 'cape': return { kind: 'cape', model: null };
    case 'steve':
    default: return { kind: 'skin', model: 'default' };
  }
}

/** 新 (kind, model) → 旧 type，用于兼容旧接口 */
export function kindModelToLegacyTextureType(
  kind: TextureKind,
  model: TextureModel | null,
): 'steve' | 'alex' | 'cape' {
  if (kind === 'cape') return 'cape';
  return model === 'slim' ? 'alex' : 'steve';
}

export const TEXTURE_VISIBILITIES = ['public', 'private'] as const;
export type TextureVisibility = (typeof TEXTURE_VISIBILITIES)[number];

// ── 玩家名规则 ───────────────────────────────────────────────────────────────
// 与旧版 app/Rules/PlayerName.php 完全一致。

export const PLAYER_NAME_RULES = ['official', 'cjk', 'utf8', 'custom'] as const;
export type PlayerNameRule = (typeof PLAYER_NAME_RULES)[number];

const PLAYER_NAME_PATTERNS: Readonly<Record<Exclude<PlayerNameRule, 'custom'>, RegExp>> = {
  official: /^[A-Za-z0-9_]+$/,
  cjk: /^[A-Za-z0-9_§\u4e00-\u9fff]+$/u,
  // utf8 规则在旧版是"合法 UTF-8 且不含空白字符"
  utf8: /^\S+$/u,
};

export function isValidPlayerName(
  name: string,
  rule: PlayerNameRule,
  customPattern?: string,
): boolean {
  if (name.length === 0) return false;
  if (rule === 'custom') {
    if (!customPattern) return true;
    try {
      return new RegExp(customPattern, 'u').test(name);
    } catch {
      // 运维写的正则非法时不应放行全部
      return false;
    }
  }
  return PLAYER_NAME_PATTERNS[rule].test(name);
}

// ── 可见性范围 ───────────────────────────────────────────────────────────────
// 旧版的规则：匿名只看公开；用户看公开 ∪ 自己的；管理员看全部。

export interface ViewerContext {
  readonly userId: number | null;
  readonly role: Role | null;
}

export function canViewTexture(
  texture: { readonly visibility: TextureVisibility; readonly uploaderId: number | null },
  viewer: ViewerContext,
): boolean {
  if (texture.visibility === 'public') return true;
  if (viewer.userId !== null && texture.uploaderId === viewer.userId) return true;
  return viewer.role !== null && isAdmin(viewer.role);
}
export * from './locale.ts';
