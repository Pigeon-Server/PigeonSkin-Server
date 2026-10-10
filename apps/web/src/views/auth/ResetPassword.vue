<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const router = useRouter();
const route = useRoute();
const i18n = useI18n();

const token = typeof route.query.token === 'string' ? route.query.token : '';
const password = ref('');
const passwordConfirm = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  if (password.value !== passwordConfirm.value) {
    error.value = i18n.t('auth.password_mismatch');
    return;
  }
  busy.value = true;
  try {
    await api.resetPassword(token, password.value);
    void router.push('/login');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <h1>{{ i18n.t('auth.reset_title') }}</h1>
    <p v-if="!token" class="alert alert-danger mt-6">{{ i18n.t('auth.token_invalid') }}</p>
    <AppForm v-else class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="rp1">{{ i18n.t('auth.reset_new') }}</label>
        <AppInput id="rp1" v-model="password" type="password" required minlength="8" maxlength="32" autocomplete="new-password" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="rp2">{{ i18n.t('auth.repeat-pwd') }}</label>
        <AppInput id="rp2" v-model="passwordConfirm" type="password" required autocomplete="new-password" />
      </div>
      <p v-if="error" class="alert alert-danger">{{ error }}</p>
      <AppButton type="submit" class="btn btn-primary w-full" :disabled="busy">
        {{ i18n.t('general.submit') }}
      </AppButton>
    </AppForm>
  </div>
</template>
