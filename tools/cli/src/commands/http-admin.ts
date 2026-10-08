// 管理级 HTTP 通道 —— 复用 http-import.ts 的通道抽象（resolveHttpChannel），
// 为 users/settings 命令提供通用 JSON 请求封装（429 Retry-After 有界重试）。

import { flagString } from '../lib/args.ts';
import type { TargetEnv } from '../lib/env.ts';

export interface HttpChannel {
  readonly siteUrl: string;
  readonly apiKey: string;
  readonly concurrency: number;
}

/** 解析 HTTP 通道参数：--api-key 缺省返回 null（回落 wrangler 通道）；
 * --site-url 缺省按环境推断（production 必须显式给，dev 默认本地 8787） */
export function resolveHttpChannel(env: TargetEnv, flags: ReadonlyMap<string, string | true>): HttpChannel | null {
  const apiKey = flagString(flags, 'api-key');
  if (apiKey === undefined) return null;
  if (apiKey === '') throw new Error('--api-key 需要一个值（管理界面「Pigeon API」签发，scope 见 USAGE）');
  const siteUrl = (flagString(flags, 'site-url') ?? (env.name === 'production' ? '' : 'http://127.0.0.1:8787')).replace(/\/+$/, '');
  if (!siteUrl) throw new Error('--env production 时需要 --site-url <https://站点地址>');
  return { siteUrl, apiKey, concurrency: 4 };
}

/** 裸 --api-key（无值）显式报错，避免静默回落 wrangler 通道 */
export function assertApiKeyValued(flags: ReadonlyMap<string, string | true>): void {
  if (flags.get('api-key') === true) {
    throw new Error('--api-key 需要一个值（管理界面「Pigeon API」签发）');
  }
}

export interface AdminRequestResult {
  status: number;
  body: Record<string, unknown>;
}

/** 发起一次管理 API 请求；429 按 Retry-After 等待后有界重试 */
export async function adminRequest(
  channel: HttpChannel,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  jsonBody?: unknown,
): Promise<AdminRequestResult> {
  const url = `${channel.siteUrl}${path}`;
  const doFetch = async (): Promise<{ status: number; retryAfter: number | null; body: Record<string, unknown> }> => {
    const res = await fetch(url, {
      method,
      headers: {
        'api-key': channel.apiKey,
        ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const retryAfterText = res.headers.get('retry-after');
    const retryAfter = retryAfterText !== null && Number.isFinite(Number(retryAfterText)) ? Number(retryAfterText) : null;
    return { status: res.status, retryAfter, body };
  };

  const MAX_RETRIES = 20;
  let attempt = await doFetch();
  for (let retry = 0; attempt.status === 429 && retry < MAX_RETRIES; retry++) {
    const waitSeconds = Math.min(Math.max(attempt.retryAfter ?? 5, 1), 120);
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    attempt = await doFetch();
  }
  return { status: attempt.status, body: attempt.body };
}

/** 期望 2xx 否则抛错；返回 body */
export function expectOk(result: AdminRequestResult, what: string): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    const detail = (result.body['error'] ?? result.body['msg'] ?? '') as string;
    throw new Error(`${what} 失败（HTTP ${result.status}）: ${detail}`);
  }
  return result.body;
}
