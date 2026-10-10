// 会话状态：当前用户 + 登录/登出。角色判定集中在这里。
import { computed, ref } from 'vue';
import { api, ApiError, type CurrentUser } from '@/api';

const user = ref<CurrentUser | null>(null);
const loaded = ref(false);
const error = ref('');
const logoutBusy = ref(false);
let inflight: Promise<void> | null = null;

export function useSessionStore() {
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
    if (!result.requiresTwoFactor) await fetchSession(true);
    return result;
  }

  // 注册成功后端已自动登录（写好会话 Cookie），这里只补拉一次会话。
  async function register(input: {
    email: string;
    password: string;
    playerName?: string;
    nickname?: string;
    captchaToken?: string;
    captchaRandstr?: string;
  }) {
    await api.register(input);
    await fetchSession(true);
  }

  async function logout() {
    if (logoutBusy.value) return;
    logoutBusy.value = true;
    error.value = '';
    try {
      await api.logout();
      user.value = null;
      location.href = '/';
    } catch (e) {
      error.value = e instanceof ApiError ? e.code : 'common.network';
    } finally {
      logoutBusy.value = false;
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
  };
}
