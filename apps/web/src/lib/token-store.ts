// 认证令牌的前端存储与刷新。
//
// 双令牌模型：access token（短时效 JWT）+ refresh token（不透明，服务端
// sessions 表）。两者都存 localStorage、经 Authorization 头发送 —— 这是
// "支持跨域部署 + 实现直白"的既定取舍：XSS 能读到两者，防线依赖 CSP 与
// 服务端短 TTL + 可撤销语义。access token 同时映射进内存 ref 供请求客户端读取。
//
// 刷新在模块内用裸 fetch 实现（不经过 api.ts 的 request），避免
// token-store ↔ api ↔ session 的循环依赖；登录/刷新失败的登出信号经
// onAuthChanged 回调通知会话 store。
import { ref } from 'vue';

const ACCESS_KEY = 'ps_web_at';
const REFRESH_KEY = 'ps_web_rt';

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: unknown;
}

/** 内存中的 access token（请求客户端每次请求读取） */
export const accessToken = ref('');

function safeGet(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function safeSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* 隐身模式等存储不可用场景下令牌只留在内存 */ }
}

export function readRefreshToken(): string {
  return safeGet(REFRESH_KEY);
}

export function saveTokens(access: string, refresh: string): void {
  accessToken.value = access;
  safeSet(ACCESS_KEY, access);
  if (refresh) safeSet(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  accessToken.value = '';
  safeSet(ACCESS_KEY, '');
  safeSet(REFRESH_KEY, '');
}

/** 应用启动时从 localStorage 恢复内存映射；返回本地是否持有任何令牌 */
export function hydrateTokens(): boolean {
  const access = safeGet(ACCESS_KEY);
  accessToken.value = access;
  return !!(access || safeGet(REFRESH_KEY));
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 解 access token 的 exp（Unix 秒）；不是 JWT 或解析失败返回 null */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(token.split('.')[1] ?? ''))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch { return null; }
}

type AuthListener = (grant: TokenGrant | null) => void;
const listeners = new Set<AuthListener>();

/** 登出（刷新失败/令牌被清空）或拿到新会话数据时通知订阅者；返回退订函数 */
export function onAuthChanged(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(grant: TokenGrant | null): void {
  for (const listener of listeners) listener(grant);
}

let inflight: Promise<TokenGrant | null> | null = null;

/**
 * 用 refresh token 换新 access token（并发单飞）。
 * 成功返回令牌组并更新存储；失败返回 null 并清空本地状态（触发登出）。
 */
export function refreshTokens(): Promise<TokenGrant | null> {
  if (inflight) return inflight;
  const refresh = readRefreshToken();
  if (!refresh) return Promise.resolve(null);
  inflight = (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { clearTokens(); emit(null); return null; }
      const grant = await response.json() as TokenGrant;
      saveTokens(grant.accessToken, grant.refreshToken);
      emit(grant);
      return grant;
    } catch {
      // 网络抖动不应登出：保留本地令牌，等下一次请求重试
      return null;
    }
  })();
  inflight.finally(() => { inflight = null; });
  return inflight;
}
