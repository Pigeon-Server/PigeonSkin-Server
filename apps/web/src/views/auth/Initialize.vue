<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, initializationApi, type AccountInitialization } from '@/api';
import { submitAccountInitialization } from '@/lib/account-initialization';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();
const status = ref<AccountInitialization | null>(null);
const email = ref('');
const nickname = ref('');
const password = ref('');
const passwordConfirm = ref('');
const playerName = ref('');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const redirecting = ref(false);
const retryable = ref(false);
const requested = typeof route.query.redirect === 'string' ? route.query.redirect : '/user';
const destination = requested.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\') && !requested.startsWith('/auth/') ? requested : '/user';
function redirect(path: string) {
  redirecting.value = true;
  password.value = ''; passwordConfirm.value = '';
  status.value = null;
  window.location.replace(path);
}
async function load() {
  loading.value = true; error.value = '';
  retryable.value = false;
  password.value = ''; passwordConfirm.value = '';
  try {
    status.value = await initializationApi.status();
    if (status.value.needsInitialization) { email.value = status.value.email; nickname.value = status.value.nickname; }
    else redirect('/user');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { await session.fetchSession(true); await router.replace({ path: '/login', query: { redirect: route.fullPath } }); }
    else { error.value = apiErrorMessage(e); retryable.value = true; }
  }
  finally { loading.value = false; }
}
async function submit() {
  if (busy.value || !status.value?.needsInitialization) return;
  error.value = ''; retryable.value = false;
  if (password.value !== passwordConfirm.value) { error.value = i18n.t('auth.password_mismatch'); return; }
  busy.value = true;
  try {
    const target = await submitAccountInitialization({ email: email.value, nickname: nickname.value, password: password.value, ticket: status.value.ticket, ...(status.value.playerRequired ? { playerName: playerName.value } : {}), redirect: destination });
    redirect(target);
  } catch (e) {
    error.value = apiErrorMessage(e);
    retryable.value = e instanceof ApiError && e.code === 'auth.initialization_expired';
  }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <div class="space-y-4">
    <h1>{{ i18n.t('auth.initialize.title') }}</h1>
    <AppSkeleton v-if="loading || redirecting" :count="3" />
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }}<AppButton v-if="retryable" class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
    <AppForm v-if="!loading && !redirecting && status?.needsInitialization" class="space-y-4" @submit.prevent="submit">
      <label class="block text-sm font-medium" for="init-nickname">{{ i18n.t('auth.nickname') }}<AppInput id="init-nickname" v-model="nickname" class="mt-1" required maxlength="50" autocomplete="nickname" :disabled="busy" /></label>
    <label class="block text-sm font-medium" for="init-email">{{ i18n.t('auth.email') }}<AppInput id="init-email" v-model="email" type="email" class="mt-1" required autocomplete="email" :disabled="busy" /></label>
    <label class="block text-sm font-medium" for="init-password">{{ i18n.t('auth.password') }}<AppInput id="init-password" v-model="password" type="password" class="mt-1" required minlength="8" maxlength="32" autocomplete="new-password" :disabled="busy" /></label>
    <label class="block text-sm font-medium" for="init-password-confirm">{{ i18n.t('auth.repeat-pwd') }}<AppInput id="init-password-confirm" v-model="passwordConfirm" type="password" class="mt-1" required autocomplete="new-password" :disabled="busy" /></label>
      <div v-if="status.playerRequired">
        <label class="block text-sm font-medium" for="init-player">{{ i18n.t('auth.player-name') }}<AppInput id="init-player" v-model="playerName" class="mt-1" required :minlength="status.playerNameMin" :maxlength="status.playerNameMax" :disabled="busy" /></label>
        <p class="mt-1 text-xs text-muted">{{ i18n.t('auth.player_name_hint') }}</p>
      </div>
      <AppButton type="submit" class="btn-primary w-full" :loading="busy">{{ i18n.t('auth.initialize.submit') }}</AppButton>
    </AppForm>
    <router-link v-if="!redirecting" to="/account/security" class="btn text-sm">{{ i18n.t('security.title') }}</router-link>
    <AppButton v-if="!redirecting" class="text-sm" :disabled="busy" @click="session.logout">{{ i18n.t('general.logout') }}</AppButton>
  </div>
</template>
