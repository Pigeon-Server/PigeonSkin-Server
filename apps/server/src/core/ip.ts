// 客户端 IP 提取。
import type { AppContext } from './user.ts';

/** 取客户端 IP。Cloudflare 设 cf-connecting-ip；Node 部署在反代后面取
 *  x-forwarded-for 的第一跳（自行直连时二者都没有，回落 unknown——
 *  与 Worker 上非 Cloudflare 请求的行为一致）。 */
export function clientIp(c: AppContext): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}
