// 审计日志 —— 记录后台的破坏性/敏感操作。
//
// 只追加、不修改：审计的意义在于事后追溯，所以没有任何更新或删除入口。
// 表已经存在（migrations/0000_init.sql），这里补上写入侧。
//
// 为什么只记管理员的动作：普通用户操作有业务表本身的记录可查，
// 而管理员操作（封号、删用户、改设置）之前没有任何痕迹，出了争议无从对证。

import { type Bindings } from './../core/env.ts';
import { auditLog } from '@pigeon-skin/db';
import { chunkBind, createDb } from '@pigeon-skin/db';

export type AuditAction =
  | 'admin.search.submit'
  | 'admin.pigeon.key.create'
  | 'admin.pigeon.key.update'
  | 'admin.vote.create'
  | 'admin.vote.update'
  | 'admin.vote.publish'
  | 'admin.vote.close'
  | 'admin.vote.cancel'
  | 'admin.vote.archive'
  | 'admin.vote.export'
  | 'admin.user.create'
  | 'admin.user.update'
  | 'admin.user.delete'
  | 'admin.user.revoke_sessions'
  | 'admin.user.reset_password'
  | 'admin.player.update'
  | 'admin.player.delete'
  | 'admin.texture.delete'
  | 'admin.texture.update'
  | 'admin.texture.import'
  | 'admin.closet.delete'
  | 'admin.report.resolve'
  | 'admin.comment.delete'
  | 'admin.settings.update'
  | 'admin.live2d.upload'
  | 'admin.live2d.update'
  | 'admin.translation.update'
  | 'admin.translation.delete'
  | 'admin.update.deploy'
  | 'admin.closet.add'
  | 'admin.broadcast'
  | 'admin.ai_jobs.retry'
  | 'admin.ai_jobs.cancel'
  | 'admin.ai_jobs.backfill'
  | 'admin.texture_flags.clear'
  | 'admin.search_submissions.retry';

/**
 * 写一条审计记录。
 *
 * 刻意不抛异常：审计是旁观者，不能让"记录失败"挡住管理员已经做出的
 * 业务动作 —— 那会把故障从"少一条日志"放大成"整个后台不可用"。
 */
export async function audit(
  env: { DB: Bindings['DB'] },
  entry: {
    actorId: number | null;
    action: AuditAction;
    targetType?: string | undefined;
    targetId?: number | null | undefined;
    detail?: string | undefined;
  },
): Promise<void> {
  try {
    await createDb(env.DB).insert(auditLog).values({
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: entry.detail ?? null,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.error('audit_log 写入失败', e);
  }
}

/**
 * 批量审计：每条目标各留一行记录（与逐条操作的可追溯性一致），但按多行
 * INSERT 分片写入 —— 批量治理一次点掉几十条时，逐条调用会把子请求乘上条数。
 * 每片 10 行：6 个绑定列 × 10 行 = 60，留在单查询 100 个绑定参数以内。
 */
export async function auditBatch(
  env: { DB: Bindings['DB'] },
  entries: ReadonlyArray<{
    actorId: number | null;
    action: AuditAction;
    targetType?: string | null | undefined;
    targetId?: number | null | undefined;
    detail?: string | null | undefined;
  }>,
): Promise<void> {
  if (!entries.length) return;
  try {
    const database = createDb(env.DB);
    const now = Date.now();
    for (const part of chunkBind(entries, 10)) {
      await database.insert(auditLog).values(part.map(entry => ({
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? null,
        createdAt: now,
      })));
    }
  } catch (e) {
    console.error('audit_log 写入失败', e);
  }
}
