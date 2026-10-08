// Workers Static Assets binding（ASSETS: Fetcher）的 Node 侧 shim。
//
// 业务代码对 ASSETS.fetch 的判定依赖（app.ts notFound 分支与
// seo.ts 手册内容源）：
//   • 命中文件 → 200 + 正确 content-type（非 text/html 时直接透传）
//   • 未命中 → SPA 回退返回 index.html（200, text/html）——app.ts 靠
//     "content-type 含 text/html" 决定走 SEO 预渲染
//
// 对应 wrangler 的 not_found_handling = "single-page-application"。
// ETag 用 mtime+size 弱校验：业务代码不做条件请求，只是让响应头
// 形状与 Workers 对齐。

import { stat, readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

export class AssetsFetcherShim {
  readonly #assetsDir: string;
  readonly #indexPath: string;

  constructor(assetsDir: string) {
    this.#assetsDir = assetsDir;
    this.#indexPath = join(assetsDir, 'index.html');
  }

  async fetch(request: Request | URL | string): Promise<Response> {
    const url = request instanceof Request ? new URL(request.url) : request instanceof URL ? request : new URL(request);
    const pathname = decodeURIComponent(url.pathname);

    const resolved = this.#safeResolve(pathname);
    if (resolved && !(await this.#isDirectory(resolved))) {
      const bytes = await readFile(resolved).catch(() => undefined);
      if (bytes) {
        const info = await stat(resolved);
        const contentType = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
        // 弱 ETag = mtime + size（秒级精度足够，业务代码不做条件请求）
        const etag = `W/"${Math.floor(info.mtimeMs)}-${info.size}"`;
        return new Response(toArrayBuffer(bytes), {
          status: 200,
          headers: {
            'content-type': contentType,
            'etag': etag,
            'content-length': String(bytes.length),
          },
        });
      }
    }

    // SPA 回退：未命中（文件不存在 / 路径是目录 / 越界路径）→ index.html
    const index = await readFile(this.#indexPath).catch(() => undefined);
    if (!index) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(toArrayBuffer(index), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(index.length),
      },
    });
  }

  /** 防路径穿越：resolve 后必须仍在 assetsDir 内 */
  #safeResolve(pathname: string): string | undefined {
    const resolved = normalize(join(this.#assetsDir, pathname));
    if (!resolved.startsWith(this.#assetsDir)) return undefined;
    return resolved;
  }

  async #isDirectory(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => undefined);
    return info?.isDirectory() ?? false;
  }
}

/** Uint8Array → 独立 ArrayBuffer（同 do/derivatives.ts 的规避写法） */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.length);
  new Uint8Array(out).set(data);
  return out;
}
