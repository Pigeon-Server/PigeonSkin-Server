<script setup lang="ts">
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { useSiteSettings } from '@/stores/site';
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ApiError, securityApi } from '@/api';
import { startAuthentication } from '@simplewebauthn/browser';
import { passkeysSupported, securityError } from '@/lib/security';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import OAuthButtons from '@/components/OAuthButtons.vue';
import { isErrorCode } from '@pigeon-skin/shared';
import { apiErrorMessage } from '@/lib/api-error';

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();
void site.fetch();
const turnstileToken = ref('');
const challenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);

const identifier = ref('');
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
const passkeySupported = passkeysSupported();

async function passkeyLogin() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/user';
    const response = await startAuthentication({ optionsJSON: await securityApi.loginOptions(keep.value, target) });
    const result = await securityApi.passkeyLogin(response);
    await session.fetchSession(true);
    await router.push(result.redirect);
  } catch (e) { error.value = i18n.t(securityError(e)); }
  finally { busy.value = false; }
}

async function submit() {
  if (conflicts.value.length && !mergeConfirmed.value) return;
  error.value = '';
  busy.value = true;
  try {
    const result = await session.login({
      identifier: identifier.value,
      password: password.value,
      keep: keep.value,
      destination: typeof route.query.redirect === 'string' ? route.query.redirect : '/user',
      turnstileToken: turnstileToken.value,
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
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
    challenge.value?.reset();
  }
}
</script>

<template>
  <div class="auth-fields">
    <h1 class="text-2xl font-bold">{{ i18n.t('auth.login') }}</h1>
    <AppForm class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="identifier">
          {{ i18n.t('auth.identification') }}
        </label>
        <AppInput
          id="identifier"
          v-model="identifier"
          required
          autocomplete="username"
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="password">
          {{ i18n.t('auth.password') }}
        </label>
        <AppInput
          id="password"
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
        />
      </div>
      <div class="flex items-center gap-2 text-sm"><AppCheckbox v-model="keep" :label="i18n.t('auth.keep')" /><span>{{ i18n.t('auth.keep') }}</span></div>
      <VerificationChallenge ref="challenge" v-model="turnstileToken" />
      <fieldset v-if="conflicts.length" class="space-y-3 rounded-lg border border-line p-4">
        <legend class="px-1 font-semibold">{{ i18n.t('auth.conflict_choose') }}</legend>
        <p class="text-sm text-muted">{{ i18n.t('auth.conflict_merge_hint') }}</p>
        <AppRadioGroup v-model="retainedId" name="retained-account" :options="conflicts.map(account => ({ value: account.id, label: `${account.nickname || i18n.t('general.anonymous')} · ID ${account.id}` }))" class="grid gap-2" />
        <div v-for="userId in requiresPasswords" :key="userId">
          <label class="mb-1 block text-sm" :for="`conflict-password-${userId}`">{{ i18n.t('auth.conflict_password', { id: userId }) }}</label>
          <AppInput :id="`conflict-password-${userId}`" v-model="conflictPasswords[userId]" type="password" autocomplete="current-password" required />
        </div>
        <div class="flex items-start gap-2 text-sm"><AppCheckbox v-model="mergeConfirmed" :label="i18n.t('auth.conflict_confirm')" /><span>{{ i18n.t('auth.conflict_confirm') }}</span></div>
      </fieldset>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <AppButton type="submit" class="btn btn-primary w-full" :loading="busy">
        {{ i18n.t(conflicts.length ? 'auth.conflict_merge_login' : 'auth.login') }}
      </AppButton>
    </AppForm>
    <AppButton v-if="passkeySupported" class="btn mt-3 w-full" :disabled="busy" @click="passkeyLogin">{{ i18n.t('security.passkey_login') }}</AppButton>
    <div class="mt-4 space-y-1 text-sm text-muted">
      <p>
        <router-link to="/forgot-password" class="text-brand-600 dark:text-brand-400">
          {{ i18n.t('auth.forgot-link') }}
        </router-link>
      </p>
      <p>
        {{ i18n.t('auth.no_account') }}
        <router-link to="/register" class="text-brand-600 dark:text-brand-400">
          {{ i18n.t('general.register') }}
        </router-link>
      </p>
    </div>
    <OAuthButtons />
  </div>
</template>
