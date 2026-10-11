// isolate 内的会话状态缓存。
//
// JWT 让"这个请求是谁"变成零成本验签，但撤销/封禁/改密的强一致语义仍由
// D1 sessions 行保证。为不把每次验签都变成一次查库，这里把最近确认过的
// 会话状态缓存 30 秒：撤销生效最多延迟一个 TTL（已接受），热路径 D1 读
// 从"每请求一次"降到"每用户每 isolate 每 30 秒一次"。
//
// 缓存必须有上限：长期驻留的 isolate 里无界 Map 会随访问用户数线性膨胀。
// 用插入序充当 LRU 序，容量满时淘汰最旧条目。
import type { AuthedUser } from '../lib.ts';

interface Entry { user: AuthedUser; at: number }

const TTL_MS = 30_000;
const CAPACITY = 500;
const entries = new Map<string, Entry>();

export function cachedAuthedUser(sessionId: string): AuthedUser | null {
  const hit = entries.get(sessionId);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    entries.delete(sessionId);
    return null;
  }
  entries.delete(sessionId);
  entries.set(sessionId, hit);
  return hit.user;
}

export function cacheAuthedUser(sessionId: string, user: AuthedUser): void {
  entries.delete(sessionId);
  while (entries.size >= CAPACITY) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  entries.set(sessionId, { user, at: Date.now() });
}

/** 本 isolate 内撤销单个会话后立即使缓存失效（跨 isolate 靠 TTL 兜底） */
export function invalidateCachedSession(sessionId: string): void {
  entries.delete(sessionId);
}

/** 撤销某用户全部会话后按用户失效（revokeAllSessions 场景） */
export function invalidateCachedSessionsOf(userId: number): void {
  for (const [key, entry] of entries) if (entry.user.id === userId) entries.delete(key);
}

/** 仅测试用：isolatedStorage 重置数据库后，isolate 内的缓存必须一并作废 */
export function resetAuthCacheForTests(): void {
  entries.clear();
}
