// 收藏与举报路由。
//
// 业务规则在 services/social.ts：likes 计数的原子性、积分结算、
// 角色层级判定都在那里。
import { Hono } from 'hono';
import {
  closetAddInputSchema,
  closetListQuerySchema,
  closetRenameInputSchema,
  reportListQuerySchema,
  reportResolveInputSchema,
  reportSubmitInputSchema,
} from '@pigeon-skin/shared/schemas';
import { currentAdmin, currentUser, readJson, readQuery } from '../framework.ts';
import * as social from '../services/social.ts';
import { getSettingBool, getSettingInt, type AppEnv } from '../lib.ts';

export const closetRoutes = new Hono<AppEnv>();
export const reportRoutes = new Hono<AppEnv>();

/** 计费与奖励参数。集中一处读，避免每个入口各拼一遍。 */
async function readRates(env: AppEnv['Bindings']): Promise<social.SocialRates> {
  return {
    perClosetItem: await getSettingInt(env, 'score_per_closet_item'),
    perLikeAward: await getSettingInt(env, 'score_award_per_like'),
    reporterReward: await getSettingInt(env, 'reporter_reward_score'),
    refundOnDelete: await getSettingBool(env, 'refund_on_delete'),
    reporterScoreDelta: await getSettingInt(env, 'reporter_score_delta'),
  };
}

// ── 收藏 ─────────────────────────────────────────────────────────────────────

closetRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const query = readQuery(c, closetListQuerySchema);
  return c.json(await social.listCloset(c.env, user.id, query));
});

closetRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, closetAddInputSchema);
  const result = await social.collectTexture(
    c.env, user, body.textureId, body.name, await readRates(c.env),
  );
  return c.json({ ok: true, ...result }, 201);
});

closetRoutes.patch('/:textureId', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, closetRenameInputSchema);
  await social.renameClosetEntry(c.env, user.id, Number(c.req.param('textureId')), body.name);
  return c.json({ ok: true });
});

closetRoutes.delete('/:textureId', async (c) => {
  const user = currentUser(c);
  await social.removeClosetEntry(
    c.env, user, Number(c.req.param('textureId')), await readRates(c.env),
  );
  return c.body(null, 204);
});

// ── 举报 ─────────────────────────────────────────────────────────────────────

reportRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, reportSubmitInputSchema);
  const result = await social.submitReport(
    c.env, user, body.textureId, body.reason, await readRates(c.env),
  );
  return c.json({ ok: true, ...result }, 201);
});

reportRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json(await social.listMyReports(c.env, user.id));
});

// ── 后台审核 ─────────────────────────────────────────────────────────────────

reportRoutes.get('/admin', async (c) => {
  currentAdmin(c);
  const query = readQuery(c, reportListQuerySchema);
  return c.json(await social.listReportsForReview(c.env, query.status ?? 'pending'));
});

reportRoutes.post('/:id/resolve', async (c) => {
  const reviewer = currentAdmin(c);
  const body = await readJson(c, reportResolveInputSchema);
  await social.reviewReport(
    c.env, reviewer, Number(c.req.param('id')), body.action, await readRates(c.env),
  );
  return c.json({ ok: true, action: body.action });
});
