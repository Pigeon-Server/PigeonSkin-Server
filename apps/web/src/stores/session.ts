// 会话状态：当前用户 + 登录/登出/令牌。角色判定集中在这里。
import { computed, ref } from 'vue';
import { api, type CurrentUser } from '@/api';
import {
  accessToken, clearTokens, hydrateTokens, onAuthChanged,
  readRefreshToken, refreshTokens, saveTokens, tokenExpiry, type TokenGrant,
} from '@/lib/token-store';

const user = ref<CurrentUser | null>(null);
const loaded = ref(false);
const error = ref('');
const logoutBusy = ref(false);
let inflight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 主动刷新提前量：在 access token 到期前 90 秒换新，避免请求撞上 401 */
const REFRESH_LEAD_MS = 90_000;

function scheduleProactiveRefresh(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const exp = tokenExpiry(accessToken.value);
  if (!exp) return;
  const delay = Math.max(0, exp * 1000 - Date.now() - REFRESH_LEAD_MS);
  refreshTimer = setTimeout(() => { void refreshTokens(); }, Math.min(delay, 2 ** 31 - 1));
}

function applyGrant(grant: TokenGrant): void {
  saveTokens(grant.accessToken, grant.refreshToken);
  user.value = grant.user as CurrentUser;
  loaded.value = true;
  scheduleProactiveRefresh();
}

// 刷新失败（令牌被撤销/过期）意味着登出；刷新成功同步最新用户资料
// 并重排主动刷新定时器（否则主动刷新只在第一轮生效，之后全靠 401 兜底）
onAuthChanged(grant => {
  if (!grant) { user.value = null; loaded.value = true; return; }
  user.value = grant.user as CurrentUser;
  loaded.value = true;
  scheduleProactiveRefresh();
});

export function useSessionStore() {
  /**
   * 启动引导：本地有令牌就拉取会话，没有则零请求完成（匿名访问不打会话接口）。
   * 持有过期 access token 时先尝试刷新。
   */
  async function initAuth() {
    if (!hydrateTokens()) { loaded.value = true; return; }
    const exp = tokenExpiry(accessToken.value);
    if (exp && exp * 1000 - Date.now() < 0) await refreshTokens();
    if (accessToken.value) {
      scheduleProactiveRefresh();
      await fetchSession(true);
    } else if (readRefreshToken()) {
      // 只剩 refresh token（access 缺失/解析失败）：补一次刷新兜底
      const grant = await refreshTokens();
      if (grant) { scheduleProactiveRefresh(); await fetchSession(true); return; }
      loaded.value = true;
    } else {
      loaded.value = true;
    }
  }

  async function fetchSession(force = false) {
    if (force && inflight) await inflight;
    if (!inflight) {
      inflight = api
        .session()
        .then((value) => {
          user.value = value;
        })
        .catch(() => {
          user.value = null;
        })
        .finally(() => {
          loaded.value = true;
          inflight = null;
        });
    }
    await inflight;
  }

  async function login(input: {
    identifier: string;
    password: string;
    keep?: boolean;
    destination?: string;
    captchaToken?: string;
    captchaRandstr?: string;
    retainUserId?: number;
    conflictPasswords?: Array<{ userId: number; password: string }>;
  }) {
    const result = await api.login(input);
    if ('accessToken' in result && result.accessToken) applyGrant(result);
    return result;
  }

  async function register(input: {
    email: string;
    password: string;
    playerName?: string;
    nickname?: string;
    captchaToken?: string;
    captchaRandstr?: string;
  }) {
    const result = await api.register(input);
    applyGrant(result);
    return result;
  }

  async function logout() {
    if (logoutBusy.value) return;
    logoutBusy.value = true;
    error.value = '';
    try {
      await api.logout();
    } catch { /* 服务端撤销失败也照常本地登出 */ }
    finally {
      clearTokens();
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      user.value = null;
      location.href = '/';
    }
  }

  const isAdmin = computed(
    () => user.value?.role === 'admin' || user.value?.role === 'super_admin',
  );

  // 暴露为 computed，模板里直接 session.user 自动解包
  const userView = computed(() => user.value);
  return {
    user: userView,
    loaded,
    isAdmin,
    error,
    logoutBusy,
    login,
    register,
    logout,
    fetchSession,
    initAuth,
    /** 登录/2FA/初始化等响应自带令牌组时，直接落库并更新用户状态 */
    applyGrant,
  };
}
