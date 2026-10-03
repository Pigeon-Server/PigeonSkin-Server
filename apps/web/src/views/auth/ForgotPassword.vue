<script setup lang="ts">
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { useSiteSettings } from '@/stores/site';
import { ref } from 'vue';
import { api } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
const site = useSiteSettings();
void site.fetch();
const turnstileToken = ref('');
const challenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);
const email = ref('');
const sent = ref(false);
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await api.forgotPassword(email.value, turnstileToken.value);
    sent.value = true;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
    challenge.value?.reset();
  }
}
</script>

<template>
  <div class="auth-fields">
    <h1 class="text-2xl font-bold">{{ i18n.t('auth.forgot_title') }}</h1>
    <p v-if="sent" class="alert alert-success mt-6">{{ i18n.t('auth.forgot_sent') }}</p>
    <AppForm v-else class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="fp-email">{{ i18n.t('auth.email') }}</label>
        <AppInput id="fp-email" v-model="email" type="email" required autocomplete="email" />
      </div>
      <VerificationChallenge ref="challenge" v-model="turnstileToken" />
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <AppButton type="submit" class="btn btn-primary w-full" :loading="busy">
        {{ i18n.t('general.submit') }}
      </AppButton>
    </AppForm>
    <p class="mt-4 text-sm">
      <router-link to="/login" class="text-brand-600 dark:text-brand-400">{{ i18n.t('general.login') }}</router-link>
    </p>
  </div>
</template>
