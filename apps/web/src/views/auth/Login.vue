<script setup lang="ts">
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { useSiteSettings } from '@/stores/site';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ApiError, securityApi } from '@/api';
import { startAuthentication } from '@simplewebauthn/browser';
import { passkeysSupported, runCeremony, cancelPasskeyCeremony } from '@/lib/security';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import OAuthButtons from '@/components/auth/OAuthButtons.vue';
import { isErrorCode } from '@pigeon-skin/shared';
import { apiErrorMessage } from '@/lib/api-error';

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();
void site.fetch();
const captchaToken = ref('');
const captchaRandstr = ref('');
const challenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);
// 失败升级：后端按 identifier 计数，达到阈值后要求人机验证。
// 平时不展示验证组件（与旧版一致），仅在后端下发信号后才出现，
// 保证"可见"与"必填"对齐；真正的校验仍由服务端把关。
const captchaRequired = ref(false);

const identifier = ref('');
// 本账号已尝试过通行密钥（无匹配凭据/取消/不支持）：回落密码登录。
// 换账号后重置——新账号可能绑定了通行密钥
const passkeyAttempted = ref(false);
// 失败计数按 identifier 计：换账号后阈值状态随之失效，升级提示一并收起
watch(identifier, () => { captchaRequired.value = false; captchaToken.value = ''; captchaRandstr.value = ''; passkeyAttempted.value = false; password.value = ''; error.value = ''; });
const password = ref('');
const keep = ref(false);
const callbackError = String(route.query.oauth_error || route.query.mojang_error || '');
const error = ref(isErrorCode(callbackError) ? i18n.t(callbackError) : '');
const busy = ref(false);
const conflicts = ref<Array<{ id: number; nickname: string }>>([]);
const requiresPasswords = ref<number[]>([]);
const conflictPasswords = ref<Record<number, string>>({});
const retainedId = ref<number | null>(null);
const mergeConfirmed = ref(false);
const ceremony = ref(false);
const passkeySupported = passkeysSupported();
// passkey 主阶段：密码区（含验证码升级与合并冲突）隐藏，仅留账号输入
const passkeyPhase = computed(() => passkeySupported && !passkeyAttempted.value);

// Connect/OAuth 的匿名 authorize 会把已登录用户送到 /login?redirect=…：
// 会话就绪后直接续走目标页；fresh=1（prompt=login 强制重认证）除外
function redirectIfAuthenticated() {
  const target = route.query.redirect;
  if (!session.loaded.value || !session.user.value) return;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || route.query.fresh) return;
  void router.replace(target);
}
watch(() => session.loaded.value, redirectIfAuthenticated, { immediate: true });
onMounted(redirectIfAuthenticated);

async function passkeyAttempt(): Promise<boolean> {
  const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/user';
  const attemptedFor = identifier.value;
  try {
    const options = await securityApi.loginOptions(keep.value, target, identifier.value);
    ceremony.value = true;
    try {
      const response = await runCeremony(() => startAuthentication({ optionsJSON: options }));
      const result = await securityApi.passkeyLogin(response);
      session.applyGrant(result);
      await router.push(result.redirect);
      return true;
    } finally {
      ceremony.value = false;
    }
  } catch (e) {
    // 浏览器侧结果（无匹配凭据/用户取消/超时）静默回落密码登录，
    // 与服务端"未绑定通行密钥给空 allowCredentials"的约定对接；
    // 服务端错误（网络/配置/限流）照常提示并回落。
    // 直接读错误名：simplewebauthn 会把取消/超时包装成 WebAuthnError
    // （普通 Error，name 保留），不能依赖 instanceof 原型链。
    const name = (e as { name?: string } | null)?.name ?? '';
    if (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'AbortError') { error.value = ''; return false; }
    error.value = e instanceof ApiError ? apiErrorMessage(e) : i18n.t('common.network');
    return false;
  } finally {
    // 本账号的 passkey 已处理过（成功返回 / 失败回落），同一账号不重复弹框；
    // 放在结束而非开始，仪式进行中仍保持"继续"主阶段。仪式期间被换账号时
    // watch 已重置该标记，不覆盖。
    if (identifier.value === attemptedFor) passkeyAttempted.value = true;
  }
}

async function submit() {
  if (conflicts.value.length && !mergeConfirmed.value) return;
  error.value = '';
  busy.value = true;
  try {
    if (passkeySupported && !passkeyAttempted.value && password.value === '') {
      // 回落（无匹配凭据/取消/服务端错误）即停下，等用户输入密码后再提交，
      // 避免拿空密码打一次必然失败的密码登录、并把错误提示覆盖成"密码错误"
      if (!(await passkeyAttempt())) return;
      return;
    }
    const result = await session.login({
      identifier: identifier.value,
      password: password.value,
      keep: keep.value,
      destination: typeof route.query.redirect === 'string' ? route.query.redirect : '/user',
      captchaToken: captchaToken.value,
      captchaRandstr: captchaRandstr.value,
      ...(retainedId.value ? { retainUserId: retainedId.value, conflictPasswords: requiresPasswords.value.map(userId => ({ userId, password: conflictPasswords.value[userId] || '' })) } : {}),
    });
    if (result.requiresTwoFactor) { password.value = ''; conflictPasswords.value = {}; await router.push('/auth/two-factor'); return; }
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/user';
    void router.push(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/user');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'auth.email_conflict' && e.accounts.length) {
      conflicts.value = e.accounts;
      requiresPasswords.value = e.requiresPasswords;
      retainedId.value ??= e.accounts[0]!.id;
    }
    // 失败升级信号：401 携带 captchaRequired，或 403 人机验证未通过
    //（已达阈值时，空/无效凭据必然走到该分支）。置位后显示并强制验证组件。
    if (e instanceof ApiError && (e.captchaRequired || e.code === 'auth.captcha_failed')) captchaRequired.value = true;
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
    challenge.value?.reset();
  }
}
</script>

<template>
  <div>
    <h1>{{ i18n.t('auth.login') }}</h1>
    <AppForm class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="identifier">
          {{ i18n.t('auth.identification') }}
        </label>
        <AppInput
          id="identifier"
          name="identifier"
          v-model="identifier"
          required
          autocomplete="webauthn"
        />
      </div>
      <div v-show="!passkeyPhase">
        <label class="mb-1 block text-sm font-medium" for="password">
          {{ i18n.t('auth.password') }}
        </label>
        <AppInput
          id="password"
          name="password"
          v-model="password"
          type="password"
          :required="!passkeyPhase"
          autocomplete="current-password"
        />
      </div>
      <div v-if="captchaRequired">
        <VerificationChallenge ref="challenge" v-model="captchaToken" v-model:randstr="captchaRandstr" />
        <p v-if="!captchaToken" class="mt-2 text-xs text-muted">
          <span class="material-icons !text-base align-[-2px]" aria-hidden="true">verified_user</span>
          {{ i18n.t('auth.captcha_required') }}
        </p>
      </div>
      <fieldset v-if="conflicts.length" v-show="!passkeyPhase" class="space-y-3 rounded-lg border border-line p-4">
        <legend class="px-1 font-semibold">{{ i18n.t('auth.conflict_choose') }}</legend>
        <p class="text-sm text-muted">{{ i18n.t('auth.conflict_merge_hint') }}</p>
        <AppRadioGroup v-model="retainedId" name="retained-account" :options="conflicts.map(account => ({ value: account.id, label: `${account.nickname || i18n.t('general.unknown')} · ID ${account.id}` }))" class="grid gap-2" />
        <div v-for="userId in requiresPasswords" :key="userId">
          <label class="mb-1 block text-sm" :for="`conflict-password-${userId}`">{{ i18n.t('auth.conflict_password', { id: userId }) }}</label>
          <AppInput :id="`conflict-password-${userId}`" :name="`conflict-password-${userId}`" v-model="conflictPasswords[userId]" type="password" autocomplete="current-password" required />
        </div>
        <div class="flex items-start gap-2 text-sm"><AppCheckbox v-model="mergeConfirmed" :label="i18n.t('auth.conflict_confirm')" /><span>{{ i18n.t('auth.conflict_confirm') }}</span></div>
      </fieldset>
      <div class="flex items-center gap-2 text-sm"><AppCheckbox v-model="keep" :label="i18n.t('auth.keep')" /><span>{{ i18n.t('auth.keep') }}</span></div>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <AppButton type="submit" class="btn btn-primary w-full" :loading="busy">
        {{ i18n.t(conflicts.length ? 'auth.conflict_merge_login' : passkeyPhase ? 'common.continue' : 'auth.login') }}
      </AppButton>
      <AppButton v-if="ceremony" class="btn w-full" @click="cancelPasskeyCeremony()">{{ i18n.t('common.cancel') }}</AppButton>
    </AppForm>
    <div class="mt-4 space-y-1 text-sm text-muted">
      <p>
        <router-link to="/forgot-password" class="text-brand-600 dark:text-brand-300">
          {{ i18n.t('auth.forgot-link') }}
        </router-link>
      </p>
      <p>
        {{ i18n.t('auth.no_account') }}
        <router-link to="/register" class="text-brand-600 dark:text-brand-300">
          {{ i18n.t('general.register') }}
        </router-link>
      </p>
    </div>
    <OAuthButtons />
  </div>
</template>
