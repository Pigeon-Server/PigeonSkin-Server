<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import SecondFactorForm from '@/components/auth/SecondFactorForm.vue';
const i18n = useI18n(), router = useRouter(), session = useSessionStore();
async function complete(redirect: string, grant?: Parameters<typeof session.applyGrant>[0]) {
  // 登录路径的验证响应自带令牌组；重授权路径会话不变，只补拉资料
  if (grant) session.applyGrant(grant);
  else await session.fetchSession(true);
  await router.push(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/user');
}
</script>
<template>
  <div>
    <h1 class="mb-6">{{ i18n.t('security.two_factor') }}</h1>
    <SecondFactorForm @complete="complete" />
  </div>
</template>
