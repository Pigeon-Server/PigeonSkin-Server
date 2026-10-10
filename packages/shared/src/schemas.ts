// 输入 schema —— 前后端共用。
//
// 这一层的意义：同一份 schema 同时给出运行时校验、TypeScript 类型，
// 以及前端表单可以复用的校验规则。如果前后端各写一份，它们必然漂移，
// 而漂移的表现是"前端说合法、后端说非法"这种最招人烦的 bug。
//
// 后端用它校验请求体/查询参数（framework.ts 的 readJson/readQuery），
// 前端用它做提交前检查。
import { z } from 'zod';
import {
  LIMITS, PLAYER_NAME_RULES, TEXTURE_KINDS, TEXTURE_MODELS, TEXTURE_VISIBILITIES, ROLES,
} from './index.ts';

// ── 基础字段 ─────────────────────────────────────────────────────────────────

/** 邮箱：与后端一致的长度上限（旧列是 VARCHAR(100) 但旧版没校验） */
export const emailSchema = z.string().trim().min(1).max(LIMITS.emailMaxLength).email().refine(email => !/@oauth\.(?:invalid|local)$/i.test(email));

/**
 * 密码：8–32 位，与旧版注册校验完全一致。
 * 不做字符类别要求 —— 实践上那只会把用户推向 `Password1!`，反而降低熵。
 */
export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMinLength)
  .max(LIMITS.passwordMaxLength);

export const nicknameSchema = z.string().trim().min(1).max(LIMITS.nicknameMaxLength);

export const playerNameSchema = z.string().trim().min(1).max(50);
export const textureNameSchema = z.string().trim().min(1).max(LIMITS.textureNameMaxLength);

/** 数据库主键：正整数 */
export const idSchema = z.coerce.number().int().positive();

export const textureKindSchema = z.enum(TEXTURE_KINDS);
export const textureModelSchema = z.enum(TEXTURE_MODELS);
export const textureVisibilitySchema = z.enum(TEXTURE_VISIBILITIES);
export const roleSchema = z.enum(ROLES);
/** 可通过界面授予的角色。super_admin 有意排除在外。 */
export const assignableRoleSchema = z.enum(['banned', 'normal', 'admin']);

export const playerNameRuleSchema = z.enum(PLAYER_NAME_RULES);

// ── 分页与列表查询 ───────────────────────────────────────────────────────────

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
});

export const textureListQuerySchema = paginationQuerySchema.extend({
  kind: textureKindSchema.optional(),
  model: z.enum(['default', 'slim']).optional(),
  uploader: idSchema.optional(),
  official: z.enum(['true', 'false']).optional(),
  /** 搜索表达式（见 packages/shared/src/search）：普通词、字段限定、布尔条件 */
  keyword: z.string().trim().max(500).optional(),
  sort: z.enum(['created', 'likes']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  /** 展示语言：传入时材质名按 AI 译文覆盖（无译文回退原文） */
  locale: z.string().trim().max(10).optional(),
});

export const closetListQuerySchema = z.object({
  category: textureKindSchema.optional(),
  /** 搜索表达式（见 packages/shared/src/search）：普通词、字段限定、布尔条件 */
  keyword: z.string().trim().max(500).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export const adminListQuerySchema = paginationQuerySchema.extend({
  /** 搜索表达式（见 packages/shared/src/search） */
  q: z.string().trim().max(500).optional(),
});

export const reportListQuerySchema = z.object({
  status: z.enum(['pending', 'resolved', 'rejected']).optional(),
});

// ── 认证 ─────────────────────────────────────────────────────────────────────

export const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** 当设置要求按玩家名注册时必填 */
  playerName: playerNameSchema.optional(),
  /** 当设置不要求玩家名时必填 */
  nickname: nicknameSchema.optional(),
  captchaToken: z.string().max(4096).optional(),
  /** 腾讯云验证码与 ticket 配对的 Randstr；其他驱动不传 */
  captchaRandstr: z.string().max(200).optional(),
});

export const loginInputSchema = z.object({
  destination: z.string().max(2000).optional(),
  /** 邮箱或玩家名 —— 旧版两种都接受，Minecraft 用户记得住名字记不住邮箱 */
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
  keep: z.boolean().optional(),
  captchaToken: z.string().max(4096).optional(),
  captchaRandstr: z.string().max(200).optional(),
  retainUserId: idSchema.optional(),
  conflictPasswords: z.array(z.object({ userId: idSchema, password: z.string().min(1).max(256) })).max(8).optional(),
});

export const forgotPasswordInputSchema = z.object({
  email: emailSchema,
  captchaToken: z.string().max(4096).optional(),
  captchaRandstr: z.string().max(200).optional(),
});

export const resetPasswordInputSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const verifyEmailInputSchema = z.object({
  token: z.string().min(1),
});

// ── 用户 ─────────────────────────────────────────────────────────────────────

export const updateProfileInputSchema = z.object({
  nickname: nicknameSchema.optional(),
  email: emailSchema.optional(),
  locale: z.string().max(20).optional(),
  isDarkMode: z.boolean().optional(),
  signature: z.string().max(500).optional(),
});

export const changePasswordInputSchema = z.object({
  currentPassword: z.string(),
  newPassword: passwordSchema,
});

export const setAvatarInputSchema = z.object({
  /** 0 或 null 表示清除头像，回到默认 */
  textureId: z.union([idSchema, z.literal(0), z.null()]),
});

// ── 玩家 ─────────────────────────────────────────────────────────────────────

export const playerCreateInputSchema = z.object({
  name: playerNameSchema,
});

export const playerRenameInputSchema = z.object({
  name: playerNameSchema,
});

export const playerTexturesInputSchema = z.object({
  /** 纹理 id；null 或 0 表示清除 */
  skin: z.union([idSchema, z.literal(0), z.null()]).optional(),
  cape: z.union([idSchema, z.literal(0), z.null()]).optional(),
});

// ── 纹理 ─────────────────────────────────────────────────────────────────────

export const texturePatchInputSchema = z.object({
  name: textureNameSchema.optional(),
  visibility: textureVisibilitySchema.optional(),
  kind: textureKindSchema.optional(),
  model: z.enum(['default', 'slim']).optional(),
});

// ── 收藏与举报 ───────────────────────────────────────────────────────────────

export const closetAddInputSchema = z.object({
  textureId: idSchema,
  name: textureNameSchema.optional(),
});

export const closetRenameInputSchema = z.object({
  name: z.string().trim().max(LIMITS.textureNameMaxLength),
});

export const reportSubmitInputSchema = z.object({
  textureId: idSchema,
  reason: z.string().trim().min(1).max(1000),
  captchaToken: z.string().max(4096).optional(),
  /** 腾讯云验证码与 ticket 配对的 Randstr；其他驱动不传 */
  captchaRandstr: z.string().max(200).optional(),
});

export const reportResolveInputSchema = z.object({
  action: z.enum(['delete', 'ban', 'reject']),
});

// ── 后台 ─────────────────────────────────────────────────────────────────────

export const adminPatchUserInputSchema = z.object({
  nickname: nicknameSchema.optional(),
  email: emailSchema.optional(),
  score: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  role: assignableRoleSchema.optional(),
  emailVerified: z.boolean().optional(),
  /** 禁用其提交举报（防滥用） */
  reportingDisabled: z.boolean().optional(),
  /** 禁用其发表评论（防滥用） */
  commentsDisabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '至少要改一个字段' });

/** 管理员创建用户 */
export const adminCreateUserInputSchema = z.object({
  email: emailSchema,
  nickname: nicknameSchema,
  password: passwordSchema,
  role: assignableRoleSchema.optional(),
});

export const adminPatchPlayerInputSchema = z.object({
  name: playerNameSchema.optional(),
  ownerId: idSchema.optional(),
  skin: z.union([idSchema, z.literal(0), z.null()]).optional(),
  cape: z.union([idSchema, z.literal(0), z.null()]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '至少要改一个字段' });

export const adminBroadcastInputSchema = z.object({
  title: z.string().trim().min(1).max(20),
  content: z.string().max(10_000).default(''),
  /** 'all' | 'normal' | 数字 uid | 邮箱 */
  receiver: z.union([z.literal('all'), z.literal('normal'), idSchema, emailSchema]),
  sendEmail: z.boolean().default(false),
});

/**
 * 批量写设置。
 *
 * value 收窄为标量联合类型而不是 z.unknown()：设置值本来就只可能是
 * 字符串/数字/布尔，用 unknown 会让它变成可选字段（unknown 包含 undefined），
 * 从而无法在类型层面保证"每条写入都带了值"。
 * 具体取值范围由服务端的设置注册表校验，因为同一个键在不同类型下规则不同。
 */
/** restricted-email-domains 的名单写入体 */
export const restrictedEmailListSchema = z.object({
  domains: z.array(z.string().trim().min(1).max(253).toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)).max(1000),
});

export const adminSettingsInputSchema = z.object({
  settings: z.array(z.object({
    key: z.string().trim().min(1).max(60),
    locale: z.string().trim().max(20).optional(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })).min(1).max(100),
});

export const publicSettingsQuerySchema = z.object({
  locale: z.string().trim().max(20).optional(),
});

// ── 推导类型（前端可直接用）──────────────────────────────────────────────────

export type RegisterInput = z.infer<typeof registerInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type PlayerCreateInput = z.infer<typeof playerCreateInputSchema>;
export type PlayerTexturesInput = z.infer<typeof playerTexturesInputSchema>;
export type TexturePatchInput = z.infer<typeof texturePatchInputSchema>;
export type TextureListQuery = z.infer<typeof textureListQuerySchema>;
export type ClosetAddInput = z.infer<typeof closetAddInputSchema>;
export type ReportSubmitInput = z.infer<typeof reportSubmitInputSchema>;
export type ReportResolveInput = z.infer<typeof reportResolveInputSchema>;
export type AdminPatchUserInput = z.infer<typeof adminPatchUserInputSchema>;
export type AdminBroadcastInput = z.infer<typeof adminBroadcastInputSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
