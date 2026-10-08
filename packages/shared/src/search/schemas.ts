// 各搜索入口的字段表。
//
// 字段表是"能被搜索的东西"的唯一事实来源：后端据此把表达式编译成 SQL，
// 前端据此做提交前校验并渲染"高级搜索"帮助面板。加一个可搜索字段时只改这里，
// 前后端自动同步 —— 与 schemas.ts 的用意一致。
//
// 字段名与别名都用小写书写；匹配时大小写不敏感。
import { LOCALES } from '../locale.ts';
import type { SearchField, SearchSchema } from './expression.ts';

const TICKET_STATUSES = ['pending', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const;
// 投票状态是派生的：published 会按时间窗成为 active/scheduled/ended，
// 关闭/取消保持原值，归档单独成态。这里必须与实际可达的状态集一致。
const VOTE_STATUSES = ['draft', 'closed', 'cancelled', 'scheduled', 'active', 'ended', 'archived'] as const;

type FieldPatch = Partial<Omit<SearchField, 'name' | 'type' | 'labelKey'>>;

const text = (name: string, labelKey: string, patch: FieldPatch = {}): SearchField => ({ name, type: 'text', labelKey, ...patch });
const enumField = (name: string, labelKey: string, values: readonly string[], patch: FieldPatch = {}): SearchField => ({ name, type: 'enum', labelKey, values: values.map(value => value.toLowerCase()), ...patch });
const number = (name: string, labelKey: string, patch: FieldPatch = {}): SearchField => ({ name, type: 'number', labelKey, ...patch });
const date = (name: string, labelKey: string, patch: FieldPatch = {}): SearchField => ({ name, type: 'date', labelKey, aliases: ['created_at'], ...patch });
const flag = (name: string, labelKey: string, patch: FieldPatch = {}): SearchField => ({ name, type: 'boolean', labelKey, ...patch });

const ID_FIELD = number('id', 'search.field.id');
const CREATED_FIELD = date('created', 'search.field.created');

/** 所有搜索目标的字段表。键同时是前端引用帮助面板的标识。 */
export const SEARCH_SCHEMAS = {
  /** 皮肤库（公开） */
  textures: { fields: [
    text('name', 'search.field.textureName', { fallback: true }),
    text('uploader', 'search.field.uploader', { aliases: ['author', 'user'] }),
    enumField('kind', 'search.field.kind', ['skin', 'cape']),
    enumField('model', 'search.field.model', ['default', 'slim']),
    enumField('visibility', 'search.field.visibility', ['public', 'private']),
    flag('official', 'search.field.official'),
    number('likes', 'search.field.likes'),
    CREATED_FIELD,
    ID_FIELD,
  ] },
  /** 我的衣柜 */
  closet: { fields: [
    text('name', 'search.field.closetName', { fallback: true }),
    enumField('kind', 'search.field.kind', ['skin', 'cape']),
    date('created', 'search.field.collectedAt'),
  ] },
  /** 后台用户 */
  adminUsers: { fields: [
    text('email', 'search.field.email', { fallback: true }),
    text('nickname', 'search.field.nickname', { aliases: ['name'], fallback: true }),
    enumField('role', 'search.field.role', ['banned', 'normal', 'admin', 'super_admin']),
    number('score', 'search.field.score'),
    flag('verified', 'search.field.verified'),
    CREATED_FIELD,
    ID_FIELD,
  ] },
  /** 后台材质 */
  adminTextures: { fields: [
    text('name', 'search.field.textureName', { fallback: true }),
    text('uploader', 'search.field.uploader', { aliases: ['author', 'user'] }),
    enumField('kind', 'search.field.kind', ['skin', 'cape']),
    enumField('model', 'search.field.model', ['default', 'slim']),
    enumField('visibility', 'search.field.visibility', ['public', 'private']),
    flag('official', 'search.field.official'),
    number('likes', 'search.field.likes'),
    number('size', 'search.field.size', { unitKey: 'search.unit.bytes' }),
    CREATED_FIELD,
    ID_FIELD,
  ] },
  /** 后台角色 */
  adminPlayers: { fields: [
    text('name', 'search.field.playerName', { aliases: ['player'], fallback: true }),
    text('owner', 'search.field.owner', { aliases: ['uploader', 'user'] }),
    date('created', 'search.field.created'),
    date('updated', 'search.field.updated', { aliases: ['updated_at'] }),
    ID_FIELD,
  ] },
  /** 审计日志 */
  auditLog: { fields: [
    text('action', 'search.field.action', { fallback: true }),
    text('actor', 'search.field.actor', { fallback: true }),
    text('target', 'search.field.target'),
    text('detail', 'search.field.detail', { fallback: true }),
    CREATED_FIELD,
    ID_FIELD,
  ] },
  /** 工单 */
  tickets: { fields: [
    text('title', 'search.field.title', { aliases: ['subject'], fallback: true }),
    text('number', 'search.field.ticketNumber', { aliases: ['no'] }),
    text('user', 'search.field.user', { fallback: true }),
    enumField('status', 'search.field.status', TICKET_STATUSES),
    number('category', 'search.field.category'),
    date('created', 'search.field.created'),
    date('updated', 'search.field.updated', { aliases: ['updated_at'] }),
    ID_FIELD,
  ] },
  /** 投票（管理列表） */
  votes: { fields: [
    text('title', 'search.field.voteTitle', { fallback: true }),
    enumField('status', 'search.field.status', VOTE_STATUSES),
    date('starts', 'search.field.startsAt', { aliases: ['starts_at'] }),
    date('ends', 'search.field.endsAt', { aliases: ['ends_at'] }),
    CREATED_FIELD,
  ] },
  /** Yggdrasil 请求日志 */
  yggLogs: { fields: [
    text('action', 'search.field.action', { fallback: true }),
    text('body', 'search.field.logBody', { fallback: true }),
    text('player', 'search.field.playerName', { fallback: true }),
    text('user', 'search.field.user', { fallback: true }),
    text('ip', 'search.field.ip'),
    CREATED_FIELD,
    ID_FIELD,
  ] },
  /** 用户手册（前端内存过滤） */
  manual: { fields: [
    text('title', 'search.field.manualTitle', { fallback: true }),
    text('body', 'search.field.manualBody', { fallback: true }),
    text('group', 'search.field.manualGroup'),
  ] },
  /** 官网文案（前端内存过滤） */
  translations: { fields: [
    text('key', 'search.field.translationKey', { fallback: true }),
    text('value', 'search.field.translationValue', { fallback: true }),
    enumField('locale', 'search.field.locale', LOCALES),
  ] },
  /** Live2D 模型（前端内存过滤） */
  live2d: { fields: [
    text('name', 'search.field.modelName', { fallback: true }),
    text('id', 'search.field.id'),
  ] },
  /** 用户资料页的头像选择器（前端内存过滤，只有材质名可用） */
  avatars: { fields: [
    text('name', 'search.field.textureName', { fallback: true }),
    ID_FIELD,
  ] },
  /** 角色页的材质选择器（前端内存过滤） */
  playerTextures: { fields: [
    text('name', 'search.field.textureName', { fallback: true }),
    enumField('kind', 'search.field.kind', ['skin', 'cape']),
    enumField('model', 'search.field.model', ['default', 'slim']),
    flag('official', 'search.field.official'),
    flag('closet', 'search.field.inCloset'),
  ] },
} as const satisfies Record<string, SearchSchema>;

export type SearchSchemaKey = keyof typeof SEARCH_SCHEMAS;

export function searchSchema(key: SearchSchemaKey): SearchSchema {
  return SEARCH_SCHEMAS[key];
}
