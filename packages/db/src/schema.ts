// Drizzle 类型化查询层。
//
// SQL 迁移是约束与索引的事实来源。schema 中声明的主键/唯一约束用于 Drizzle
// 类型和查询构造；迁移契约测试校验声明与实际 SQLite 表列一致。
// 特殊索引、FTS5、触发器及 COLLATE NOCASE 仍只在迁移中定义。
//
// 时间戳统一是 UTC epoch 毫秒（INTEGER），布尔是 INTEGER 0/1。

import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  legacyEmailConflict: integer('legacy_email_conflict', { mode: 'boolean' }).notNull().default(false),
  mergedIntoUserId: integer('merged_into_user_id'),
  emailVerifiedAt: integer('email_verified_at'),
  nickname: text('nickname').notNull().default(''),
  locale: text('locale'),
  score: integer('score').notNull().default(1000),
  avatarTextureId: integer('avatar_texture_id'),
  /** 自描述格式 `<algo>:<payload>`，见 @pigeon-skin/auth */
  passwordHash: text('password_hash').notNull(),
  needsInitialization: integer('needs_initialization', { mode: 'boolean' }).notNull().default(false),
  passwordRehashRequired: integer('password_rehash_required', { mode: 'boolean' })
    .notNull().default(false),
  role: text('role').notNull().default('normal'),
  /** 个人签名（用户资料页） */
  signature: text('signature').notNull().default(''),
  registrationIp: text('registration_ip'),
  isDarkMode: integer('is_dark_mode', { mode: 'boolean' }).notNull().default(false),
  lastSignAt: integer('last_sign_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  /** sha256(原始令牌) 的十六进制；原始令牌只存在于 Cookie 里 */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  /** 空闲过期 */
  expiresAt: integer('expires_at').notNull(),
  /** 无论活跃与否的硬上限 */
  absoluteExpiresAt: integer('absolute_expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  revokedAt: integer('revoked_at'),
});

export const accountSecurity = sqliteTable('account_security', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(0),
  emailEnabled: integer('email_enabled', { mode: 'boolean' }).notNull().default(false),
  totpSecret: text('totp_secret'),
  totpLastStep: integer('totp_last_step').notNull().default(-1),
  webauthnUserId: text('webauthn_user_id').notNull().unique(),
});
export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), publicKey: text('public_key').notNull(), counter: integer('counter').notNull(),
  transports: text('transports').notNull(), deviceType: text('device_type').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull(), createdAt: integer('created_at').notNull(),
});
export const recoveryCodes = sqliteTable('recovery_codes', {
  id: text('id').primaryKey(), userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
});
export const securityChallenges = sqliteTable('security_challenges', {
  id: text('id').primaryKey(), browserHash: text('browser_hash').notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), sessionId: text('session_id'),
  purpose: text('purpose').notNull(), version: integer('version'), credentialsHash: text('credentials_hash'),
  payload: text('payload').notNull().default('{}'), attempts: integer('attempts').notNull().default(0),
  emailHash: text('email_hash'), emailExpiresAt: integer('email_expires_at'), mailSentAt: integer('mail_sent_at'),
  claim: text('claim'), createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(),
});
export const securityReauth = sqliteTable('security_reauth', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(), claim: text('claim'), expiresAt: integer('expires_at').notNull(),
});

export const players = sqliteTable('players', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  name: text('name').notNull(),
  skinTextureId: integer('skin_texture_id'),
  capeTextureId: integer('cape_texture_id'),
  scorePaid: integer('score_paid').notNull().default(0),
  createdAt: integer('created_at'),
  /** 驱动协议的 Last-Modified 头 */
  updatedAt: integer('updated_at').notNull(),
});

export const textures = sqliteTable('textures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 存储字节的 sha256；同时是 R2 对象键与公开标识。不唯一，见 migrations 里的说明 */
  hash: text('hash').notNull(),
  kind: text('kind').notNull(),
  /** 披风为 null */
  model: text('model'),
  name: text('name').notNull(),
  officialKey: text('official_key'),
  catalogRevision: integer('catalog_revision').notNull().default(0),
  uploaderId: integer('uploader_id'),
  sourceResourceId: integer('source_resource_id'),
  origin: text('origin').notNull().default('original'),
  sizeBytes: integer('size_bytes').notNull(),
  scoreRefundBasis: integer('score_refund_basis').notNull().default(0),
  scoreAward: integer('score_award').notNull().default(0),
  visibility: text('visibility').notNull().default('public'),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  /** 反范式化的收藏计数；皮库按它排序，用 COUNT(*) 会是表扫描 */
  likes: integer('likes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const closet = sqliteTable('closet', {
  userId: integer('user_id').notNull(),
  textureId: integer('texture_id').notNull(),
  itemName: text('item_name'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.textureId] })]);

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  textureId: integer('texture_id').notNull(),
  /** 举报时刻纹理所有者的快照，不随之后变化重算 */
  uploaderId: integer('uploader_id'),
  reporterId: integer('reporter_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  reviewerId: integer('reviewer_id'),
  resolution: text('resolution'),
  createdAt: integer('created_at').notNull(),
  reviewedAt: integer('reviewed_at'),
});

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  readAt: integer('read_at'),
  createdAt: integer('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').notNull(),
  /** '' 表示全局值；否则为某语言的覆盖 */
  locale: text('locale').notNull().default(''),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.key, t.locale] })]);

export const translationOverrides = sqliteTable('translation_overrides', {
  locale: text('locale').notNull(), key: text('key').notNull(), value: text('value').notNull(), updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.locale, t.key] })]);
export const setupGuard = sqliteTable('setup_guard', {
  id: integer('id').primaryKey(), nonce: text('nonce').notNull(), createdAt: integer('created_at').notNull(),
});
export const searchSubmissions = sqliteTable('search_submissions', {
  engine: text('engine').notNull(), textureId: integer('texture_id').notNull(), revision: text('revision').notNull(),
  status: text('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0),
  nextAt: integer('next_at').notNull(), httpStatus: integer('http_status'), error: text('error'), updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.engine, t.textureId] })]);
export const legacyAccountMerges = sqliteTable('legacy_account_merges', {
  id: text('id').primaryKey(), email: text('email').notNull(), retainedUserId: integer('retained_user_id').notNull(),
  mergedUserIds: text('merged_user_ids').notNull(), archivedData: text('archived_data').notNull().default('{}'), createdAt: integer('created_at').notNull(),
});
export const officialCatalogState = sqliteTable('official_catalog_state', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull(),
});
export const userDefaultCatalog = sqliteTable('user_default_catalog', {
  userId: integer('user_id').primaryKey(), revision: integer('revision').notNull().default(0),
});
export const officialResourceSync = sqliteTable('official_resource_sync', {
  id: integer('id').primaryKey(), checkedAt: integer('checked_at'), succeededAt: integer('succeeded_at'), startedAt: integer('started_at'),
  clientVersion: text('client_version').notNull().default('1.21.4'), added: integer('added').notNull().default(0),
  updated: integer('updated').notNull().default(0), pending: integer('pending').notNull().default(0), error: text('error'),
  phase: text('phase').notNull().default('idle'),
});
export const officialResourceBatches = sqliteTable('official_resource_batches', {
  jobId: text('job_id').notNull(), batchKey: text('batch_key').notNull(), added: integer('added').notNull(), updated: integer('updated').notNull(),
}, (t) => [primaryKey({ columns: [t.jobId, t.batchKey] })]);

export const manualDocuments = sqliteTable('manual_documents', {
  slug: text('slug').notNull(),
  locale: text('locale').notNull().default(''),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.slug, t.locale] })]);

export const manualAssets = sqliteTable('manual_assets', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  uploadedAt: integer('uploaded_at').notNull(),
});

export const verificationTokens = sqliteTable('verification_tokens', {
  /** sha256(原始令牌) */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  email: text('email').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

export const authAttempts = sqliteTable('auth_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ip: text('ip').notNull(),
  identifier: text('identifier'),
  kind: text('kind').notNull(),
  succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorId: integer('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: integer('target_id'),
  detail: text('detail'),
  createdAt: integer('created_at').notNull(),
});

export const tickets = sqliteTable('tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketNumber: text('ticket_number').notNull(),
  userId: integer('user_id').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  categoryId: integer('category_id'),
  categoryName: text('category_name').notNull().default(''),
  description: text('description').notNull(),
  status: text('status').notNull().default('pending'),
  lastUserReadAt: integer('last_user_read_at'),
  lastAdminReadAt: integer('last_admin_read_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  closedAt: integer('closed_at'),
});

export const ticketCategories = sqliteTable('ticket_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const ticketMessages = sqliteTable('ticket_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull(),
  authorId: integer('author_id'),
  authorType: text('author_type').notNull(),
  body: text('body').notNull(),
  internal: integer('internal', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const ticketAttachments = sqliteTable('ticket_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull(),
  messageId: integer('message_id'),
  objectKey: text('object_key').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const ticketEvents = sqliteTable('ticket_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull(),
  actorId: integer('actor_id'),
  type: text('type').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  detail: text('detail'),
  createdAt: integer('created_at').notNull(),
});

// ── 插件内置化（migration 0002）──────────────────────────────────────────────

export const userIdentities = sqliteTable('user_identities', {
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  userId: integer('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.provider, t.providerUserId] })]);

export const mojangVerifications = sqliteTable('mojang_verifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().unique(),
  uuid: text('uuid').notNull().unique(),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

export const uuidMap = sqliteTable('uuid', {
  playerId: integer('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
  name: text('name').notNull().unique(),
  version: integer('version').notNull().default(0),
  uuid: text('uuid').notNull().unique(),
});

export const uuidArchive = sqliteTable('uuid_archive', {
  name: text('name'), uuid: text('uuid'),
});

export const yggLog = sqliteTable('ygg_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ip: text('ip'),
  action: text('action').notNull(),
  body: text('body'),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  playerId: integer('player_id').references(() => players.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
});

export const texturesDescription = sqliteTable('textures_description', {
  tid: integer('tid').primaryKey(),
  description: text('description').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
});

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  textureId: integer('texture_id').notNull(),
  userId: integer('user_id'),
  userName: text('user_name').notNull().default(''),
  content: text('content').notNull(),
  status: text('status').notNull().default('published'),
  aiFlagged: integer('ai_flagged', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const yggTokens = sqliteTable('ygg_tokens', {
  playerId: integer('player_id').references(() => players.id, { onDelete: 'cascade' }),
  profileUuid: text('profile_uuid'),
  profileVersion: integer('profile_version'),
  source: text('source').notNull().default('traditional'),
  grantId: text('grant_id'),
  scopes: text('scopes').notNull().default('[]'),
  /** sha256(accessToken) */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  clientToken: text('client_token').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  refreshDeadline: integer('refresh_deadline').notNull(),
});

export const yggSessions = sqliteTable('ygg_sessions', {
  serverHash: text('server_hash').notNull(), playerId: integer('player_id').notNull(),
  profileUuid: text('profile_uuid').notNull(), profileVersion: integer('profile_version').notNull(),
  tokenId: text('token_id').notNull(), ip: text('ip').notNull(), expiresAt: integer('expires_at').notNull(),
}, (t) => [primaryKey({ columns: [t.serverHash, t.playerId] })]);

export const connectClients = sqliteTable('connect_clients', {
  id: text('id').primaryKey(), name: text('name').notNull(), secretHash: text('secret_hash'),
  redirectUris: text('redirect_uris').notNull(), enabled: integer('enabled').notNull().default(1),
  shared: integer('shared').notNull().default(0), createdAt: integer('created_at').notNull(),
  userId: integer('user_id'),
});
export const connectKeys = sqliteTable('connect_keys', {
  kid: text('kid').primaryKey(), privateJwk: text('private_jwk').notNull(), publicJwk: text('public_jwk').notNull(),
  createdAt: integer('created_at').notNull(), retiredAt: integer('retired_at'),
});
export const connectGrants = sqliteTable('connect_grants', {
  id: text('id').primaryKey(), userId: integer('user_id').notNull(), clientId: text('client_id').notNull(),
  playerId: integer('player_id'), scopes: text('scopes').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), revokedAt: integer('revoked_at'), authTime: integer('auth_time').notNull().default(0),
});
export const connectInteractions = sqliteTable('connect_interactions', {
  id: text('id').primaryKey(), clientId: text('client_id').notNull(), userId: integer('user_id'),
  params: text('params').notNull(), expiresAt: integer('expires_at').notNull(), consumedAt: integer('consumed_at'), consumeKey: text('consume_key'),
});
export const connectCodes = sqliteTable('connect_codes', {
  id: text('id').primaryKey(), grantId: text('grant_id').notNull(), redirectUri: text('redirect_uri').notNull(),
  challenge: text('challenge'), nonce: text('nonce'), expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'), consumeKey: text('consume_key'),
});
export const connectRefresh = sqliteTable('connect_refresh', {
  id: text('id').primaryKey(), grantId: text('grant_id').notNull(), scopes: text('scopes').notNull(),
  expiresAt: integer('expires_at').notNull(), consumedAt: integer('consumed_at'), consumeKey: text('consume_key'),
});
export const connectDevices = sqliteTable('connect_devices', {
  id: text('id').primaryKey(), userCodeHash: text('user_code_hash').notNull(), clientId: text('client_id').notNull(),
  scopes: text('scopes').notNull(), grantId: text('grant_id'), expiresAt: integer('expires_at').notNull(),
  nextPollAt: integer('next_poll_at').notNull().default(0), intervalSeconds: integer('interval_seconds').notNull().default(5),
  denied: integer('denied').notNull().default(0), consumedAt: integer('consumed_at'), consumeKey: text('consume_key'),
});
export const connectResponses = sqliteTable('connect_responses', {
  id: text('id').primaryKey(), userId: integer('user_id'), body: text('body').notNull(), expiresAt: integer('expires_at').notNull(),
});
export const oauthLoginStates = sqliteTable('oauth_login_states', {
  id: text('id').primaryKey(), provider: text('provider').notNull(), browserHash: text('browser_hash').notNull(),
  userId: integer('user_id'), sessionId: text('session_id'), verifier: text('verifier').notNull(),
  destination: text('destination').notNull(), expiresAt: integer('expires_at').notNull(),
});

export const pigeonApiKeys = sqliteTable('pigeon_api_keys', {
  id: text('id').primaryKey(), label: text('label').notNull(), secretHash: text('secret_hash').notNull(),
  prefix: text('prefix').notNull(), scopes: text('scopes').notNull(), createdBy: integer('created_by'),
  enabled: integer('enabled').notNull().default(1), revokedAt: integer('revoked_at'), createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'), usageCount: integer('usage_count').notNull().default(0),
  windowStart: integer('window_start').notNull().default(0), windowCount: integer('window_count').notNull().default(0),
});
export const pigeonPacks = sqliteTable('pigeon_packs', {
  id: integer('id').primaryKey({ autoIncrement: true }), name: text('name').notNull(),
  serverType: text('server_type').notNull(), enabled: integer('enabled').notNull().default(1),
});
export const pigeonVotes = sqliteTable('pigeon_votes', {
  id: text('id').primaryKey(), title: text('title').notNull(), description: text('description').notNull().default(''),
  status: text('status').notNull(), startsAt: integer('starts_at').notNull(), endsAt: integer('ends_at').notNull(),
  maxChoices: integer('max_choices').notNull(), resultsPolicy: text('results_policy').notNull(), registeredBefore: integer('registered_before'),
  minScore: integer('min_score').notNull().default(0), requireVerified: integer('require_verified').notNull().default(0),
  playRules: text('play_rules').notNull().default('[]'), createdBy: integer('created_by'), createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(), closedAt: integer('closed_at'), archivedAt: integer('archived_at'),
  version: integer('version').notNull().default(1), mutationKey: text('mutation_key'),
  reviewRequired: integer('review_required').notNull().default(0), reviewNotes: text('review_notes').notNull().default('[]'),
});
export const pigeonVoteOptions = sqliteTable('pigeon_vote_options', {
  id: text('id').primaryKey(), voteId: text('vote_id').notNull(), title: text('title').notNull(),
  description: text('description').notNull().default(''), position: integer('position').notNull(),
});
export const pigeonBallots = sqliteTable('pigeon_ballots', {
  id: text('id').primaryKey(), voteId: text('vote_id').notNull(), userId: integer('user_id'), voterName: text('voter_name').notNull(),
  optionIds: text('option_ids').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  ip: text('ip'), revision: integer('revision').notNull().default(1),
});
export const pigeonBallotEvents = sqliteTable('pigeon_ballot_events', {
  id: integer('id').primaryKey({ autoIncrement: true }), ballotId: text('ballot_id').notNull(),
  optionIds: text('option_ids').notNull(), createdAt: integer('created_at').notNull(), revision: integer('revision').notNull(),
});
export const pigeonLegacyArchive = sqliteTable('pigeon_legacy_archive', {
  sourceTable: text('source_table').notNull(), legacyId: text('legacy_id').notNull(), payload: text('payload').notNull(),
}, (t) => [primaryKey({ columns: [t.sourceTable, t.legacyId] })]);

export type UserIdentitiesRow = typeof userIdentities.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type TexturesDescriptionRow = typeof texturesDescription.$inferSelect;

/** 从行里推断出的类型，供 service 层使用 */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type PlayerRow = typeof players.$inferSelect;
export type TextureRow = typeof textures.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ClosetRow = typeof closet.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
