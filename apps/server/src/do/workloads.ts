import { hashPassword, verifyStoredPassword } from '@pigeon-skin/auth';
import { withRequestCache } from '../core/request-cache.ts';
import { sanitizeTexture, validateTexture, isAllowedDerivativeSize, type TextureLimits } from '@pigeon-skin/minecraft';
import { LIMITS, type TextureKind, type TextureModel } from '@pigeon-skin/shared';
import { resizePng } from '../services/compute.ts';
import { uploadModel } from '../services/live2d.ts';
import type { Bindings } from '../core/env.ts';
import { processQueueBatch } from '../tasks.ts';
import { processDueJobs } from '../services/ai-jobs.ts';
import { resolveConfiguration } from '../services/configuration.ts';
import { noteD1Failure } from '../core/usage-budget.ts';
import { AppError } from '../core/framework.ts';

function localBindings(env: Bindings): Bindings {
  const result = { ...env };
  delete result.WORKLOADS;
  return result;
}

export class Workloads {
  private readonly env: Bindings;
  private readonly state: DurableObjectState;
  constructor(state: DurableObjectState, env: Bindings) { this.state = state; this.env = env; }

  fetch(request: Request): Promise<Response> { return withRequestCache(() => this.handleRequest(request)); }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (url.pathname === '/queue') {
      const body = await request.json();
      let retryAfter: number | undefined;
      const message = { body, ack() {}, retry(options?: { delaySeconds?: number }) { retryAfter = options?.delaySeconds ?? 300; } };
      await processQueueBatch({ messages: [message] } as never, localBindings(this.env));
      return Response.json({ retryAfter });
    }
    if (url.pathname === '/ai-jobs') {
      try { await processDueJobs(localBindings(await resolveConfiguration(this.env))); }
      catch (error) { await noteD1Failure(this.env, error); throw error; }
      return Response.json({ completed: true });
    }
    if (url.pathname === '/store-model-assets') {
      const form = await request.formData();
      const files = form.getAll('file') as File[];
      const metadata = JSON.parse(String(form.get('metadata'))) as Array<{ key: string; contentType: string }>;
      if (files.length > 16 || files.length !== metadata.length || metadata.some(item => !/^live2d\/(?:models|manifests)\/[0-9a-f-]{36}(?:\/|\.json)/.test(item.key))) return new Response(null, { status: 422 });
      for (let index = 0; index < files.length; index++) await this.env.BUCKET.put(metadata[index]!.key, await files[index]!.arrayBuffer(), { httpMetadata: { contentType: metadata[index]!.contentType } });
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith('/password/')) {
      const body = await request.json<{ password: string; stored: string; options: { legacySalt?: string } }>();
      if (url.pathname === '/password/hash') return Response.json({ hash: await hashPassword(body.password) });
      if (url.pathname === '/password/verify') return Response.json({ valid: await verifyStoredPassword(body.password, body.stored, body.options) });
      return new Response(null, { status: 404 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const run = async () => {
      if (url.pathname === '/live2d') {
        const writes: Array<{ key: string; bytes: Uint8Array<ArrayBuffer> | string; contentType: string }> = [];
        const bucket = new Proxy(this.env.BUCKET, { get: (target, name) => name === 'put' ? async (key: string, bytes: Uint8Array<ArrayBuffer> | string, options: R2PutOptions) => { writes.push({ key, bytes, contentType: options.httpMetadata && typeof options.httpMetadata === 'object' && 'contentType' in options.httpMetadata ? options.httpMetadata.contentType ?? '' : '' }); return null; } : typeof target[name as keyof R2Bucket] === 'function' ? (target[name as keyof R2Bucket] as Function).bind(target) : target[name as keyof R2Bucket] });
        const env = localBindings(this.env);
        env.BUCKET = bucket;
        const info = await uploadModel(env, url.searchParams.get('name') || '', bytes);
        try {
          for (let offset = 0; offset < writes.length; offset += 16) {
            const batch = writes.slice(offset, offset + 16);
            const form = new FormData();
            form.set('metadata', JSON.stringify(batch.map(({ key, contentType }) => ({ key, contentType }))));
            for (const item of batch) form.append('file', new Blob([item.bytes], { type: item.contentType }));
            const namespace = this.env.WORKLOADS!;
            const target = namespace.get(namespace.idFromName(crypto.randomUUID()));
            const response = await target.fetch('https://workload/store-model-assets', { method: 'POST', body: form });
            await response.arrayBuffer();
            if (!response.ok) throw new Error('Model upload failed');
          }
          return Response.json(info);
        } catch (error) { await this.env.BUCKET.delete(writes.map(item => item.key)); throw error; }
      }
      if (url.pathname === '/sanitize') {
        const area = Number(url.searchParams.get('area'));
        const kind = url.searchParams.get('kind');
        if (!Number.isInteger(area) || area < 1 || area > LIMITS.maxTextureArea || (kind !== null && kind !== 'skin' && kind !== 'cape')) return new Response(null, { status: 422 });
        const result = await sanitizeTexture(bytes, { kind: kind === 'skin' || kind === 'cape' ? kind : undefined, maxArea: area });
        if (!result.ok) return Response.json(result);
        const headers: Record<string, string> = { 'content-type': 'image/png', 'x-image-width': String(result.width), 'x-image-height': String(result.height) };
        if (result.skinModel) headers['x-image-model'] = result.skinModel;
        return new Response(result.bytes, { headers });
      }
      if (url.pathname === '/validate') {
        const options = JSON.parse(url.searchParams.get('options') ?? '{}') as { target: { kind: TextureKind; model: TextureModel | null }; limits: TextureLimits };
        return Response.json(await validateTexture(bytes, options.target, options.limits));
      }
      if (url.pathname === '/resize') {
        const size = Number(url.searchParams.get('size'));
        if (!isAllowedDerivativeSize(size)) return new Response(null, { status: 422 });
        const result = await resizePng(bytes, size);
        return result ? new Response(result, { headers: { 'content-type': 'image/png' } }) : new Response(null, { status: 422 });
      }
      return new Response(null, { status: 404 });
    };
    const guarded = async () => {
      try { return await run(); }
      catch (error) {
        if (error instanceof AppError) return Response.json({ error: error.code, fields: error.fields }, { status: error.status });
        throw error;
      }
    };
    return url.pathname === '/live2d' ? guarded() : this.state.blockConcurrencyWhile(guarded);
  }
}
