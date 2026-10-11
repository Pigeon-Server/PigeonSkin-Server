<script setup lang="ts">
// OAuth 社交登录的落地页：服务端回调 302 到这里并携带一次性 code，
// 用它换回令牌对后跳到 code 换回的目标页。
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();
const error = ref('');

function safeDestination(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/user';
}

onMounted(async () => {
  const code = typeof route.query.code === 'string' ? route.query.code : '';
  if (!code) { error.value = i18n.t('auth.oauth_failed'); return; }
  try {
    const result = await api.exchangeToken(code);
    session.applyGrant(result);
    // 一次性 code 已消费，清掉地址栏避免刷新重放
    await router.replace(safeDestination(result.destination));
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
});
</script>
<template>
  <div>
    <h1 class="mb-6">{{ i18n.t('auth.login') }}</h1>
    <p v-if="error" class="alert alert-danger" role="alert">
      {{ error }}
      <router-link to="/login" class="btn-sm ml-2">{{ i18n.t('general.login') }}</router-link>
    </p>
    <p v-else class="text-sm text-muted" role="status">{{ i18n.t('common.loading') }}</p>
  </div>
</template>
