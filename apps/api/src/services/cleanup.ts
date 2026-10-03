// 定时清理（Cron Triggers，见 wrangler.jsonc 的 triggers）。
//
// 目标是把"只增不删"的表压回去：
//   • sessions —— 过期/撤销的行已无语义（判定走 expires_at/revoked_at 的
//     WHERE 条件），留着只会拖慢 user_id 索引并占 D1 容量
//   • verification_tokens / password_reset_tokens —— 过期或已消费的行同理；
//     已消费的行保留 24h 再删，便于排查"令牌刚被谁用了"
//   • auth_attempts —— 登录失败计数窗口是 15 分钟，保留 7 天足够任何排查
//   • ygg_tokens —— 过期/过刷新线的令牌无验证价值
//   • ygg_log —— 保留 30 天（可配合 YGG_VERBOSE_LOG_DAYS 排查，默认批量压回）
//
// 幂等且可重入：每条 DELETE 都以时间为条件，重跑只是少删几行，没有副作用。
// 一次 cron 触发就是一批 D1 写，免费额度下每小时跑一次绰绰有余。
import type { Bindings } from '../env.ts';

/** 已消费令牌的保留时长（毫秒）。 */
export const CONSUMED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** auth_attempts 的保留时长（毫秒）。失败计数窗口 15 分钟，7 天足够排查。 */
export const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  sessions: number;
  verificationTokens: number;
  passwordResetTokens: number;
  authAttempts: number;
  yggTokens: number;
  yggLog: number;
}

export async function runCleanup(env: Bindings): Promise<CleanupResult> {
  const now = Date.now();
  const consumedCutoff = now - CONSUMED_TOKEN_RETENTION_MS;
  const attemptCutoff = now - ATTEMPT_RETENTION_MS;
  const yggLogCutoff = now - 30 * 24 * 60 * 60 * 1000;

  const results = await env.DB.batch([
    // 绝对过期、空闲过期、已撤销 —— 任一条件成立即无查询价值
    env.DB.prepare(
      `DELETE FROM sessions
       WHERE absolute_expires_at < ? OR expires_at < ? OR revoked_at IS NOT NULL`,
    ).bind(now, now),
    env.DB.prepare(
      `DELETE FROM verification_tokens WHERE expires_at < ? OR consumed_at < ?`,
    ).bind(now, consumedCutoff),
    env.DB.prepare(
      `DELETE FROM password_reset_tokens WHERE expires_at < ? OR consumed_at < ?`,
    ).bind(now, consumedCutoff),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE created_at < ?`)
      .bind(attemptCutoff),
    env.DB.prepare(`DELETE FROM ygg_tokens WHERE refresh_deadline < ?`)
      .bind(now),
    env.DB.prepare(`DELETE FROM ygg_log WHERE created_at < ?`)
      .bind(yggLogCutoff),
    env.DB.prepare('DELETE FROM ygg_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_interactions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_codes WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_devices WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_grants WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM oauth_login_states WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_responses WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM connect_refresh WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM security_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM security_reauth WHERE expires_at < ?').bind(now),
  ]);

  return {
    sessions: results[0]?.meta.changes ?? 0,
    verificationTokens: results[1]?.meta.changes ?? 0,
    passwordResetTokens: results[2]?.meta.changes ?? 0,
    authAttempts: results[3]?.meta.changes ?? 0,
    yggTokens: results[4]?.meta.changes ?? 0,
    yggLog: results[5]?.meta.changes ?? 0,
  };
}
