// task_runs（后台「定时任务」页的运行记录）的写入口。
// 定时任务与 AI 任务队列都要写，抽出来共用；写入失败只记日志，不影响调用方的任务结果。

import { type Bindings } from './../core/env.ts';

/** D1 瞬态内部错误（如 "Internal error in D1 DB storage caused object to be reset"）：重试通常就过。 */
function isTransientDbError(e: unknown): boolean {
  return /Internal error in D1 DB storage|object to be reset|D1_ERROR: Internal/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * 写入一条任务运行结果。保留最近 50 条，避免表无限增长。
 * 记录本身失败不该影响任务结果：D1 偶发内部错误重试一次，仍失败只记日志。
 */
export async function writeTaskRun(env: Bindings, name: string, ok: boolean, detail: string, ranAt: number): Promise<void> {
  const insert = () => env.DB.prepare('INSERT INTO task_runs (name, ok, detail, ran_at) VALUES (?, ?, ?, ?)')
    .bind(name, ok ? 1 : 0, detail.slice(0, 500), ranAt)
    .run();
  try {
    await insert();
  } catch (e) {
    if (!isTransientDbError(e)) {
      console.error('task_runs 记录失败', name, e);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await insert();
    } catch (retryError) {
      console.error('task_runs 记录失败（重试后）', name, retryError);
      return;
    }
  }
  try {
    await env.DB.prepare(
      'DELETE FROM task_runs WHERE id NOT IN (SELECT id FROM task_runs ORDER BY ran_at DESC, id DESC LIMIT 50)',
    ).run();
  } catch (e) {
    console.warn('task_runs 清理失败', e);
  }
}
