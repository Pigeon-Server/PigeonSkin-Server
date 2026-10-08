// 管理导入 HTTP 通道 —— 经站点的 /api/v1/pigeon/admin/import/textures 端点上传，
// 一个 warm 连接跑完整个批次（对比 wrangler 每对象一次冷启动的 5-40 秒）。
// 鉴权用管理 API key（scope: admin.texture.import，admin 界面可签发）。

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flagString } from '../lib/args.ts';
import type { TargetEnv } from '../lib/env.ts';

export interface HttpChannel {
  readonly siteUrl: string;
  readonly apiKey: string;
  readonly concurrency: number;
}

export interface HttpUploadResult {
  id: number;
  hash: string;
  existing: boolean;
}

/** 解析 HTTP 通道参数：--api-key 必需，--site-url 缺省按环境推断 */
export function resolveHttpChannel(env: TargetEnv, flags: ReadonlyMap<string, string | true>): HttpChannel | null {
  const apiKey = flagString(flags, 'api-key');
  if (apiKey === undefined) return null;
  const siteUrl = (flagString(flags, 'site-url') ?? (env.name === 'production' ? '' : 'http://127.0.0.1:8787')).replace(/\/+$/, '');
  if (!siteUrl) throw new Error('--env production 时需要 --site-url <https://站点地址>（或用 --api-key 配套提供）');
  return { siteUrl, apiKey, concurrency: 8 };
}

async function uploadOnce(
  channel: HttpChannel,
  filePath: string,
  query: string,
): Promise<{ status: number; retryAfter: number | null; body: { id?: number; hash?: string; existing?: boolean; error?: string; msg?: string } }> {
  const res = await fetch(`${channel.siteUrl}/api/v1/pigeon/admin/import/textures?${query}`, {
    method: 'POST',
    headers: { 'api-key': channel.apiKey, 'content-type': 'application/octet-stream' },
    body: readFileSync(filePath),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({})) as { id?: number; hash?: string; existing?: boolean; error?: string; msg?: string };
  const retryAfterText = res.headers.get('retry-after');
  const retryAfter = retryAfterText !== null && Number.isFinite(Number(retryAfterText)) ? Number(retryAfterText) : null;
  return { status: res.status, retryAfter, body };
}

/** 上传单个 PNG（调用方负责并发控制）。
 * 429 按服务端 Retry-After（缺省 5 秒）等待后有界重试 —— 服务端默认限流
 * 60 次/30 秒，大批量必然撞限流，按窗口等待才能完整跑完。 */
export async function httpUploadTexture(
  channel: HttpChannel,
  filePath: string,
  params: { kind: string; model: string | null; visibility: string; origin: string; uploader: string | null; name: string },
): Promise<HttpUploadResult> {
  const query = new URLSearchParams({
    kind: params.kind,
    ...(params.model ? { model: params.model } : {}),
    visibility: params.visibility,
    origin: params.origin,
    ...(params.uploader ? { uploader: params.uploader } : {}),
    name: params.name,
  }).toString();

  const MAX_RETRIES = 20;
  let attempt = await uploadOnce(channel, filePath, query);
  for (let retry = 0; attempt.status === 429 && retry < MAX_RETRIES; retry++) {
    const waitSeconds = Math.min(Math.max(attempt.retryAfter ?? 5, 1), 120);
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    attempt = await uploadOnce(channel, filePath, query);
  }
  if (attempt.status === 200 || attempt.status === 201) {
    const { id, hash, existing } = attempt.body;
    if (typeof id !== 'number' || typeof hash !== 'string') {
      throw new Error(`响应格式异常: ${JSON.stringify(attempt.body).slice(0, 200)}`);
    }
    return { id, hash, existing: existing ?? false };
  }
  const detail = attempt.body.error ?? attempt.body.msg ?? '';
  throw new Error(`HTTP ${attempt.status}: ${detail}`);
}

/** 并发批量上传；返回失败清单（调用方决定退出码）。
 * items 的 params 附带 localHash（本地算的内容哈希），与服务端返回值比对 ——
 * 两端校验实现若漂移，这里立即暴露而不是静默写错。 */
export async function httpUploadBatch(
  channel: HttpChannel,
  items: readonly { file: string; localHash: string; params: { kind: string; model: string | null; visibility: string; origin: string; uploader: string | null; name: string } }[],
  baseDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; skipped: number; failures: { file: string; reason: string }[] }> {
  let ok = 0, skipped = 0, cursor = 0;
  const failures: { file: string; reason: string }[] = [];
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      if (!item) continue;
      try {
        const r = await httpUploadTexture(channel, join(baseDir, item.file), item.params);
        if (r.hash !== item.localHash) {
          throw new Error(`服务端 hash 与本地不一致（${r.hash.slice(0, 12)}… ≠ ${item.localHash.slice(0, 12)}…）`);
        }
        if (r.existing) skipped++; else ok++;
        if (onProgress && (ok + skipped) % 50 === 0) onProgress(ok + skipped, items.length);
      } catch (e) {
        failures.push({ file: basename(item.file), reason: ((e as Error).message.split('\n')[0]) ?? 'unknown' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(channel.concurrency, Math.max(items.length, 1)) }, worker));
  return { ok, skipped, failures };
}
