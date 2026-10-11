// 静态资产 Fetcher shim 测试：命中文件、SPA 回退、content-type、路径安全。

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetsFetcherShim } from '../../src/node/assets.ts';

let dir: string;
let assets: AssetsFetcherShim;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-assets-'));
  // 造一个迷你 dist：index.html + 带子目录的 js 与 json 资产
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><title>app</title></head><body><div id="app"></div></body></html>');
  await writeFile(join(dir, 'assets', 'test.js'), 'console.log(1)');
  await writeFile(join(dir, 'assets', 'style.css'), 'body{}');
  await writeFile(join(dir, 'manual-content.json'), '{"welcome":"hi"}');
  assets = new AssetsFetcherShim(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AssetsFetcherShim', () => {
  it('命中文件：200 + 正确 content-type + 内容', async () => {
    const js = await assets.fetch(new Request('https://site.test/assets/test.js'));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe('console.log(1)');

    const css = await assets.fetch(new Request('https://site.test/assets/style.css'));
    expect(css.headers.get('content-type')).toContain('text/css');

    const json = await assets.fetch(new Request('https://site.test/manual-content.json'));
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(await json.json<Record<string, string>>()).toEqual({ welcome: 'hi' });
  });

  it('未命中回退 index.html（SPA 语义，200 + text/html）', async () => {
    const deep = await assets.fetch(new Request('https://site.test/skinlib/42'));
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
    expect(await deep.text()).toContain('<div id="app"></div>');

    const missing = await assets.fetch(new Request('https://site.test/assets/nope.js'));
    expect(missing.status).toBe(200);
    expect(missing.headers.get('content-type')).toContain('text/html');
  });

  it('目录路径同样回退 index.html', async () => {
    const dirResponse = await assets.fetch(new Request('https://site.test/assets/'));
    expect(dirResponse.status).toBe(200);
    expect(dirResponse.headers.get('content-type')).toContain('text/html');
  });

  it('路径穿越被拒绝（不落盘读越界文件，走 SPA 回退）', async () => {
    const traversal = await assets.fetch(new Request('https://site.test/../secret.txt'));
    expect(traversal.headers.get('content-type')).toContain('text/html');
  });

  it('响应带弱 ETag（mtime+size）', async () => {
    const response = await assets.fetch(new Request('https://site.test/assets/test.js'));
    expect(response.headers.get('etag')).toMatch(/^W\/"\d+-\d+"$/);
  });
});
