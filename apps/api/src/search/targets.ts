// 搜索字段 → SQL 绑定表。
//
// 键必须与 packages/shared 的 SEARCH_SCHEMAS 对应目标一一对应（有测试锁住），
// 值里的表别名必须与各仓储/服务实际拼出的查询一致 —— 表达式在 URL 里，绑定表在
// 代码里，两者对不上只会在运行时变成"列不存在"，所以每个入口都注明查询处。
import { nowMs, textCast } from '@pigeon-skin/db';
import type { FieldBinding, SearchTarget } from './compile.ts';

/** 有服务端查询的搜索入口。前端内存过滤的目标（手册/文案/Live2D/材质选择器）不在此列。 */
export const SERVER_SEARCH_KEYS = [
  'textures', 'closet', 'adminUsers', 'adminTextures', 'adminPlayers', 'auditLog', 'tickets', 'votes', 'yggLogs',
] as const;

export type ServerSearchKey = (typeof SERVER_SEARCH_KEYS)[number];

/**
 * 每个 SQL 目标对应的搜索 schema。
 *
 * 公开皮库与后台材质是两个 schema（后台多一个 size 字段）但共用一套绑定表，
 * 因此绑定表的键允许是这些 schema 字段的并集 —— 多出来的键不会被引用，也不会出错。
 */
export const TARGET_SCHEMAS: Record<ServerSearchKey, readonly string[]> = {
  textures: ['textures', 'adminTextures'],
  closet: ['closet'],
  adminUsers: ['adminUsers'],
  adminTextures: ['adminTextures'],
  adminPlayers: ['adminPlayers'],
  auditLog: ['auditLog'],
  tickets: ['tickets'],
  votes: ['votes'],
  yggLogs: ['yggLogs'],
};

const text = (column: string, fts?: { table: string; column: string; key: string }): FieldBinding =>
  ({ kind: 'text', column, ...(fts ? { fts } : {}) });
/** 枚举与文本形态的 id：等值/不等值 */
const string = (expr: string): FieldBinding => ({ kind: 'string', expr });
/** 数值与 epoch 毫秒日期：大小比较与区间 */
const value = (expr: string): FieldBinding => ({ kind: 'value', expr });
const flag = (expr: string): FieldBinding => ({ kind: 'boolean', expr });

/** 纹理名的全文索引路径：sqlite/mysql 走 FTS 子查询，postgres 走 pg_trgm 的 ILIKE。 */
const TEXTURE_NAME_FTS = { table: 'textures_fts', column: 'name', key: '"textures"."id"' };

/**
 * 投票状态是派生的：归档、草稿、以及按时间窗推导的 active/ended/scheduled。
 * 时间用 SQL 的当前时间，避免把请求时刻当成绑定参数混进片段。
 * 公开列表与后台列表共用这一个表达式，避免两处状态语义漂移。
 */
export function voteStatusExpr(alias: string): string {
  const now = nowMs();
  return `CASE WHEN ${alias}.archived_at IS NOT NULL THEN 'archived'`
    + ` WHEN ${alias}.status != 'published' THEN ${alias}.status`
    + ` WHEN ${alias}.ends_at <= ${now} THEN 'ended'`
    + ` WHEN ${alias}.starts_at > ${now} THEN 'scheduled'`
    + ' ELSE \'active\' END';
}

/** 纹理列表（公开与后台共用）：from textures left join users。 */
function textureBindings(): SearchTarget {
  return {
    name: text('"textures"."name"', TEXTURE_NAME_FTS),
    uploader: text('"users"."nickname"'),
    kind: string('"textures"."kind"'),
    model: string('"textures"."model"'),
    visibility: string('"textures"."visibility"'),
    official: flag('"textures"."official_key" IS NOT NULL'),
    likes: value('"textures"."likes"'),
    size: value('"textures"."size_bytes"'),
    created: value('"textures"."created_at"'),
    id: value('"textures"."id"'),
  };
}

/**
 * 取得某个入口的字段绑定表。必须在请求内调用 —— 方言片段（nowMs）是运行时求值的。
 */
export function searchTarget(key: ServerSearchKey): SearchTarget {
  switch (key) {
    // repositories/textures.ts listTextures 与 repositories/admin.ts listAdminTextures
    // 都是 from textures left join users，绑定表一致（后台的 size 字段公开端不可用，
    // 但公开端的 schema 未声明该字段，多余的绑定不会被引用）。
    case 'textures':
    case 'adminTextures':
      return textureBindings();

    // repositories/social.ts listCloset（from closet inner join textures）
    case 'closet':
      return {
        name: [text('"closet"."item_name"'), text('"textures"."name"', TEXTURE_NAME_FTS)],
        kind: string('"textures"."kind"'),
        created: value('"closet"."created_at"'),
      };

    // repositories/admin.ts listAdminUsers（from users）
    case 'adminUsers':
      return {
        email: text('"users"."email"'),
        nickname: text('"users"."nickname"'),
        role: string('"users"."role"'),
        score: value('"users"."score"'),
        verified: flag('"users"."email_verified_at" IS NOT NULL'),
        created: value('"users"."created_at"'),
        id: value('"users"."id"'),
      };

    // repositories/admin.ts listAdminPlayers（from players left join users）
    case 'adminPlayers':
      return {
        name: text('"players"."name"'),
        owner: text('"users"."nickname"'),
        created: value('"players"."created_at"'),
        updated: value('"players"."updated_at"'),
        id: value('"players"."id"'),
      };

    // services/admin.ts listAuditLog（from audit_log a left join users u）
    case 'auditLog':
      return {
        action: text('a.action'),
        actor: [text('u.email'), text(textCast('a.actor_id'))],
        target: [text('a.target_type'), text(textCast('a.target_id'))],
        detail: text('a.detail'),
        created: value('a.created_at'),
        id: value('a.id'),
      };

    // services/tickets.ts listAdmin（from tickets t join users u）
    case 'tickets':
      return {
        title: text('t.title'),
        number: text('t.ticket_number'),
        user: [text('u.email'), text('u.nickname'), text(textCast('t.user_id'))],
        status: string('t.status'),
        category: value('t.category_id'),
        created: value('t.created_at'),
        updated: value('t.updated_at'),
        id: value('t.id'),
      };

    // routes/votes.ts 后台列表（from pigeon_votes v）
    case 'votes':
      return {
        title: text('v.title'),
        status: string(voteStatusExpr('v')),
        starts: value('v.starts_at'),
        ends: value('v.ends_at'),
        created: value('v.created_at'),
      };

    // routes/integrations.ts 后台日志（from ygg_log y left join players p / users u）
    case 'yggLogs':
      return {
        action: text('y.action'),
        body: text('y.body'),
        player: [text('p.name'), text(textCast('y.player_id'))],
        user: [text('u.nickname'), text('u.email'), text(textCast('y.user_id'))],
        ip: text('y.ip'),
        created: value('y.created_at'),
        id: value('y.id'),
      };
  }
}
