// 审计日志 —— 记录后台的破坏性/敏感操作。
//
// 只追加、不修改：审计的意义在于事后追溯，所以没有任何更新或删除入口。
// 表已经存在（migrations/0000_init.sql），这里补上写入侧。
//
// 为什么只记管理员的动作：普通用户操作有业务表本身的记录可查，
// 而管理员操作（封号、删用户、改设置）之前没有任何痕迹，出了争议无从对证。

import { auditLog } from '@pigeon-skin/db';
import { createDb } from '@pigeon-skin/db';
import type { Bindings } from '../env.ts';

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
  | 'admin.broadcast';

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
