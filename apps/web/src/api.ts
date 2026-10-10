// 类型化 API 客户端。
//
// 后端只返回机器码（如 auth.invalid_credentials），本地化文案由前端负责 ——
// 所以这里把错误码包装成一个带 code 的异常，交给调用方或 i18n 层映射。
import type { ErrorCode } from '@pigeon-skin/shared';
import { normalizeLocale, type Locale } from '@pigeon-skin/shared/locales';
import type { LoginResult, SecurityStatus, SecurityChallenge, SecondFactor } from '@pigeon-skin/shared/security';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';

export const securityApi = {
  status: () => request<SecurityStatus>('/api/v1/me/security'),
  reauth: (password = '') => request<{ requiresTwoFactor: boolean }>('/api/v1/me/security/reauth', { method: 'POST', json: { password } }),
  challenge: () => request<SecurityChallenge>('/api/v1/auth/2fa'),
  sendEmail: () => request<{ ok: boolean }>('/api/v1/auth/2fa/email', { method: 'POST', json: {} }),
  authenticationOptions: () => request<PublicKeyCredentialRequestOptionsJSON>('/api/v1/auth/2fa/passkey/options', { method: 'POST', json: {} }),
  verify: (method: SecondFactor, code = '', response?: AuthenticationResponseJSON) => request<{ requiresTwoFactor?: boolean; redirect?: string }>('/api/v1/auth/2fa/verify', { method: 'POST', json: { method, code, response } }),
  loginOptions: (remember: boolean, destination: string) => request<PublicKeyCredentialRequestOptionsJSON>('/api/v1/auth/passkeys/options', { method: 'POST', json: { remember, destination } }),
  passkeyLogin: (response: AuthenticationResponseJSON) => request<{ id: number; redirect: string }>('/api/v1/auth/passkeys/verify', { method: 'POST', json: response }),
  begin: (method: 'email' | 'totp') => request<{ secret?: string; uri?: string }>(`/api/v1/me/security/${method}/begin`, { method: 'POST', json: {} }),
  confirm: (method: 'email' | 'totp' | 'change-email', code: string) => request<{ recoveryCodes: string[] }>(`/api/v1/me/security/${method}/confirm`, { method: 'POST', json: { code } }),
  resend: (method: 'email' | 'change-email') => request<{ ok: boolean }>(`/api/v1/me/security/${method}/email`, { method: 'POST', json: {} }),
  registrationOptions: () => request<PublicKeyCredentialCreationOptionsJSON>('/api/v1/me/security/passkeys/options', { method: 'POST', json: {} }),
  registerPasskey: (name: string, response: RegistrationResponseJSON) => request<{ recoveryCodes: string[] }>('/api/v1/me/security/passkeys/verify', { method: 'POST', json: { name, response } }),
  remove: (method: 'email' | 'totp' | 'passkey', id = '') => request<{ ok: boolean }>(`/api/v1/me/security/methods/${method}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  disable: () => request<{ ok: boolean }>('/api/v1/me/security/disable', { method: 'POST', json: {} }),
  recovery: () => request<{ recoveryCodes: string[] }>('/api/v1/me/security/recovery', { method: 'POST', json: {} }),
  changeEmail: (email: string) => request<{ ok: boolean }>('/api/v1/me/security/change-email/begin', { method: 'POST', json: { email } }),
};
import type { ManualDocument, ManualDocumentInput, ManualAsset } from '@pigeon-skin/shared/manual';

export const manualApi = {
  assets: (page = 1) => request<{ items: ManualAsset[]; total: number; page: number }>(`/api/v1/admin/manual/assets?page=${page}`),
  upload: (file: File) => { const body = new FormData(); body.set('file', file); return request<ManualAsset>('/api/v1/admin/manual/assets', { method: 'POST', body }); },
  deleteAsset: (id: string) => request<void>(`/api/v1/admin/manual/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  list: (locale: Locale) => request<{ siteUrl: string; locale: Locale; items: ManualDocument[]; overrides: ManualDocument[] }>(`/api/v1/manual?locale=${locale}`),
  save: (slug: string, input: ManualDocumentInput, locale: Locale) => request<ManualDocument>(`/api/v1/admin/manual/${encodeURIComponent(slug || 'welcome')}?locale=${locale}`, { method: 'PUT', json: input }),
  reset: (slug: string, revision: number, locale: Locale) => request<void>(`/api/v1/admin/manual/${encodeURIComponent(slug || 'welcome')}?revision=${revision}&locale=${locale}`, { method: 'DELETE' }),
};
import type { Live2DDisplay, Live2DModelInfo } from '@pigeon-skin/shared/live2d';

export const live2dApi = {
  display: () => request<Live2DDisplay>('/api/v1/live2d'),
  admin: () => request<{ display: Live2DDisplay; items: Live2DModelInfo[] }>('/api/v1/admin/live2d'),
  save: (enabled: boolean, modelId: string) => request<Live2DDisplay>('/api/v1/admin/live2d', { method: 'PUT', json: { enabled, modelId } }),
  upload: (name: string, file: File) => {
    const body = new FormData();
    body.set('name', name);
    body.set('file', file);
    return request<Live2DModelInfo>('/api/v1/admin/live2d/models', { method: 'POST', body, signal: AbortSignal.timeout(120000) });
  },
};

export interface ApiErrorBody {
  error: ErrorCode | 'login_required' | 'access_denied' | 'invalid_request' | 'temporarily_unavailable';
  message?: string;
  fields?: Record<string, string>;
  accounts?: Array<{ id: number; nickname: string }>;
  requiresPasswords?: number[];
}

export type VoteStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'closed' | 'cancelled' | 'archived';
export interface VoteSummary { id: string; title: string; description: string; status: VoteStatus; startsAt: number; endsAt: number; maxChoices?: number; voted?: boolean; participants: number | null }
export interface VoteContent {
  title: string; description: string; startsAt: number; endsAt: number; maxChoices: number;
  resultsPolicy: 'after_close' | 'after_vote' | 'always'; registeredBefore: number | null; minScore: number; requireVerified: boolean;
  playRules: Array<{ kind: 'modpack' | 'server_type'; target: string; minSeconds: number }>;
  options: Array<{ id?: string; title: string; description: string }>;
}
export interface VoteDetail extends VoteSummary {
  closedAt?: number | null;
  reviewRequired?: boolean; reviewNotes?: Array<{ type: number; data: string }>;
  version: number; maxChoices: number; resultsVisible: boolean; resultsPolicy: VoteContent['resultsPolicy'];
  requirements: Pick<VoteContent, 'registeredBefore' | 'minScore' | 'requireVerified' | 'playRules'>;
  ballot: { optionIds: string[]; createdAt: number } | null;
  eligibility: { eligible: boolean; reason: string | null };
  options: Array<{ id: string; title: string; description: string; position: number; votes: number | null }>;
}
export interface VoteRecord { id: string; voteId: string; voteTitle: string; userId: number | null; voterName: string; optionTitles: string[]; optionIds: string[]; createdAt: number; ip: string | null }
export interface PigeonKeyItem { id: string; label: string; prefix: string; scopes: string; enabled: number; revokedAt: number | null; createdAt: number; lastUsedAt: number | null; usageCount: number }
export const voteApi = {
  list: (page = 1, status = '') => request<Paged<VoteSummary>>(`/api/v1/votes?page=${page}&status=${encodeURIComponent(status)}`),
  detail: (id: string) => request<VoteDetail>(`/api/v1/votes/${encodeURIComponent(id)}`),
  cast: (id: string, optionIds: string[], version: number) => request<VoteDetail>(`/api/v1/votes/${encodeURIComponent(id)}/ballot`, { method: 'POST', json: { optionIds, version } }),
  adminList: (page = 1, status = '', q = '') => request<Paged<VoteSummary>>(`/api/v1/admin/votes?page=${page}&status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`),
  adminDetail: (id: string) => request<VoteDetail>(`/api/v1/admin/votes/${encodeURIComponent(id)}`),
  create: (body: VoteContent) => request<VoteDetail>('/api/v1/admin/votes', { method: 'POST', json: body }),
  edit: (id: string, content: VoteContent, version: number, reviewAcknowledged = false) => request<VoteDetail>(`/api/v1/admin/votes/${encodeURIComponent(id)}`, { method: 'PUT', json: { content, version, reviewAcknowledged } }),
  action: (id: string, action: string, version: number) => request<VoteDetail>(`/api/v1/admin/votes/${encodeURIComponent(id)}/${action}`, { method: 'POST', json: { version } }),
  records: (page = 1, vote = '', user = '') => request<Paged<VoteRecord>>(`/api/v1/admin/votes/records?page=${page}&vote=${encodeURIComponent(vote)}&user=${encodeURIComponent(user)}`),
  exportRecords: async (vote = '', user = '') => {
    const response = await fetch(`/api/v1/admin/votes/export?vote=${encodeURIComponent(vote)}&user=${encodeURIComponent(user)}`, { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new ApiError(response.status, await response.json() as ApiErrorBody);
    return response.blob();
  },
};
export const pigeonApi = {
  keys: (page = 1) => request<Paged<PigeonKeyItem>>(`/api/v1/admin/pigeon/keys?page=${page}`),
  create: (label: string, scopes: string[]) => request<{ id: string; secret: string }>('/api/v1/admin/pigeon/keys', { method: 'POST', json: { label, scopes } }),
  update: (id: string, enabled: boolean) => request<{ ok: boolean }>(`/api/v1/admin/pigeon/keys/${encodeURIComponent(id)}`, { method: 'PATCH', json: { enabled } }),
  rotate: (id: string) => request<{ secret: string }>(`/api/v1/admin/pigeon/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', json: {} }),
  revoke: (id: string) => request<void>(`/api/v1/admin/pigeon/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorBody['error'];
  readonly fields: Record<string, string>;
  readonly accounts: Array<{ id: number; nickname: string }>;
  readonly requiresPasswords: number[];

  constructor(status: number, body: ApiErrorBody) {
    // message 只用于开发期排查；面向用户展示的应当是 code 翻译过来的文案
    super(body.message ?? body.error);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error;
    this.fields = body.fields ?? {};
    this.accounts = body.accounts ?? [];
    this.requiresPasswords = body.requiresPasswords ?? [];
  }

  /** 是否为字段级校验错误（表单用来逐字段标红） */
  get isValidation(): boolean {
    return this.status === 422;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (typeof document !== 'undefined') headers.set('X-Locale', normalizeLocale(document.documentElement.lang));
  if (json !== undefined) headers.set('content-type', 'application/json');

  const response = await fetch(path, {
    signal: AbortSignal.timeout(30000),
    ...rest,
    headers,
    // 会话靠 HttpOnly Cookie 传递；同源部署所以不需要 CORS 凭据配置
    credentials: 'same-origin',
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    const body = (parsed ?? { error: 'common.internal_error' }) as ApiErrorBody;
    throw new ApiError(response.status, body);
  }
  if (parsed === null) throw new ApiError(502, { error: 'common.internal_error' });

  return parsed as T;
}

export interface ConnectAuthorization {
  client: { id: string; name: string };
  scopes: string[];
  profiles: Array<{ id: string; name: string; playerId: number }>;
  ticket?: string;
}
export interface ConnectGrant {
  id: string; clientName: string; playerName: string | null; scopes: string; createdAt: number; expiresAt: number;
}
export interface ConnectAdmin {
  issuer: string;
  clients: OAuthClient[];
  keys: Array<{ kid: string; createdAt: number; retiredAt: number | null }>;
}
export interface OAuthClient { id: string; name: string; redirectUris: string; enabled: number; shared: number; confidential: number; userId?: number | null }
export function oauthClientsApi(admin = false) {
  const root = admin ? '/api/v1/admin/connect/clients' : '/api/v1/me/oauth/clients';
  return {
    list: () => request<{ items: OAuthClient[]; issuer: string }>(root),
    create: (body: { name: string; redirectUris: string[]; confidential: boolean; shared: boolean }) => request<{ id: string; clientSecret?: string }>(root, { method: 'POST', json: body }),
    update: (id: string, body: { name?: string; redirectUris?: string[]; enabled?: boolean; shared?: boolean }) => request<{ ok: boolean }>(`${root}/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
    rotate: (id: string) => request<{ id: string; clientSecret: string }>(`${root}/${encodeURIComponent(id)}/secret`, { method: 'POST', json: {} }),
    delete: (id: string) => request<void>(`${root}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}
export const connectApi = {
  interaction: (id: string) => request<ConnectAuthorization>(`/api/v1/connect/interactions/${encodeURIComponent(id)}`),
  approve: (id: string, approve: boolean, playerId: number | null) => request<{ redirect: string }>(`/api/v1/connect/interactions/${encodeURIComponent(id)}`, { method: 'POST', json: { approve, playerId } }),
  device: (userCode: string) => request<ConnectAuthorization>('/api/v1/connect/devices/inspect', { method: 'POST', json: { userCode } }),
  confirmDevice: (userCode: string, ticket: string, approve: boolean, playerId: number | null) => request<{ ok: boolean }>('/api/v1/connect/devices/confirm', { method: 'POST', json: { userCode, ticket, approve, playerId } }),
  grants: () => request<{ items: ConnectGrant[] }>('/api/v1/me/connect/grants'),
  revoke: (id: string) => request<void>(`/api/v1/me/connect/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  admin: () => request<ConnectAdmin>('/api/v1/admin/connect'),
  rotateKey: () => request<{ kid: string }>('/api/v1/admin/connect/keys', { method: 'POST', json: {} }),
  createClient: (body: { name: string; redirectUris: string[]; confidential: boolean; shared: boolean }) => request<{ id: string; clientSecret?: string }>('/api/v1/admin/connect/clients', { method: 'POST', json: body }),
  updateClient: (id: string, body: { name?: string; redirectUris?: string[]; enabled?: boolean; shared?: boolean }) => request<{ ok: boolean }>(`/api/v1/admin/connect/clients/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
};

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── 用户与认证 ───────────────────────────────────────────────────────────────

export interface CurrentUser {
  id: number;
  email: string;
  nickname: string;
  role: 'banned' | 'normal' | 'admin' | 'super_admin';
  score: number;
  emailVerified: boolean;
  locale: string | null;
  isDarkMode: boolean;
  avatarTextureId: number | null;
  signature?: string | null | undefined;
  needsInitialization: boolean;
  /** 管理员禁用其提交举报（防滥用风控） */
  reportingDisabled: boolean;
  /** 管理员禁用其发表评论（防滥用风控） */
  commentsDisabled: boolean;
}
export interface AccountInitialization {
  needsInitialization: boolean; email: string; nickname: string; emailVerified: boolean; ticket: string;
  requireEmailVerification: boolean; playerRequired: boolean; playerNameMin: number; playerNameMax: number;
}
export const initializationApi = {
  status: () => request<AccountInitialization>('/api/v1/auth/initialize'),
  submit: (body: { email: string; nickname: string; password: string; playerName?: string; redirect: string; ticket: string }) => request<{ redirect: string; needsEmailVerification: boolean }>('/api/v1/auth/initialize', { method: 'POST', json: body }),
};

export const api = {
  health: () => request<{ ok: boolean; db: string; latencyMs: number }>('/api/v1/health'),

  /** 创作者主页公开资料 */
  userProfile: (id: number) => request<UserProfile>(`/api/v1/users/${id}/profile`),

  /** 登录设备：列出自己的浏览器会话与游戏启动器令牌 */
  devices: () => request<DeviceList>('/api/v1/me/devices'),
  /** 登录设备：踢掉一个浏览器会话（current=true 表示踢的是当前设备） */
  revokeDeviceSession: (id: string) => request<{ ok: boolean; current: boolean }>(`/api/v1/me/devices/session/${id}`, { method: 'DELETE' }),
  /** 登录设备：踢掉一个游戏启动器令牌 */
  revokeDeviceLauncher: (id: string) => request<{ ok: boolean }>(`/api/v1/me/devices/launcher/${id}`, { method: 'DELETE' }),

  register: (input: { email: string; password: string; playerName?: string; nickname?: string; captchaToken?: string; captchaRandstr?: string }) =>
    request<{ id: number }>('/api/v1/auth/register', { method: 'POST', json: input }),

  login: (input: { identifier: string; password: string; keep?: boolean; destination?: string; captchaToken?: string; captchaRandstr?: string; retainUserId?: number; conflictPasswords?: Array<{ userId: number; password: string }> }) =>
    request<LoginResult>('/api/v1/auth/login', { method: 'POST', json: input }),

  logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),

  /** 自绘图案验证码出题（driver=image 时使用） */
  captchaChallenge: () =>
    request<{ challengeId: string; svg: string; ttlSeconds: number }>('/api/v1/auth/captcha/challenge'),

  session: () => request<CurrentUser>('/api/v1/auth/session'),

  verifyEmailRequest: () =>
    request<{ ok: boolean; reason?: string }>('/api/v1/auth/verify-email/request', { method: 'POST' }),
  verifyEmailConfirm: (token: string) =>
    request<{ ok: boolean }>('/api/v1/auth/verify-email/confirm', { method: 'POST', json: { token } }),
  forgotPassword: (email: string, captchaToken = '', captchaRandstr = '') =>
    request<{ ok: boolean }>('/api/v1/auth/forgot-password', { method: 'POST', json: { email, captchaToken, captchaRandstr } }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>('/api/v1/auth/reset-password', { method: 'POST', json: { token, password } }),
};

// ── 公开设置 ─────────────────────────────────────────────────────────────────

export const settingsApi = {
  public: (locale?: string) =>
    request<Record<string, string>>(`/api/v1/settings/public${locale ? `?locale=${locale}` : ''}`),
};

// ── 资源 URL 构造 ────────────────────────────────────────────────────────────
// 纹理与衍生图由内容哈希寻址，因此可以永久缓存。前端直接拼这些路径。

/** 头像：不可变 URL，由哈希寻址 */
export function avatarUrl(hash: string, opts: { size?: number; mode?: '2d' | '3d' } = {}): string {
  const params = new URLSearchParams();
  if (opts.mode) params.set('mode', opts.mode);
  if (opts.size) params.set('size', String(opts.size));
  params.set('render', '3');
  const qs = params.toString();
  return `/avatar/${hash}${qs ? `?${qs}` : ''}`;
}
export function userAvatarUrl(userId: number, options: { version?: number; mode?: '2d' | '3d' } = {}) {
  const params = new URLSearchParams({ size: '100', mode: options.mode || '2d', v: String(options.version || 0), render: '3' });
  return `/avatar/user/${userId}?${params}`;
}

/** 全身预览 */
export function previewUrl(hash: string): string {
  return `/preview/${hash}?render=3`;
}

/** 原始纹理字节（协议路径，客户端也在用） */
export function textureUrl(hash: string): string {
  return `/textures/${hash}`;
}

// ── 纹理 ─────────────────────────────────────────────────────────────────────

export interface TextureSummary {
  id: number;
  hash: string;
  kind: 'skin' | 'cape';
  model: 'default' | 'slim' | null;
  name: string;
  official?: boolean;
  origin?: 'original' | 'repost';
  visibility: 'public' | 'private';
  width: number;
  height: number;
  sizeBytes: number;
  likes: number;
  uploaderId: number | null;
  uploaderName: string | null;
  sourceResourceId: number | null;
  sourceResourceName: string | null;
  createdAt: number;
}

export interface Paged<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface AiJobItem {
  id: number;
  kind: 'translate_texture' | 'moderate_texture_name' | 'moderate_texture_description';
  tid: number;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  nextRunAt: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  texture: { id: number; name: string; uploaderId: number | null; nameFlagged: number; descriptionFlagged: number } | null;
}

export interface TextureFlagItem {
  id: number;
  name: string;
  nameFlagged: number;
  nameFlagReason: string;
  descriptionFlagged: number;
  descriptionFlagReason: string;
  uploaderId: number | null;
}

export interface SearchSubmissionRecord {
  engine: string;
  textureId: number;
  status: string;
  httpStatus: number | null;
  attempts: number;
  lastError: string;
  updatedAt: number;
}

export interface TaskRunItem {
  id: number;
  name: string;
  ok: boolean;
  detail: string;
  ranAt: number;
}

/** 登录设备：浏览器会话 */
export interface BrowserDevice {
  kind: 'browser';
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** 登录设备：游戏启动器令牌（authlib 外置登录） */
export interface LauncherDevice {
  kind: 'launcher';
  id: string;
  playerName: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeviceList {
  browser: BrowserDevice[];
  launcher: LauncherDevice[];
}

/** 创作者主页公开资料 */
export interface UserProfile {
  id: number;
  nickname: string;
  signature: string;
  avatarTextureId: number | null;
  role: string;
  createdAt: number;
  counts: { skins: number; capes: number };
}

export interface TextureQuery {
  // 显式写 | undefined：tsconfig 开了 exactOptionalPropertyTypes，
  // 否则调用方传 `kind: undefined` 会编译不过
  kind?: 'skin' | 'cape' | undefined;
  model?: 'default' | 'slim' | undefined;
  uploader?: number | undefined;
  keyword?: string | undefined;
  sort?: 'created' | 'likes' | undefined;
  official?: boolean | undefined;
  mine?: boolean | undefined;
  /** 展示语言：材质名按 AI 译文覆盖 */
  locale?: string | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
}

export const textureApi = {
  /** headers 供反爬挑战带 X-Captcha-Token 重试 */
  list: (q: TextureQuery = {}, headers?: HeadersInit) => {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.model) p.set('model', q.model);
    if (q.uploader) p.set('uploader', String(q.uploader));
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.sort) p.set('sort', q.sort);
    if (q.official) p.set('official', 'true');
    if (q.mine) p.set('mine', 'true');
    if (q.locale) p.set('locale', q.locale);
    if (q.page) p.set('page', String(q.page));
    if (q.perPage) p.set('per_page', String(q.perPage));
    return request<Paged<TextureSummary>>(`/api/v1/textures?${p}`, headers ? { headers } : {});
  },

  /** headers 供反爬挑战带 X-Captcha-Token 重试 */
  get: (id: number, locale?: string, headers?: HeadersInit) =>
    request<TextureSummary>(
      `/api/v1/textures/${id}${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
      headers ? { headers } : {},
    ),

  content: async (id: number) => {
    const response = await fetch(`/api/v1/textures/${id}/content`, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiError(response.status, { error: response.status === 404 ? 'texture.not_found' : 'common.internal_error' });
    return response.blob();
  },

  /**
   * 上传纹理。衍生图（头像/预览/iso）由服务端 DO 统一生成，前端不再提交。
   */
  upload: (input: {
    file: Blob;
    name: string;
    kind: 'skin' | 'cape';
    model?: 'default' | 'slim' | undefined;
    visibility: 'public' | 'private';
    description?: string | undefined;
    sourceResourceId?: number | null | undefined;
    origin?: 'original' | 'repost' | undefined;
  }) => {
    const form = new FormData();
    form.set('file', input.file, 'texture.png');
    form.set('name', input.name);
    form.set('kind', input.kind);
    if (input.model) form.set('model', input.model);
    form.set('visibility', input.visibility);
    if (input.description) form.set('description', input.description);
    if (input.sourceResourceId) form.set('sourceResourceId', String(input.sourceResourceId));
    if (input.origin) form.set('origin', input.origin);
    return request<{ id: number; hash: string; scoreSpent: number }>('/api/v1/textures', {
      method: 'POST', body: form,
    });
  },

  patch: (id: number, body: { name?: string; visibility?: 'public' | 'private'; kind?: 'skin' | 'cape'; model?: 'default' | 'slim' }) =>
    request<{ ok: boolean; scoreDelta: number }>(`/api/v1/textures/${id}`, {
      method: 'PATCH', json: body,
    }),

  replaceContent: (id: number, file: Blob) => {
    const form = new FormData();
    form.set('file', file, 'texture.png');
    return request<{ hash: string; width: number; height: number; sizeBytes: number }>(`/api/v1/textures/${id}/content`, { method: 'PUT', body: form });
  },

  remove: (id: number) => request<void>(`/api/v1/textures/${id}`, { method: 'DELETE' }),

  // ── 纹理描述（原 texture-description 插件）───────────────────────────────

  getDescription: (id: number, locale?: string, headers?: HeadersInit) =>
    request<{ description: string; translatedDescription?: string }>(
      `/api/v1/textures/${id}/description${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
      headers ? { headers } : {},
    ),

  putDescription: (id: number, description: string) =>
    request<{ ok: boolean; description: string }>(`/api/v1/textures/${id}/description`, {
      method: 'PUT', json: { description },
    }),
};

// ── 评论 ─────────────────────────────────────────────────────────────────────

export interface CommentItem {
  id: number;
  textureId?: number | undefined;
  userId: number | null;
  avatarTextureId?: number | null;
  userName: string;
  content: string;
  status?: 'pending' | 'rejected' | 'published' | 'deleted' | undefined;
  aiFlagged?: boolean | undefined;
  createdAt: number;
}

export interface OfficialResourceStatus { checkedAt: number | null; succeededAt: number | null; running: boolean; phase: string; clientVersion: string; added: number; updated: number; pending: number; error: boolean; skins: number; capes: number }
export const officialResourceApi = {
  status: () => request<OfficialResourceStatus>('/api/v1/admin/official-resources'),
  sync: () => request<OfficialResourceStatus>('/api/v1/admin/official-resources/sync', { method: 'POST' }),
};

export const commentApi = {
  list: (textureId: number, page = 1, perPage = 20) => {
    const p = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    return request<Paged<CommentItem>>(`/api/v1/textures/${textureId}/comments?${p}`);
  },

  create: (textureId: number, content: string, captchaToken?: string, captchaRandstr?: string) =>
    request<{ ok: boolean; id: number; status?: 'pending' | 'published'; aiFlagged: boolean }>(
      `/api/v1/textures/${textureId}/comments`, { method: 'POST', json: { content, captchaToken, captchaRandstr } }),

  /** 用户删除自己的评论（管理员也可删任意一条） */
  remove: (id: number) => request<void>(`/api/v1/comments/${id}`, { method: 'DELETE' }),
};

// ── 玩家 ─────────────────────────────────────────────────────────────────────

export interface PlayerSummary {
  id: number;
  name: string;
  skinTextureId: number | null;
  capeTextureId: number | null;
  skinHash: string | null;
  skinModel: 'default' | 'slim' | null;
  capeHash: string | null;
  createdAt: number | null;
  updatedAt: number;
}

export const playerApi = {
  list: () => request<{ items: PlayerSummary[] }>('/api/v1/players'),

  create: (name: string) =>
    request<{ id: number; scoreSpent: number }>('/api/v1/players', {
      method: 'POST', json: { name },
    }),

  rename: (id: number, name: string) =>
    request<{ ok: boolean }>(`/api/v1/players/${id}`, { method: 'PATCH', json: { name } }),

  remove: (id: number) => request<void>(`/api/v1/players/${id}`, { method: 'DELETE' }),

  setTextures: (id: number, body: { skin?: number | null; cape?: number | null }) =>
    request<{ ok: boolean }>(`/api/v1/players/${id}/textures`, { method: 'PUT', json: body }),

  clearTextures: (id: number, which: { skin?: boolean; cape?: boolean }) => {
    const p = new URLSearchParams();
    if (which.skin) p.set('skin', 'true');
    if (which.cape) p.set('cape', 'true');
    return request<{ ok: boolean }>(`/api/v1/players/${id}/textures?${p}`, { method: 'DELETE' });
  },
};

// ── 收藏 ─────────────────────────────────────────────────────────────────────

export interface ClosetEntry {
  textureId: number;
  itemName: string | null;
  createdAt: number;
  hash: string;
  kind: 'skin' | 'cape';
  model: 'default' | 'slim' | null;
  textureName: string;
  visibility: 'public' | 'private';
}

export const closetApi = {
  list: (q: { category?: 'skin' | 'cape' | undefined; keyword?: string | undefined; page?: number; perPage?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.category) p.set('category', q.category);
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.page) p.set('page', String(q.page));
    if (q.perPage) p.set('per_page', String(q.perPage));
    return request<{ items: ClosetEntry[]; page: number; hasMore: boolean }>(`/api/v1/closet?${p}`);
  },

  add: (textureId: number, name?: string) =>
    request<{ ok: boolean; scoreSpent: number }>('/api/v1/closet', {
      method: 'POST', json: { textureId, name },
    }),

  rename: (textureId: number, name: string) =>
    request<{ ok: boolean }>(`/api/v1/closet/${textureId}`, { method: 'PATCH', json: { name } }),

  remove: (textureId: number) =>
    request<void>(`/api/v1/closet/${textureId}`, { method: 'DELETE' }),
};

// ── 举报 ─────────────────────────────────────────────────────────────────────

export interface ReportItem {
  id: number;
  textureId: number;
  reason: string;
  status: 'pending' | 'resolved' | 'rejected';
  createdAt: number;
  reviewedAt: number | null;
}

export const reportApi = {
  submit: (textureId: number, reason: string, captchaToken?: string, captchaRandstr?: string) =>
    request<{ ok: boolean; scoreDelta: number }>('/api/v1/reports', {
      method: 'POST', json: { textureId, reason, captchaToken, captchaRandstr },
    }),

  mine: () => request<{ items: ReportItem[] }>('/api/v1/reports'),

  /** 后台：按状态列表 */
  adminList: (status: 'pending' | 'resolved' | 'rejected' = 'pending') =>
    request<{ items: (ReportItem & { reporterId: number; uploaderId: number | null })[] }>(
      `/api/v1/reports/admin?status=${status}`),

  resolve: (id: number, action: 'delete' | 'ban' | 'reject') =>
    request<{ ok: boolean; action: string }>(`/api/v1/reports/${id}/resolve`, {
      method: 'POST', json: { action },
    }),
};

// ── 工单 ─────────────────────────────────────────────────────────────────────
export type TicketStatus = 'pending' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
export interface TicketCategory { id: number; slug: string; name: string; hidden: boolean; sortOrder: number; createdAt: number; updatedAt: number }
export interface TicketSummary { id: number; ticketNumber: string; userId: number; userEmail?: string; userNickname?: string; title: string; category: string; categoryId: number | null; categoryName: string; description: string; status: TicketStatus; createdAt: number; updatedAt: number; closedAt: number | null; userUnread: boolean; adminUnread: boolean }
export interface TicketMessage { id: number; authorId: number | null; authorType: 'user' | 'admin' | 'system'; authorName: string | null; body: string; internal: boolean; createdAt: number }
export interface TicketDetail { ticket: TicketSummary; messages: TicketMessage[]; attachments: Array<{ id: number; messageId: number | null; fileName: string; mimeType: string; sizeBytes: number }>; events: Array<{ id: number; actorId: number | null; type: string; fromStatus: string | null; toStatus: string | null; detail: string | null; createdAt: number }> }
function ticketForm(input: { body?: string; title?: string; categoryId?: number; description?: string; files?: File[] }) {
  const form = new FormData();
  if (input.body !== undefined) form.set('body', input.body);
  if (input.title !== undefined) form.set('title', input.title);
  if (input.categoryId !== undefined) form.set('categoryId', String(input.categoryId));
  if (input.description !== undefined) form.set('description', input.description);
  for (const file of input.files || []) form.append('files', file, file.name);
  return form;
}
export const ticketApi = {
  categories: () => request<{ items: TicketCategory[] }>('/api/v1/tickets/categories'),
  list: () => request<{ items: TicketSummary[]; unread: number }>('/api/v1/tickets'),
  get: (id: number) => request<TicketDetail>(`/api/v1/tickets/${id}`),
  create: (input: { title: string; categoryId: number; description: string; files?: File[] }) => request<{ id: number; ticketNumber: string }>('/api/v1/tickets', { method: 'POST', body: ticketForm(input) }),
  reply: (id: number, body: string, files?: File[]) => request<{ ok: boolean; messageId: number }>('/api/v1/tickets/' + id + '/messages', { method: 'POST', body: ticketForm(files ? { body, files } : { body }) }),
  attachmentUrl: (id: number, attachmentId: number) => `/api/v1/tickets/${id}/attachments/${attachmentId}`,
};

// ── 通知 ─────────────────────────────────────────────────────────────────────

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  readAt: number | null;
  createdAt: number;
}

export const notificationApi = {
  list: (unreadOnly = false) =>
    request<{ items: NotificationItem[]; unread: number }>(
      `/api/v1/notifications${unreadOnly ? '?unread=true' : ''}`),

  markRead: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () =>
    request<{ ok: boolean }>('/api/v1/notifications/read-all', { method: 'POST' }),
};

// ── 我（资料 / 签到 / 积分）──────────────────────────────────────────────────

export interface ScoreInfo {
  score: number; canSignIn: boolean; nextSignAt: number | null;
  signReward: { min: number; max: number };
  usage: { players: number; storageKb: number };
  rates: { perPlayer: number; perKbPublic: number; perKbPrivate: number; perClosetItem: number };
}
export const meApi = {
  sign: () =>
    request<{ reward: number; score: number }>('/api/v1/me/sign-in', { method: 'POST' }),

  score: () => request<ScoreInfo>('/api/v1/me/score'),
  deleteAccount: () => request<void>('/api/v1/me', { method: 'DELETE' }),
  patchPreferences: (body: { locale?: Locale; isDarkMode?: boolean }) =>
    request<{ ok: boolean }>('/api/v1/me/preferences', { method: 'PATCH', json: body }),

  patchProfile: (body: {
    nickname?: string; email?: string; locale?: string; isDarkMode?: boolean;
    signature?: string;
  }) =>
    request<{ ok: boolean; emailChanged: boolean }>('/api/v1/me', { method: 'PATCH', json: body }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/v1/me/password', {
      method: 'POST', json: { currentPassword, newPassword },
    }),

  setAvatar: (textureId: number | 0 | null) =>
    request<{ ok: boolean }>('/api/v1/me/avatar', { method: 'POST', json: { textureId } }),
};

// ── OAuth 绑定（原 oauth 插件族）─────────────────────────────────────────────

export interface OAuthProvider {
  id: string;
  displayName: string;
}

export interface OAuthBinding {
  provider: string;
  createdAt: number;
}

export const oauthApi = {
  /** 可用提供商（凭据已配置的才会出现）—— 登录/注册页渲染按钮用 */
  providers: () => request<{ providers: OAuthProvider[] }>('/api/v1/oauth/providers'),

  /** 我的绑定列表 + 可用提供商 */
  my: () => request<{ bindings: OAuthBinding[]; available: OAuthProvider[]; hasPassword: boolean }>('/api/v1/me/oauth'),

  unbind: (provider: string) =>
    request<{ ok: boolean }>(`/api/v1/me/oauth/${provider}/unbind`, { method: 'POST' }),
};

// ── Mojang 正版验证（原 mojang-verification 插件）───────────────────────────

export interface MojangStatus {
  /** null = 未验证；有值 = uuid 与验证时间 */
  verified: { uuid: string; createdAt: number } | null;
  /** 服务端是否配置了 Mojang 验证凭据 */
  available: boolean;
}

export const mojangApi = {
  status: () => request<MojangStatus>('/api/v1/me/mojang'),

  unbind: () => request<{ ok: boolean }>('/api/v1/me/mojang/unbind', { method: 'POST' }),

  /** 改名后从 Mojang 官方 API 同步当前正版名 */
  updateUuid: () => request<{ ok: boolean; name: string; synced: boolean; needsReverify: boolean }>('/mojang/update-uuid', { method: 'POST' }),
};

// ── 后台 ─────────────────────────────────────────────────────────────────────

export interface AdminUserRow {
  id: number;
  email: string;
  nickname: string;
  role: 'banned' | 'normal' | 'admin' | 'super_admin';
  score: number;
  emailVerifiedAt: number | null;
  reportingDisabled: boolean;
  commentsDisabled: boolean;
  createdAt: number;
  playerCount: number;
}

export interface AdminTextureRow {
  id: number;
  hash: string;
  name: string;
  kind: 'skin' | 'cape';
  visibility: 'public' | 'private';
  sizeBytes: number;
  likes: number;
  uploaderId: number | null;
  uploaderName: string | null;
  createdAt: number;
}

export interface AdminStats {
  users: number;
  players: number;
  textures: number;
  pendingReports: number;
  storageKb: number;
}

export interface IntegrationStatus {
  apiRoot: string;
  providers: Array<{ id: string; clientId: boolean; clientSecret: boolean; configured: boolean; callbackUrl: string }>;
  mojang: { configured: boolean; callbackUrl: string; usesMicrosoft: boolean };
  signingKey: { configured: boolean; valid: boolean; bits: number; publicKey: string | null; fingerprint: string | null };
}
export interface YggLogItem {
  id: number; action: string; ip: string | null; body: string | null; createdAt: number; userId: number | null; playerId: number | null;
}

export interface AuditLogItem {
  id: number;
  actorId: number | null;
  action: string;
  targetType: string | null;
  targetId: number | null;
  detail: string | null;
  createdAt: number;
}

export interface SearchSubmissionStatus {
  root: string;
  queueConfigured: boolean;
  sitemapUrl: string;
  enabled: Record<string, boolean>;
  counts: Array<{ engine: string; status: string; count: number }>;
  recent: Array<{ engine: string; textureId: number; status: string; attempts: number; httpStatus: number | null; error: string | null; updatedAt: number }>;
}

export interface AdminSessionRow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

export const adminApi = {
  integrations: () => request<IntegrationStatus>('/api/v1/admin/integrations'),
  searchSubmissions: () => request<SearchSubmissionStatus>('/api/v1/admin/search-submissions'),
  submitPublicTextures: () => request<{ queued: number }>('/api/v1/admin/search-submissions', { method: 'POST' }),
  yggLogs: (query: { action?: string | undefined; q?: string | undefined; page?: number | undefined } = {}) => request<Paged<YggLogItem>>(`/api/v1/admin/yggdrasil/logs?${new URLSearchParams({ ...(query.action ? { action: query.action } : {}), ...(query.q ? { q: query.q } : {}), page: String(query.page || 1) })}`),
  status: () => request<{ version: string; environment: string; database: boolean; storage: boolean; latencyMs: number }>('/api/v1/admin/status'),
  update: () => request<{ current: string; latest: { version: string; notes: string; url: string } | null; deployConfigured: boolean }>('/api/v1/admin/update'),
  deployUpdate: () => request<{ ok: boolean }>('/api/v1/admin/update', { method: 'POST' }),
  translations: () => request<{ items: Array<{ locale: Locale; key: string; value: string }> }>('/api/v1/admin/translations'),
  putTranslation: (input: { locale: Locale; key: string; value: string }) => request<{ ok: boolean }>('/api/v1/admin/translations', { method: 'PUT', json: input }),
  deleteTranslation: (locale: string, key: string) => request<void>(`/api/v1/admin/translations?${new URLSearchParams({ locale, key })}`, { method: 'DELETE' }),
  deleteUser: (id: number) => request<void>(`/api/v1/admin/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id: number) => request<{ temporaryPassword: string }>(`/api/v1/admin/users/${id}/reset-password`, { method: 'POST' }),
  broadcast: (input: { title: string; content: string; receiver: string | number; sendEmail?: boolean }) => request<{ sent: number; emailQueued: boolean }>('/api/v1/admin/notifications', { method: 'POST', json: input }),
  notificationEmailPreview: (input: { title: string; content: string; locale: string }) => request<{ subject: string; html: string; text: string }>('/api/v1/admin/notifications/email-preview', { method: 'POST', json: input }),
  chart: () => request<Array<{ date: string; users: number; textures: number }>>('/api/v1/admin/chart'),
  stats: () => request<AdminStats>('/api/v1/admin/stats'),
  ticketCategories: () => request<{ items: TicketCategory[] }>('/api/v1/admin/ticket-categories'),
  createTicketCategory: (name: string) => request<TicketCategory>('/api/v1/admin/ticket-categories', { method: 'POST', json: { name } }),
  updateTicketCategory: (id: number, body: { name?: string; hidden?: boolean; sortOrder?: number }) => request<TicketCategory>(`/api/v1/admin/ticket-categories/${id}`, { method: 'PATCH', json: body }),
  deleteTicketCategory: (id: number) => request<TicketCategory>(`/api/v1/admin/ticket-categories/${id}`, { method: 'DELETE' }),
  tickets: (query: { page?: number | undefined; status?: string | undefined; categoryId?: number | undefined; user?: string | undefined; q?: string | undefined } = {}) => {
    const p = new URLSearchParams(); if (query.page) p.set('page', String(query.page)); if (query.status) p.set('status', query.status); if (query.categoryId) p.set('category_id', String(query.categoryId)); if (query.user) p.set('user', query.user); if (query.q) p.set('q', query.q);
    return request<{ items: TicketSummary[]; page: number; perPage: number; total: number; totalPages: number; unread: number }>(`/api/v1/admin/tickets?${p}`);
  },
  ticket: (id: number) => request<TicketDetail>(`/api/v1/admin/tickets/${id}`),
  ticketReply: (id: number, body: string, internal: boolean, files?: File[]) => request<{ ok: boolean; messageId: number }>(`/api/v1/admin/tickets/${id}/messages`, { method: 'POST', body: (() => { const f = ticketForm(files ? { body, files } : { body }); f.set('internal', String(internal)); return f; })() }),
  ticketStatus: (id: number, status: TicketStatus) => request<{ ok: boolean; changed: boolean }>(`/api/v1/admin/tickets/${id}/status`, { method: 'PATCH', json: { status } }),
  ticketAttachmentUrl: (id: number, attachmentId: number) => `/api/v1/admin/tickets/${id}/attachments/${attachmentId}`,

  users: (q: { keyword?: string | undefined; page?: number | undefined } = {}) => {
    const p = new URLSearchParams();
    if (q.keyword) p.set('q', q.keyword);
    if (q.page) p.set('page', String(q.page));
    return request<Paged<AdminUserRow>>(`/api/v1/admin/users?${p}`);
  },

  patchUser: (id: number, body: {
    nickname?: string; email?: string; emailVerified?: boolean; score?: number;
    role?: 'banned' | 'normal' | 'admin';
    reportingDisabled?: boolean; commentsDisabled?: boolean;
  }) =>
    request<{ ok: boolean; sessionsRevoked: boolean }>(`/api/v1/admin/users/${id}`, {
      method: 'PATCH', json: body,
    }),

  /** 管理员创建用户 */
  createUser: (body: {
    email: string; nickname: string; password: string;
    role?: 'banned' | 'normal' | 'admin' | undefined;
  }) =>
    request<{ id: number }>('/api/v1/admin/users', { method: 'POST', json: body }),

  /** 审计日志（分页 + action/actor 过滤；q 为搜索表达式） */
  auditLog: (query: { action?: string | undefined; actorId?: number | undefined; q?: string | undefined; page?: number | undefined } = {}) => {
    const p = new URLSearchParams();
    if (query.action) p.set('action', query.action);
    if (query.actorId !== undefined) p.set('actor_id', String(query.actorId));
    if (query.q) p.set('q', query.q);
    if (query.page) p.set('page', String(query.page));
    return request<Paged<AuditLogItem>>(`/api/v1/admin/audit-log?${p}`);
  },

  /** 某用户的活跃会话 */
  userSessions: (id: number) =>
    request<{ items: AdminSessionRow[] }>(`/api/v1/admin/users/${id}/sessions`),

  /** 吊销某用户全部会话 */
  revokeUserSessions: (id: number) =>
    request<void>(`/api/v1/admin/users/${id}/sessions`, { method: 'DELETE' }),

  /** 后台纹理治理：删除（不退分） */
  deleteTexture: (id: number) =>
    request<void>(`/api/v1/admin/textures/${id}`, { method: 'DELETE' }),

  /** 后台纹理治理：改名 / 改可见性 */
  patchTexture: (id: number, body: { name?: string; visibility?: 'public' | 'private' }) =>
    request<{ ok: boolean }>(`/api/v1/admin/textures/${id}`, { method: 'PATCH', json: body }),

  /** 受限邮箱域名（JSON 数组名单） */
  getRestrictedEmailDomains: () =>
    request<{ allow: string[]; deny: string[] }>('/api/v1/admin/restricted-email-domains'),

  putRestrictedEmailDomains: (list: 'allow' | 'deny', domains: string[]) =>
    request<void>(`/api/v1/admin/restricted-email-domains/${list}`, {
      method: 'PUT', json: { domains },
    }),

  /** 后台评论管理（可按 status 过滤） */
  comments: (status: '' | 'pending' | 'rejected' | 'published' | 'deleted' = '', page = 1) => {
    const p = new URLSearchParams({ page: String(page) });
    if (status) p.set('status', status);
    return request<Paged<CommentItem>>(`/api/v1/admin/comments?${p}`);
  },

  deleteComment: (id: number) =>
    request<void>(`/api/v1/admin/comments/${id}`, { method: 'DELETE' }),

  /** 后台任务：AI 任务队列 */
  /** AI 网关：从当前驱动拉取可用模型列表（null = 驱动无列表 API）；edits 为表单未保存值 */
  aiModels: (edits?: {
    ai_driver?: string | undefined;
    ai_api_key?: string | undefined;
    openai_base_url?: string | undefined;
    ai_systemone_api_key?: string | undefined;
    ai_cloudflare_account_id?: string | undefined;
    ai_cloudflare_api_token?: string | undefined;
  }) => {
    const p = new URLSearchParams();
    if (edits?.ai_driver) p.set('ai_driver', edits.ai_driver);
    if (edits?.ai_api_key) p.set('ai_api_key', edits.ai_api_key);
    if (edits?.openai_base_url) p.set('openai_base_url', edits.openai_base_url);
    if (edits?.ai_systemone_api_key) p.set('ai_systemone_api_key', edits.ai_systemone_api_key);
    if (edits?.ai_cloudflare_account_id) p.set('ai_cloudflare_account_id', edits.ai_cloudflare_account_id);
    if (edits?.ai_cloudflare_api_token) p.set('ai_cloudflare_api_token', edits.ai_cloudflare_api_token);
    return request<{ models: string[] | null }>(`/api/v1/admin/ai-models?${p}`);
  },
  /** AI 网关：连通性测试；edits 为表单未保存值，modelField 是按钮所在字段的设置键 */
  aiTest: (model?: string, opts?: { modelField?: string | undefined; edits?: Record<string, string | undefined> | undefined }) =>
    request<{ ok: boolean; model: string | null; reason?: string }>('/api/v1/admin/ai-test', {
      method: 'POST',
      json: {
        ...(model ? { model } : {}),
        ...(opts?.modelField ? { modelField: opts.modelField } : {}),
        ...(opts?.edits ? { edits: opts.edits } : {}),
      },
    }),

  aiJobs: (q: { kind?: string | undefined; status?: string | undefined; page?: number | undefined } = {}) => {
    const p = new URLSearchParams({ page: String(q.page || 1) });
    if (q.kind) p.set('kind', q.kind);
    if (q.status) p.set('status', q.status);
    return request<Paged<AiJobItem>>(`/api/v1/admin/ai-jobs?${p}`);
  },
  retryAiJob: (id: number) => request<{ ok: boolean }>(`/api/v1/admin/ai-jobs/${id}/retry`, { method: 'POST' }),
  cancelAiJob: (id: number) => request<{ ok: boolean }>(`/api/v1/admin/ai-jobs/${id}/cancel`, { method: 'POST' }),
  backfillAiJobs: () => request<{ results: Array<{ kind: string; queued: number }> }>('/api/v1/admin/ai-jobs/backfill', { method: 'POST' }),

  /** 后台任务：AI 审核标记处置 */
  textureFlags: (page = 1) => request<Paged<TextureFlagItem>>(`/api/v1/admin/texture-flags?page=${page}`),
  clearTextureFlag: (id: number, field: 'name' | 'description') =>
    request<{ ok: boolean }>(`/api/v1/admin/texture-flags/${id}/${field}`, { method: 'DELETE' }),

  /** 后台任务：搜索引擎提交记录 */
  searchSubmissionRecords: (page = 1) => request<Paged<SearchSubmissionRecord>>(`/api/v1/admin/search-submissions?page=${page}`),
  retrySearchSubmissions: (engine: string) => request<{ ok: boolean; reset: number }>(`/api/v1/admin/search-submissions/${engine}/retry`, { method: 'POST' }),

  /** 后台任务：定时任务运行记录 */
  taskRuns: () => request<{ items: TaskRunItem[] }>('/api/v1/admin/task-runs'),

  players: (q: { keyword?: string | undefined; page?: number | undefined } = {}) => {
    const p = new URLSearchParams();
    if (q.keyword) p.set('q', q.keyword);
    if (q.page) p.set('page', String(q.page));
    return request<Paged<{ id: number; name: string; ownerId: number; ownerName: string | null; skinTextureId: number | null; capeTextureId: number | null; updatedAt: number }>>(`/api/v1/admin/players?${p}`);
  },

  patchPlayer: (id: number, body: { name?: string; ownerId?: number; skin?: number | null; cape?: number | null }) =>
    request<{ ok: boolean }>(`/api/v1/admin/players/${id}`, { method: 'PATCH', json: body }),

  deletePlayer: (id: number) =>
    request<void>(`/api/v1/admin/players/${id}`, { method: 'DELETE' }),

  textures: (q: { keyword?: string | undefined; page?: number | undefined } = {}) => {
    const p = new URLSearchParams();
    if (q.keyword) p.set('q', q.keyword);
    if (q.page) p.set('page', String(q.page));
    return request<Paged<AdminTextureRow>>(`/api/v1/admin/textures?${p}`);
  },

  /** 某用户的收藏（排查/清理用） */
  addUserClosetEntry: (id: number, textureId: number) => request<{ ok: boolean }>(`/api/v1/admin/users/${id}/closet`, { method: 'POST', json: { textureId } }),
  userCloset: (id: number, page = 1) =>
    request<Paged<ClosetEntry & { textureName: string; hash: string }>>(
      `/api/v1/admin/users/${id}/closet?page=${page}`),

  deleteUserClosetEntry: (userId: number, textureId: number) =>
    request<void>(`/api/v1/admin/users/${userId}/closet/${textureId}`, { method: 'DELETE' }),

  getSettings: (locale = '') =>
    request<{
      locale: string;
      values: Record<string, string>;
      /** AI 覆盖项的内置默认值（空值时前端作 placeholder 展示） */
      aiDefaults: Record<string, string>;
      /** 当前生效的 AI 驱动（含部署 env 回落），前端据此联动显隐 */
      aiEffectiveDriver: 'workers' | 'openai' | 'anthropic' | 'systemone' | '';
      overrides: string[];
      registry: { typed: string[]; extra: string[] };
      specs: Record<string, { kind: 'string' | 'integer' | 'boolean' | 'markdown' | 'enum'; min?: number; max?: number; values?: string[]; localizable?: boolean; superAdminOnly?: boolean; secret?: boolean }>;
    }>(`/api/v1/admin/settings?locale=${locale}`),

  patchSettings: (settings: Array<{ key: string; value: unknown; locale?: string }>) =>
    request<{ ok: boolean; written: number }>('/api/v1/admin/settings', {
      method: 'PATCH', json: { settings },
    }),
  clearSettingOverride: (key: string, locale: string) =>
    request<void>(`/api/v1/admin/settings/${encodeURIComponent(key)}?locale=${encodeURIComponent(locale)}`, { method: 'DELETE' }),
  sendTestEmail: (to?: string) =>
    request<{ ok: boolean; reason: 'not-configured' | 'provider-error' | null; detail: { phase: string; code: number | null } | null }>('/api/v1/admin/settings/email-test', {
      method: 'POST', json: { to },
    }),
};

export const setupApi = {
  status: () => request<{ locked: boolean; available: boolean }>('/api/v1/setup'),
  create: (input: { token: string; siteName: string; email: string; nickname: string; password: string }) => request<{ ok: boolean }>('/api/v1/setup', { method: 'POST', json: input }),
};
