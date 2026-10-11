// 认证用户与应用上下文类型：所有层共用的身份模型。
import { type Bindings } from './env.ts';
import type { Context } from 'hono';
import type { Role } from '@pigeon-skin/shared';

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    /** 已认证用户；未登录为 null */
    user: AuthedUser | null;
    /** 本次请求的会话 id（sha256 后的），用于登出与轮换 */
    sessionId: string | null;
  };
}

export interface AuthedUser {
  readonly id: number;
  readonly email: string;
  readonly nickname: string;
  readonly role: Role;
  readonly score: number;
  readonly emailVerifiedAt: number | null;
  readonly locale: string | null;
  readonly isDarkMode: boolean;
  readonly avatarTextureId: number | null;
  readonly signature: string;
  readonly needsInitialization: boolean;
  /** 管理员禁用其提交举报（防滥用风控） */
  readonly reportingDisabled: boolean;
  /** 管理员禁用其发表评论（防滥用风控） */
  readonly commentsDisabled: boolean;
}

export type AppContext = Context<AppEnv>;

export function needsAccountInitialization(email: string, passwordHash: string, pending: boolean | number = false) {
  return !!pending || !email || !passwordHash || /@oauth\.(?:invalid|local)$/i.test(email);
}

/**
 * 对外暴露的用户字段序列化 —— **所有**把 user 放进 JSON 响应的出口都必须
 * 经过它。密码哈希等敏感列绝不出现；前端期望的是 emailVerified 布尔
 * （AuthedUser 的 emailVerifiedAt 是内部时间戳，直接透传会变成字段缺失）。
 */
export function toPublicUser(user: AuthedUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    score: user.score,
    emailVerified: user.emailVerifiedAt !== null,
    locale: user.locale,
    isDarkMode: user.isDarkMode,
    avatarTextureId: user.avatarTextureId,
    needsInitialization: user.needsInitialization,
    reportingDisabled: user.reportingDisabled,
    commentsDisabled: user.commentsDisabled,
  };
}
