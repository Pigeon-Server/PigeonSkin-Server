// 玩家路由。
//
// 名称校验、唯一性、归属判定与积分结算在 services/players.ts。
import { Hono } from 'hono';
import {
  playerCreateInputSchema,
  playerRenameInputSchema,
  playerTexturesInputSchema,
} from '@pigeon-skin/shared/schemas';
import type { PlayerNameRule } from '@pigeon-skin/shared';
import { currentUser, readJson, readJsonOptional } from '../framework.ts';
import * as players from '../services/players.ts';
import { getSetting, getSettingBool, getSettingInt, type AppEnv } from '../lib.ts';

export const playerRoutes = new Hono<AppEnv>();

/** 玩家名规则。集中一处读，避免每个入口各拼一遍。 */
async function readNameRules(env: AppEnv['Bindings']): Promise<players.NameRules> {
  return {
    rule: (await getSetting(env, 'player_name_rule')) as PlayerNameRule,
    regexp: await getSetting(env, 'player_name_regexp'),
    min: await getSettingInt(env, 'player_name_length_min'),
    max: await getSettingInt(env, 'player_name_length_max'),
  };
}

// ── 我的玩家 ─────────────────────────────────────────────────────────────────

playerRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json(await players.listOwnPlayers(c.env, user.id));
});

playerRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, playerCreateInputSchema);
  const result = await players.createPlayer(
    c.env, user, body.name,
    await readNameRules(c.env),
    await getSettingInt(c.env, 'score_per_player'),
    await getSettingInt(c.env, 'free_player_count'),
    await getSettingInt(c.env, 'max_player_count'),
  );
  return c.json(result, 201);
});

playerRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, playerRenameInputSchema);
  await players.renamePlayer(
    c.env, user, Number(c.req.param('id')), body.name, await readNameRules(c.env),
  );
  return c.json({ ok: true });
});

playerRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await players.deletePlayer(c.env, user, Number(c.req.param('id')), {
    enabled: await getSettingBool(c.env, 'refund_on_delete'),
  });
  return c.body(null, 204);
});

// ── 指派纹理 ─────────────────────────────────────────────────────────────────
//
// 注意：清除纹理走同一个 PUT（传 null 或 0），但保留 DELETE 端点是为了
// 兼容"只清皮肤不清披风"的旧交互。两者都由 service 层的同一套规则处理。

playerRoutes.put('/:id/textures', async (c) => {
  const user = currentUser(c);
  const body = await readJsonOptional(c, playerTexturesInputSchema);
  await players.assignTextures(c.env, user, Number(c.req.param('id')), body);
  return c.json({ ok: true });
});

playerRoutes.delete('/:id/textures', async (c) => {
  const user = currentUser(c);
  await players.clearTextures(c.env, user, Number(c.req.param('id')), {
    skin: c.req.query('skin') === 'true',
    cape: c.req.query('cape') === 'true',
  });
  return c.json({ ok: true });
});

// 后台的玩家管理不在这里：它属于 /api/v1/admin/*，由 admin.ts 注册。
// 放在这里会形成 /api/v1/players/admin 与 /api/v1/admin/players 两套同义路由。
