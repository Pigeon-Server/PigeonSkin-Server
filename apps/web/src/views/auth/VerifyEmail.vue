<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const i18n = useI18n();
const state = ref<'pending' | 'ok' | 'error'>('pending');
const message = ref('');

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  if (!token) {
    state.value = 'error';
    message.value = i18n.t('auth.token_invalid');
    return;
  }
  try {
    await api.verifyEmailConfirm(token);
    state.value = 'ok';
  } catch (e) {
    state.value = 'error';
    message.value = apiErrorMessage(e);
  }
});
</script>

<template>
  <div class="text-center">
    <span
      class="material-icons mx-auto" style="font-size:48px"
      :class="state === 'ok' ? 'text-success' : state === 'error' ? 'text-danger' : 'animate-spin'"
    >{{ state === 'ok' ? 'check_circle' : state === 'error' ? 'error' : 'sync' }}</span>
    <h1 class="mt-4">
      {{ state === 'ok' ? i18n.t('user.verification.verified') : state === 'error' ? message : i18n.t('common.loading') }}
    </h1>
    <router-link to="/user" class="btn btn-primary mt-6 inline-block">{{ i18n.t('general.user-center') }}</router-link>
  </div>
</template>
