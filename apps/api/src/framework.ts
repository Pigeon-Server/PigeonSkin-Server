// 应用框架 —— 路由层共用的原语：错误、权限断言、输入校验、分页。
//
// 分层：
//   HTTP 路由（本文件的原语）
//     → service（业务规则，抛 AppError 表达失败）
//       → repository（Drizzle 查询）
//
// 关键约定：**业务失败用抛 AppError 表达，不用返回值**。
// 这样 service 里就不必层层传递错误分支，路由也不必逐个 if 判断。
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { roleRank, type ErrorCode } from '@pigeon-skin/shared';
import type { AppEnv, AuthedUser } from './lib.ts';
export { isAdmin } from './services/authorization.ts';

/** 可用的 HTTP 状态码（业务语义都收敛在这几个上） */
export type HttpStatus = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

// ── 错误 ─────────────────────────────────────────────────────────────────────

/** 业务失败。抛出它，由 onError 统一转成响应。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpStatus;
  readonly fields: Record<string, string>;

  constructor(
    code: ErrorCode,
    status: HttpStatus = 400,
    message?: string,
    fields?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.fields = fields ?? {};
  }
}

// 常用错误的语义化构造器，避免到处写状态码
export const fail = {
  unauthorized: () => new AppError('common.unauthorized', 401),
  forbidden: (code: ErrorCode = 'common.forbidden') => new AppError(code, 403),
  notFound: (code: ErrorCode = 'common.not_found') => new AppError(code, 404),
  conflict: (code: ErrorCode) => new AppError(code, 409),
  invalid: (code: ErrorCode = 'common.invalid_request', fields?: Record<string, string>) =>
    new AppError(code, 422, undefined, fields),
  /** 积分不足。语义上更接近"需要付费"而不是"请求非法"。 */
  insufficientScore: () => new AppError('texture.insufficient_score', 402),
};

/**
 * 统一错误处理。挂在 app.onError 上。
 *
 * Zod 的校验失败也在这里转成 422 + 字段级细节，所以路由里不需要 try/catch。
 */
export function toErrorResponse(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return c.json({
      error: err.code,
      ...(err.message !== err.code ? { message: err.message } : {}),
      ...(Object.keys(err.fields).length > 0 ? { fields: err.fields } : {}),
    }, err.status);
  }

  if (err instanceof ZodError) {
    // 把 Zod 的问题列表压成 { 字段路径: 问题码 } —— 前端只依赖这个形状
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const path = issue.path.join('.') || '_';
      fields[path] ??= issue.code;
    }
    return c.json({ error: 'common.invalid_request', fields }, 422);
  }

  console.error('未处理的错误:', err);
  return c.json({ error: 'common.internal_error' }, 500);
}

// ── 身份与权限 ───────────────────────────────────────────────────────────────

/** 取当前用户；未登录抛 401 */
export function currentUser(c: Context<AppEnv>): AuthedUser {
  const user = c.get('user');
  if (!user) throw fail.unauthorized();
  return user;
}

/** 取当前用户，但要求是管理员 */
export function currentAdmin(c: Context<AppEnv>): AuthedUser {
  const user = currentUser(c);
  if (roleRank(user.role) < roleRank('admin')) throw fail.forbidden('admin.forbidden');
  return user;
}

// ── 输入校验 ─────────────────────────────────────────────────────────────────
// 用 Zod schema 而不是手写 typeof 判断：schema 同时给出运行时校验与静态类型，
// 而且前后端可以共用同一份（packages/shared/src/schemas.ts）。

export async function readJson<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw fail.invalid();
  }
  return schema.parse(raw);
}

/** 读 JSON，但允许 body 为空（用于 PATCH 这类全字段可选的接口） */
export async function readJsonOptional<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  return schema.parse(raw);
}

export function readQuery<T>(c: Context<AppEnv>, schema: ZodType<T>): T {
  return schema.parse(c.req.query());
}

// ── 分页 ─────────────────────────────────────────────────────────────────────

export interface Pagination {
  readonly page: number;
  readonly perPage: number;
  readonly offset: number;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly totalPages: number;
}

export function readPagination(
  c: Context<AppEnv>,
  opts: { defaultPerPage?: number; maxPerPage?: number } = {},
): Pagination {
  const defaultPerPage = opts.defaultPerPage ?? 24;
  const maxPerPage = opts.maxPerPage ?? 100;
  const rawPage = Number(c.req.query('page') ?? 1);
  const rawPerPage = Number(c.req.query('per_page') ?? defaultPerPage);
  if (!Number.isSafeInteger(rawPage) || rawPage < 1 || rawPage > 10_000) throw fail.invalid();
  if (!Number.isSafeInteger(rawPerPage) || rawPerPage < 1) throw fail.invalid();
  const page = rawPage;
  const perPage = Math.min(maxPerPage, rawPerPage);
  return { page, perPage, offset: (page - 1) * perPage };
}

export function paginate<T>(items: readonly T[], total: number, p: Pagination): Paged<T> {
  return {
    items,
    page: p.page,
    perPage: p.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / p.perPage)),
  };
}
