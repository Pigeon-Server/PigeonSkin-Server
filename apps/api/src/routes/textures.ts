// 纹理路由 —— 只负责解析请求与返回响应。
//
// 输入校验在 packages/shared/schemas.ts，SQL 在 repositories/，
// 业务规则在 services/，通用原语在 framework.ts。
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { textureListQuerySchema, texturePatchInputSchema } from '@pigeon-skin/shared/schemas';
import {
  currentUser, fail, paginate, readJsonOptional, readPagination, readQuery,
} from '../framework.ts';
import * as textures from '../services/textures.ts';
import { flag } from '../env.ts';
import { getSetting, getSettingBool, getSettingInt, type AppEnv } from '../lib.ts';

export const textureRoutes = new Hono<AppEnv>();

/** 当前的计费参数。集中一处，避免每个路由各读一遍设置。 */
async function readRates(env: AppEnv['Bindings']) {
  return {
    perKbPublic: await getSettingInt(env, 'score_per_kb_public'),
    perKbPrivate: await getSettingInt(env, 'score_per_kb_private'),
    closetItem: await getSettingInt(env, 'score_per_closet_item'),
    awardPerTexture: await getSettingInt(env, 'score_award_per_texture'),
    clawbackAward: await getSettingBool(env, 'clawback_award_on_delete'),
  };
}

// ── 列表 ─────────────────────────────────────────────────────────────────────

textureRoutes.get('/', async (c) => {
  const query = readQuery(c, textureListQuerySchema);
  const page = readPagination(c);

  const { items, total } = await textures.listTextures(
    c.env,
    c.get('user'),
    {
      kind: query.kind,
      model: query.model,
      uploader: query.uploader,
      official: query.official === 'true',
      keyword: query.keyword,
      sort: query.sort ?? 'created',
      mine: query.mine === 'true',
    },
    page,
  );
  return c.json(paginate(items, total, page));
});

// ── 详情 ─────────────────────────────────────────────────────────────────────

textureRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const privateStatus = await getSettingInt(c.env, 'private_texture_status');
  const texture = await textures.getTexture(c.env, c.get('user'), id, privateStatus);
  return c.json(texture);
});

textureRoutes.get('/:id/content', async (c) => {
  const id = Number(c.req.param('id'));
  const texture = await textures.getTexture(c.env, c.get('user'), id, await getSettingInt(c.env, 'private_texture_status'));
  const object = await c.env.BUCKET.get(`textures/${texture.hash}.png`);
  if (!object) throw fail.notFound('texture.not_found');
  return new Response(object.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
});

// ── 上传 ─────────────────────────────────────────────────────────────────────

const textureUploadBodyLimit = bodyLimit({ maxSize: 101 * 1024 * 1024, onError: c => c.json({ error: 'texture.file_too_large' }, 422) });

textureRoutes.post('/', textureUploadBodyLimit, async (c) => {
  const bodyLimitBytes = (await getSettingInt(c.env, 'max_upload_size_kb')) * 1024 + 256 * 1024;
  const rawLength = c.req.header('content-length');
  if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > bodyLimitBytes)) throw fail.invalid('texture.file_too_large');
  const user = currentUser(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw fail.invalid();
  }

  // 用鸭子类型而不是 instanceof File：不同运行时的 File 构造器不一定一致，
  // 而我们只需要二进制内容，用更宽的 Blob 接口即可。
  const file = form.get('file');
  if (!file || typeof file === 'string') throw fail.invalid('texture.file_missing');
  if ((file as Blob).size > bodyLimitBytes - 256 * 1024) throw fail.invalid('texture.file_too_large');

  const kind = form.get('kind') === 'cape' ? ('cape' as const) : ('skin' as const);
  const model = kind === 'cape'
    ? null
    : (form.get('model') === 'slim' ? ('slim' as const) : ('default' as const));

  const description = String(form.get('description') ?? '');
  const sourceValue = String(form.get('sourceResourceId') ?? '').trim();
  const sourceResourceId = sourceValue ? Number(sourceValue) : null;
  if (sourceResourceId !== null && (!Number.isInteger(sourceResourceId) || sourceResourceId <= 0)) throw fail.invalid();
  const originValue = form.get('origin');
  if (originValue !== null && originValue !== 'original' && originValue !== 'repost') throw fail.invalid();
  const descriptionLimit = await getSettingInt(c.env, 'textures_description_limit');
  if (descriptionLimit > 0 && description.length > descriptionLimit) {
    throw fail.invalid('common.invalid_request', { description: 'too_long' });
  }

  const result = await textures.uploadTexture(
    c.env,
    user,
    {
      bytes: new Uint8Array(await (file as Blob).arrayBuffer()),
      name: String(form.get('name') ?? '').trim(),
      description,
      sourceResourceId,
      origin: originValue === 'repost' ? 'repost' : 'original',
      kind,
      model,
      visibility: form.get('visibility') === 'private' ? 'private' : 'public',
      nameRegexp: await getSetting(c.env, 'texture_name_regexp'),
      limits: {
        maxSizeBytes: (await getSettingInt(c.env, 'max_upload_size_kb')) * 1024,
        maxWidth: await getSettingInt(c.env, 'max_texture_width'),
        maxArea: textures.DEFAULT_TEXTURE_LIMITS.maxArea,
      },
    },
    await readRates(c.env),
  );

  // 上传成功即预生成常用衍生图（2d 头像两个主尺寸 + 预览）。走 waitUntil：
  // 生成失败不阻塞上传响应 —— 读取端点有按需生成的兜底。
  // （2026-09-30 决策：衍生图由服务端 DO 生成，前端不再抓取上传。）
  if (flag(c.env.DERIVATIVES_ENABLED)) {
    const { hash } = result;
    const id = c.env.DERIVATIVES.idFromName(hash);
    const stub = c.env.DERIVATIVES.get(id);
    for (const kindSpec of ['avatar-2d-100', 'avatar-2d-64', 'preview']) {
      c.executionCtx.waitUntil(
        stub.fetch(`https://do/generate?hash=${hash}&kind=${kindSpec}`).catch(() => {}),
      );
    }
  }

  return c.json(result, 201);
});

// ── 修改 ─────────────────────────────────────────────────────────────────────

textureRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  const body = await readJsonOptional(c, texturePatchInputSchema);

  const { scoreDelta } = await textures.patchTexture(c.env, user, id, body, await readRates(c.env), await getSetting(c.env, 'texture_name_regexp'));
  return c.json({ ok: true, scoreDelta });
});

textureRoutes.put('/:id/content', textureUploadBodyLimit, async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  const bodyLimitBytes = (await getSettingInt(c.env, 'max_upload_size_kb')) * 1024 + 256 * 1024;
  const rawLength = c.req.header('content-length');
  if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > bodyLimitBytes)) throw fail.invalid('texture.file_too_large');
  let form: FormData;
  try { form = await c.req.formData(); } catch { throw fail.invalid(); }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw fail.invalid('texture.file_missing');
  if ((file as Blob).size > bodyLimitBytes - 256 * 1024) throw fail.invalid('texture.file_too_large');
  const result = await textures.replaceTextureContent(c.env, user, id,
    new Uint8Array(await (file as Blob).arrayBuffer()), {
      maxSizeBytes: (await getSettingInt(c.env, 'max_upload_size_kb')) * 1024,
      maxWidth: await getSettingInt(c.env, 'max_texture_width'),
      maxArea: textures.DEFAULT_TEXTURE_LIMITS.maxArea,
    }, await readRates(c.env));
  return c.json(result);
});

// ── 删除 ─────────────────────────────────────────────────────────────────────

textureRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  await textures.deleteTexture(c.env, user, id, {
    enabled: await getSettingBool(c.env, 'refund_on_delete'),
  });
  return c.body(null, 204);
});
