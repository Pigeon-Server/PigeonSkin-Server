// players / closet / reports / notifications / settings 阶段的执行器。
//
// 读取走 pageLoop 或单次全量（小表），写入走 target.runBatch（静态模板）。
import { mapPlayer, mapReport, mapNotification } from '../schema/mapper.ts';
import { mapOptionRows } from '../schema/options.ts';
import * as S from '../schema/statements.ts';
import type { StageResult } from './types.ts';
import type { StageContext } from './stages.ts';
import { pageLoop, flush } from './page-loop.ts';

export async function stagePlayers(ctx: StageContext, skipOffset: number): Promise<StageResult> {
  const validUserIds = new Set((await ctx.target.query(S.NEW_USER_IDS)).map(row => Number(row['id'])));
  // 悬空纹理引用过滤：只有新 textures 表里存在的 tid 才是有效引用
  const validTids = new Set(
    (await ctx.target.query(S.NEW_TEXTURE_IDS)).map((r) => Number(r['id'])),
  );
  const result = await pageLoop({
    source: ctx.source,
    countSql: S.COUNT_PLAYERS,
    fetchSql: S.FETCH_PLAYERS,
    batchSize: ctx.batchSize,
    skipOffset,
    log: (m) => ctx.log(`  players: ${m}`),
    skip: row => !ctx.dryRun && !validUserIds.has(Number(row['uid'])) ? 'dangling-user' : null,
    map: (row) => {
      const p = mapPlayer(row as never, ctx.tz);
      return {
        sql: S.INSERT_PLAYER,
        params: [
          p.id, p.userId, p.name,
          p.skinTextureId !== null && validTids.has(p.skinTextureId) ? p.skinTextureId : null,
          p.capeTextureId !== null && validTids.has(p.capeTextureId) ? p.capeTextureId : null,
          p.createdAt, p.updatedAt,
        ],
      };
    },
  });
  const inserted = await flush(ctx.target, result.statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'players', total: result.total, skipped: result.skipped,
    written: ctx.dryRun ? 0 : inserted,
    ignored: result.statements.length - inserted,
  };
}

export async function stageCloset(ctx: StageContext): Promise<StageResult> {
  const rows = await ctx.source.query(S.FETCH_CLOSET);
  const validTextureIds = new Set(
    (await ctx.target.query(S.NEW_TEXTURE_IDS)).map((r) => Number(r['id'])),
  );
  const validUserIds = new Set(
    (await ctx.target.query(S.NEW_USER_IDS)).map((r) => Number(r['id'])),
  );

  // 旧表无主键：同 (user,texture) 保留一条；悬空引用丢弃（analyze 已报告）
  const seen = new Set<string>();
  const skipped: Record<string, number> = {};
  const statements = [];
  for (const r of rows) {
    const userId = Number(r['user_uid']);
    const textureId = Number(r['texture_tid']);
    const key = `${userId}:${textureId}`;
    if (seen.has(key)) { skipped['duplicate'] = (skipped['duplicate'] ?? 0) + 1; continue; }
    if (!validTextureIds.has(textureId)) { skipped['dangling-texture'] = (skipped['dangling-texture'] ?? 0) + 1; continue; }
    if (!validUserIds.has(userId)) { skipped['dangling-user'] = (skipped['dangling-user'] ?? 0) + 1; continue; }
    seen.add(key);
    statements.push({
      sql: S.INSERT_CLOSET,
      params: [userId, textureId, r['item_name'] ?? null, 0],
    });
  }
  const inserted = await flush(ctx.target, statements, ctx.batchSize, ctx.dryRun);
  return { stage: 'closet', total: rows.length, written: ctx.dryRun ? 0 : inserted, ignored: 0, skipped };
}

export async function stageReports(ctx: StageContext): Promise<StageResult> {
  const validUserIds = new Set((await ctx.target.query(S.NEW_USER_IDS)).map(row => Number(row['id'])));
  const rows = await ctx.source.query(S.FETCH_REPORTS);
  const validTextureIds = new Set(
    (await ctx.target.query(S.NEW_TEXTURE_IDS)).map((r) => Number(r['id'])),
  );

  const seen = new Set<string>();
  const skipped: Record<string, number> = {};
  const statements = [];
  for (const row of rows) {
    const reporter = Number(row['reporter']);
    const textureId = Number(row['tid']);
    const key = `${reporter}:${textureId}`;
    if (seen.has(key)) { skipped['duplicate'] = (skipped['duplicate'] ?? 0) + 1; continue; }
    if (!validTextureIds.has(textureId)) { skipped['dangling-texture'] = (skipped['dangling-texture'] ?? 0) + 1; continue; }
    if (!validUserIds.has(reporter)) { skipped['dangling-user'] = (skipped['dangling-user'] ?? 0) + 1; continue; }
    seen.add(key);
    const r = mapReport(row as never, ctx.tz);
    if (r.uploaderId !== null && !validUserIds.has(r.uploaderId)) r.uploaderId = null;
    statements.push({
      sql: S.INSERT_REPORT,
      params: [
        r.id, r.textureId, r.uploaderId, r.reporterId, r.reason, r.status,
        r.status === 'pending' ? null : 'legacy', r.createdAt, r.reviewedAt,
      ],
    });
  }
  const inserted = await flush(ctx.target, statements, ctx.batchSize, ctx.dryRun);
  return { stage: 'reports', total: rows.length, written: ctx.dryRun ? 0 : inserted, ignored: 0, skipped };
}

export async function stageNotifications(ctx: StageContext): Promise<StageResult> {
  const rows = await ctx.source.query(S.FETCH_NOTIFICATIONS);
  const validUserIds = new Set((await ctx.target.query(S.NEW_USER_IDS)).map(row => Number(row['id'])));

  const skipped: Record<string, number> = {};
  const statements = [];
  for (const row of rows) {
    const n = mapNotification(row as never, ctx.notificationTz ?? ctx.tz);
    if (!n) { skipped['no-created-at'] = (skipped['no-created-at'] ?? 0) + 1; continue; }
    if (!ctx.dryRun && !validUserIds.has(n.userId)) { skipped['dangling-user'] = (skipped['dangling-user'] ?? 0) + 1; continue; }
    statements.push({
      sql: S.INSERT_NOTIFICATION,
      params: [n.userId, n.type, n.title, n.body, n.readAt, n.createdAt],
    });
  }
  const inserted = await flush(ctx.target, statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'notifications', total: rows.length,
    written: ctx.dryRun ? 0 : inserted, ignored: 0, skipped,
  };
}

export async function stageSettings(ctx: StageContext): Promise<StageResult> {
  const rows = await ctx.source.query(S.FETCH_OPTIONS);
  const mapped = mapOptionRows(rows as never, ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU']);

  const now = Date.now();
  const statements = mapped.map((s) => ({
    sql: S.UPSERT_SETTING,
    params: [s.key, s.locale, s.value, now],
  }));
  const inserted = await flush(ctx.target, statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'settings', total: rows.length,
    written: ctx.dryRun ? 0 : inserted, ignored: 0, skipped: {},
  };
}

// ── 插件内置化新表（0002）────────────────────────────────────────────────────

/** 旧 uuid 表 → 新 uuid 表（yggdrasil 的改名保 UUID 语义依赖它） */
export async function stageUuid(ctx: StageContext): Promise<StageResult> {
  // 旧站未装 yggdrasil 插件时没有 uuid 表 —— 视为空阶段
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await ctx.source.query(S.FETCH_UUIDS);
  } catch {
    return { stage: 'uuid', total: 0, written: 0, ignored: 0, skipped: {} };
  }
  let written = 0;
  if (!ctx.dryRun) {
    written = await ctx.target.runBatch(
      rows.map((r) => ({ sql: S.INSERT_UUID, params: [String(r['uuid']), String(r['name'])] })),
    );
  }
  ctx.log(`  uuid: ${rows.length}`);
  return { stage: 'uuid', total: rows.length, written: ctx.dryRun ? 0 : written, ignored: rows.length - written, skipped: {} };
}

/** 旧 textures_description → 新 textures_description（tid 直接沿用；悬空行丢弃） */
export async function stageDescriptions(ctx: StageContext): Promise<StageResult> {
  // 旧站未装 texture-description 插件时没有该表 —— 视为空阶段
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await ctx.source.query(S.FETCH_DESCRIPTIONS);
  } catch {
    return { stage: 'descriptions', total: 0, written: 0, ignored: 0, skipped: {} };
  }
  const validTids = new Set(
    (await ctx.target.query(S.NEW_TEXTURE_IDS)).map((r) => Number(r['id'])),
  );
  const now = Date.now();
  const statements = [];
  let skippedDangling = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    const tid = Number(r['tid']);
    if (!validTids.has(tid) || seen.has(tid)) { skippedDangling++; continue; }
    seen.add(tid);
    statements.push({
      sql: S.INSERT_DESCRIPTION,
      params: [tid, String(r['description'] ?? ''), now],
    });
  }
  const inserted = await flush(ctx.target, statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'descriptions', total: rows.length,
    written: ctx.dryRun ? 0 : inserted,
    ignored: statements.length - inserted,
    skipped: { 'dangling-texture': skippedDangling },
  };
}
