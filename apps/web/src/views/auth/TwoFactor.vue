<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import SecondFactorForm from '@/components/SecondFactorForm.vue';
const i18n = useI18n(), router = useRouter(), session = useSessionStore();
async function complete(redirect: string) {
  await session.fetchSession(true);
  await router.push(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/user');
}
</script>
<template>
  <div>
    <h1 class="mb-6">{{ i18n.t('security.two_factor') }}</h1>
    <SecondFactorForm @complete="complete" />
  </div>
</template>
