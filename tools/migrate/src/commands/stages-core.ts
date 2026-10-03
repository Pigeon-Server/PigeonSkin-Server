// users / textures 两个分批阶段的执行器。
//
// 读取走 pageLoop（参数数组绑定分页），写入走 target.runBatch（静态模板）。
import { mapUser, mapTexture, pngDimensions } from '../schema/mapper.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as S from '../schema/statements.ts';
import type { StageResult } from './types.ts';
import type { StageContext } from './stages.ts';
import { pageLoop, flush } from './page-loop.ts';

export async function stageUsers(ctx: StageContext, skipOffset: number): Promise<StageResult> {
  const conflicts = new Set((await ctx.source.query(`SELECT LOWER(TRIM(email)) AS email FROM users WHERE TRIM(email) <> '' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1`)).map(row => String(row['email'])));
  const textures = await ctx.source.query(`SELECT tid, hash FROM textures`);
  const validTextureIds = new Set(textures.filter(row => ctx.presentHashes === null || ctx.presentHashes.has(String(row['hash']))).map(row => Number(row['tid'])));
  const adjusted: Record<string, number> = {};
  const result = await pageLoop({
    source: ctx.source,
    countSql: S.COUNT_USERS,
    fetchSql: S.FETCH_USERS,
    batchSize: ctx.batchSize,
    skipOffset,
    log: (m) => ctx.log(`  users: ${m}`),
    skip: (row) => {
      const email = String(row['email'] ?? '').trim();
      return email === '' ? 'empty-email' : null;
    },
    map: (row) => {
      const u = mapUser(row as never, ctx.tz, ctx.algo);
      if (u.avatarTextureId !== null && !validTextureIds.has(u.avatarTextureId)) {
        u.avatarTextureId = null;
        adjusted['avatar-cleared'] = (adjusted['avatar-cleared'] ?? 0) + 1;
      }
      // 源库存在空密码串（OAuth/外部导入的账号）：包装后是 "<algo>:",
      // 没有任何验证器能匹配它，但 verify 会按坏格式报警。统一换成
      // 永不可能匹配的哨兵载荷，语义 = 该账号无法用密码登录。
      if (u.passwordHash.endsWith(':')) {
        u.passwordHash = `${ctx.algo}:legacy-empty-password`;
      }
      return {
        sql: S.INSERT_USER,
        params: [
          u.id, u.email, u.nickname, u.locale, u.score, u.avatarTextureId,
          u.passwordHash, u.role, u.registrationIp, u.isDarkMode ? 1 : 0,
          u.lastSignAt, u.emailVerifiedAt, u.createdAt, u.updatedAt, conflicts.has(u.email.toLowerCase()) ? 1 : 0,
        ],
      };
    },
  });
  // written 用实际落库数：INSERT OR IGNORE 可能静默吞掉违反唯一约束的行
  const inserted = await flush(ctx.target, result.statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'users', total: result.total, skipped: result.skipped,
    written: ctx.dryRun ? 0 : inserted,
    ignored: result.statements.length - inserted,
    adjusted,
  };
}

export async function stageTextures(ctx: StageContext, skipOffset: number): Promise<StageResult> {
  const validUserIds = new Set((await ctx.target.query(S.NEW_USER_IDS)).map(row => Number(row['id'])));
  const adjusted: Record<string, number> = {};
  const result = await pageLoop({
    source: ctx.source,
    countSql: S.COUNT_TEXTURES,
    fetchSql: S.FETCH_TEXTURES,
    batchSize: ctx.batchSize,
    skipOffset,
    log: (m) => ctx.log(`  textures: ${m}`),
    skip: (row) => {
      const hash = String(row['hash'] ?? '');
      return ctx.presentHashes !== null && !ctx.presentHashes.has(hash)
        ? 'texture-file-missing' : null;
    },
    map: (row) => {
      const t = mapTexture(row as never, ctx.tz);
      if (!ctx.dryRun && t.uploaderId !== null && !validUserIds.has(t.uploaderId)) {
        t.uploaderId = null;
        adjusted['uploader-cleared'] = (adjusted['uploader-cleared'] ?? 0) + 1;
      }
      // 宽高不在旧库里：从磁盘 PNG 的 IHDR 读（缺文件行为 0，请求时
      // 由协议层兜底）。读失败不阻塞迁移。
      let width = 0;
      let height = 0;
      if (ctx.texturesDir) {
        try {
          const bytes = readFileSync(join(ctx.texturesDir, t.hash));
          const dim = pngDimensions(bytes);
          if (dim) { width = dim.width; height = dim.height; }
        } catch { /* 文件缺失已在 skip 里计数 */ }
      }
      return {
        sql: S.INSERT_TEXTURE,
        params: [
          t.id, t.hash, t.kind, t.model, t.name, t.uploaderId,
          t.sizeBytes, t.visibility,
          width, height,
          t.likes, t.createdAt, t.updatedAt,
        ],
      };
    },
  });
  const inserted = await flush(ctx.target, result.statements, ctx.batchSize, ctx.dryRun);
  return {
    stage: 'textures', total: result.total, skipped: result.skipped,
    written: ctx.dryRun ? 0 : inserted,
    ignored: result.statements.length - inserted,
    adjusted,
  };
}
