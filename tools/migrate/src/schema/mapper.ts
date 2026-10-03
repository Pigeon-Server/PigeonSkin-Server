// 行级映射：旧库行 → 新库行。
//
// 这里沉淀的是 docs/rewrite/10-migration-mapping.md 的每一条规则。
// mapper 是纯函数（输入旧行，输出新行或"跳过"决定），不碰数据库 ——
// 这样每一行映射逻辑都能脱离真实连接被测试。
//
// 决定"跳过一行"时必须给出机器码 reason，最终进迁移报告。
import { legacyDateTimeToEpoch, normalizeLastSignAt } from '../lib/date.ts';
import { LOCALE_ALIASES, type LegacyPasswordAlgo } from './legacy.ts';

// ── users ───────────────────────────────────────────────────────────────────

export type NewRole = 'super_admin' | 'admin' | 'normal' | 'banned';

/** 旧 permission 是有序整数；其余值没有语义，回落 normal */
export function legacyPermissionToRole(permission: unknown): NewRole {
  const n = Number(permission);
  if (n === 2) return 'super_admin';
  if (n === 1) return 'admin';
  if (n === -1) return 'banned';
  return 'normal';
}

export function normalizeLocale(locale: unknown): string | null {
  if (typeof locale !== 'string' || locale === '') return null;
  return LOCALE_ALIASES[locale] ?? locale;
}

export interface UserRowInput {
  uid: number;
  email: string;
  nickname: string;
  locale: unknown;
  score: number;
  avatar: number;
  password: string;
  ip: unknown;
  is_dark_mode: number;
  permission: number;
  last_sign_at: unknown;
  register_at: unknown;
  verified: number;
}

export interface UserRowOutput {
  id: number;
  email: string;
  nickname: string;
  locale: string | null;
  score: number;
  avatarTextureId: number | null;
  passwordHash: string;
  role: NewRole;
  registrationIp: string | null;
  isDarkMode: boolean;
  lastSignAt: number | null;
  emailVerifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 映射一行 users。
 *
 * 空邮箱 / 重复邮箱是阻塞项（analyze 已拦），migrate 运行前强制要求先通过
 * analyze，因此这里不做这些校验 —— 做了也只是把同一件事查两遍。
 */
export function mapUser(row: UserRowInput, tz: string, pwd: LegacyPasswordAlgo): UserRowOutput {
  const createdAt = legacyDateTimeToEpoch(row.register_at, tz) ?? 0;
  const verifiedAt = Number(row.verified) === 1 ? (createdAt || null) : null;
  const registeredIp = typeof row.ip === 'string' && row.ip !== '' ? row.ip : null;
  const lastSign = normalizeLastSignAt(
    legacyDateTimeToEpoch(row.last_sign_at, tz), createdAt,
  );

  return {
    id: row.uid,
    email: row.email,
    nickname: row.nickname,
    locale: normalizeLocale(row.locale),
    score: row.score,
    // 旧库 avatar=0 表示无头像；指向不存在纹理的行由导入器置空
    avatarTextureId: Number(row.avatar) > 0 ? row.avatar : null,
    passwordHash: wrapHash(pwd, row.password),
    role: legacyPermissionToRole(row.permission),
    registrationIp: registeredIp,
    isDarkMode: Number(row.is_dark_mode) === 1,
    lastSignAt: lastSign,
    emailVerifiedAt: verifiedAt,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * 把旧哈希包装为新库的自描述格式 `<algo>:<payload>`。
 * 与 packages/auth 的 wrapLegacyHash 语义一致（algo 键来自同一张映射表），
 * 但这里不 import @pigeon-skin/auth —— 迁移工具必须独立于运行时可执行，
 * 否则 Worker 端的依赖变化会悄悄改变历史数据迁移的语义。
 */
function wrapHash(algo: LegacyPasswordAlgo, rawHash: string): string {
  return `${algo}:${rawHash}`;
}

// ── textures ─────────────────────────────────────────────────────────────────

export interface TextureRowInput {
  tid: number;
  name: string;
  type: string;
  hash: string;
  size: number;
  uploader: number;
  public: number;
  upload_at: unknown;
  likes: number;
}

export interface TextureRowOutput {
  id: number;
  hash: string;
  kind: 'skin' | 'cape';
  model: 'default' | 'slim' | null;
  name: string;
  uploaderId: number | null;
  sizeBytes: number;
  visibility: 'public' | 'private';
  likes: number;
  createdAt: number;
  updatedAt: number;
}

/** 旧 type → 新 (kind, model)。未知类型回落 steve/default（analyze 会报告）。 */
export function legacyTypeToKindModel(type: unknown): {
  kind: 'skin' | 'cape'; model: 'default' | 'slim' | null;
} {
  switch (type) {
    case 'alex': return { kind: 'skin', model: 'slim' };
    case 'cape': return { kind: 'cape', model: null };
    case 'steve':
    default: return { kind: 'skin', model: 'default' };
  }
}

export function mapTexture(row: TextureRowInput, tz: string): TextureRowOutput {
  const createdAt = legacyDateTimeToEpoch(row.upload_at, tz) ?? 0;
  const { kind, model } = legacyTypeToKindModel(row.type);
  return {
    id: row.tid,
    hash: row.hash,
    kind,
    model,
    name: row.name,
    // 旧库 uploader=0 表示"已注销用户"（没有 uid=0 的用户）
    uploaderId: Number(row.uploader) > 0 ? row.uploader : null,
    sizeBytes: Number(row.size) * 1024, // 旧库存 KB，新库存字节
    visibility: Number(row.public) === 1 ? 'public' : 'private',
    likes: row.likes,
    createdAt,
    updatedAt: createdAt,
  };
}


/** 从 PNG 字节解析 IHDR 宽高；解析失败返回 null */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

// ── players ───────────────────────────────────────────────────────────────────

export interface PlayerRowInput {
  pid: number;
  uid: number;
  name: string;
  tid_skin: number;
  tid_cape: number;
  last_modified: unknown;
}

export interface PlayerRowOutput {
  id: number;
  userId: number;
  name: string;
  skinTextureId: number | null;
  capeTextureId: number | null;
  createdAt: number | null;
  updatedAt: number;
}

/**
 * 旧库的"无纹理"有三种表示：0、-1（旧默认值）、指向不存在的 tid。
 * 前两种在这里归一化为 null；第三种由导入器依据纹理存在性过滤。
 */
export function normalizeLegacyTid(tid: unknown): number | null {
  const n = Number(tid);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function mapPlayer(row: PlayerRowInput, tz: string): PlayerRowOutput {
  const updatedAt = legacyDateTimeToEpoch(row.last_modified, tz) ?? 0;
  return {
    id: row.pid,
    userId: row.uid,
    name: row.name,
    skinTextureId: normalizeLegacyTid(row.tid_skin),
    capeTextureId: normalizeLegacyTid(row.tid_cape),
    createdAt: updatedAt, // 旧库没有独立的创建时间列
    updatedAt,
  };
}

// ── reports ─────────────────────────────────────────────────────────────────

export interface ReportRowInput {
  id: number;
  tid: number;
  uploader: number;
  reporter: number;
  reason: string;
  status: number;
  report_at: unknown;
}

export interface ReportRowOutput {
  id: number;
  textureId: number;
  uploaderId: number | null;
  reporterId: number;
  reason: string;
  status: 'pending' | 'resolved' | 'rejected';
  createdAt: number;
  reviewedAt: number | null;
}

/** 旧库 status 是 0/1/2（pending/resolved/rejected），无 reviewer 记录。 */
export function mapReport(row: ReportRowInput, tz: string): ReportRowOutput {
  const createdAt = legacyDateTimeToEpoch(row.report_at, tz) ?? 0;
  const status = Number(row.status) === 1 ? 'resolved' : Number(row.status) === 2 ? 'rejected' : 'pending';
  return {
    id: row.id,
    textureId: row.tid,
    uploaderId: Number(row.uploader) > 0 ? row.uploader : null,
    reporterId: row.reporter,
    reason: row.reason,
    status,
    reviewedAt: status === 'pending' ? null : createdAt,
    createdAt,
  };
}

// ── notifications ─────────────────────────────────────────────────────────────

export interface NotificationRowInput {
  id: string;
  type: string;
  notifiable_id: number;
  data: string;
  read_at: unknown;
  created_at: unknown;
}

export interface NotificationRowOutput {
  userId: number;
  type: string;
  title: string;
  body: string | null;
  readAt: number | null;
  createdAt: number;
}

/**
 * 旧通知 data 是 {title, content} 的 JSON。插件可能塞过别的结构 ——
 * 那些行用占位标题迁过来（analyze 已抽样报告），不做有损丢弃。
 * 旧通知 id 是 UUID、新表是自增 int，两者无对应关系，直接丢弃旧 id。
 */
export function mapNotification(
  row: NotificationRowInput,
  tz: string,
): NotificationRowOutput | null {
  const createdAt = legacyDateTimeToEpoch(row.created_at, tz);
  if (createdAt === null) return null; // 无创建时间的通知没有可读语义

  let title = '（无法解析的旧通知）';
  let body: string | null = null;
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if (typeof parsed['title'] === 'string') title = parsed['title'];
    if (typeof parsed['content'] === 'string') body = parsed['content'];
  } catch { /* 保留占位标题 */ }

  return {
    userId: row.notifiable_id,
    type: 'site_message',
    title,
    body,
    readAt: legacyDateTimeToEpoch(row.read_at, tz),
    createdAt,
  };
}

export { mapOptionRows } from './options.ts';
