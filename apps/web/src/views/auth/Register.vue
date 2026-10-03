<script setup lang="ts">
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { useSiteSettings } from '@/stores/site';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import OAuthButtons from '@/components/OAuthButtons.vue';
import { apiErrorMessage } from '@/lib/api-error';

const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();
void site.fetch();
const turnstileToken = ref('');
const challenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);

const email = ref('');
const password = ref('');
const passwordConfirm = ref('');
const displayName = ref('');
const withPlayerName = computed(() => site.get('register_with_player_name') !== 'false');
const initialScore = computed(() => site.get('initial_score'));
const registrationEnabled = computed(() => site.get('registration_enabled') !== 'false');
const error = ref('');
const busy = ref(false);



async function submit() {
  error.value = '';
  if (!registrationEnabled.value || busy.value) return;
  if (password.value !== passwordConfirm.value) {
    error.value = i18n.t('auth.password_mismatch');
    return;
  }
  busy.value = true;
  try {
    await session.register({
      email: email.value,
      turnstileToken: turnstileToken.value,
      password: password.value,
      ...(withPlayerName.value
        ? { playerName: displayName.value }
        : { nickname: displayName.value }),
    });
    void router.push('/user');
  } catch (e) {
    if (e instanceof ApiError
      && (e.code === 'email.domain_denied' || e.code === 'email.domain_not_allowed')) {
      error.value = i18n.t('auth.email_domain_denied');
    } else {
      error.value = apiErrorMessage(e);
    }
  } finally {
    busy.value = false;
    challenge.value?.reset();
  }
}
</script>

<template>
  <div class="auth-fields">
    <h1 class="text-2xl font-bold">{{ i18n.t('auth.register') }}</h1>
    <p v-if="initialScore" class="mt-1 text-sm text-muted">
      {{ i18n.t('auth.initial_score', { score: i18n.n(Number(initialScore)) }) }}
    </p>
    <p v-if="site.error.value" class="alert alert-danger" role="alert">{{ i18n.t(site.error.value) }}<AppButton class="btn-sm ml-2" @click="site.fetch(true)">{{ i18n.t('common.retry') }}</AppButton></p>
    <p v-else-if="!site.ready.value" class="mt-6 text-sm text-muted" role="status">{{ i18n.t('common.loading') }}</p>
    <p v-else-if="!registrationEnabled" class="alert alert-warning">{{ i18n.t('auth.registration_disabled') }}</p>
    <AppForm v-else class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="email">{{ i18n.t('auth.email') }}</label>
        <AppInput id="email" v-model="email" type="email" required autocomplete="email" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="reg-password">{{ i18n.t('auth.password') }}</label>
        <AppInput id="reg-password" v-model="password" type="password" required minlength="8" maxlength="32" autocomplete="new-password" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="password2">{{ i18n.t('auth.repeat-pwd') }}</label>
        <AppInput id="password2" v-model="passwordConfirm" type="password" required autocomplete="new-password" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="display">
          {{ withPlayerName ? i18n.t('auth.player-name') : i18n.t('auth.nickname') }}
        </label>
        <AppInput id="display" v-model="displayName" required :minlength="withPlayerName ? Number(site.get('player_name_length_min')) || 3 : 1" :maxlength="withPlayerName ? Number(site.get('player_name_length_max')) || 16 : 50" />
        <p v-if="withPlayerName" class="mt-1 text-xs text-muted">
          {{ i18n.t('auth.player_name_hint') }}
        </p>
      </div>
      <VerificationChallenge ref="challenge" v-model="turnstileToken" />
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <AppButton type="submit" class="btn btn-primary w-full" :loading="busy">
        {{ i18n.t('general.register') }}
      </AppButton>
    </AppForm>
    <p class="mt-4 text-sm text-muted">
      {{ i18n.t('auth.has_account') }}
      <router-link to="/login" class="text-brand-600 dark:text-brand-400">{{ i18n.t('general.login') }}</router-link>
    </p>
    <OAuthButtons />
  </div>
</template>
