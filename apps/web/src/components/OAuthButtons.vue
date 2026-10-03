<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { oauthApi, type OAuthProvider } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useRoute } from 'vue-router';
import { apiErrorMessage } from '@/lib/api-error';
const route = useRoute();
const i18n = useI18n();
const providers = ref<OAuthProvider[]>([]);
const loading = ref(true);
const error = ref('');
const icons: Record<string, string> = { github: 'code', littleskin: 'cloud', microsoft: 'window' };
async function load() {
  loading.value = true;
  error.value = '';
  try {
    providers.value = (await oauthApi.providers()).providers;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div v-if="loading || error || providers.length" class="mt-6">
    <div class="flex items-center gap-3 text-xs text-muted">
      <span class="h-px flex-1 bg-line" />
      <span>{{ i18n.t('auth.third_party') }}</span>
      <span class="h-px flex-1 bg-line" />
    </div>
    <p v-if="error" class="mt-3 text-xs text-danger" role="alert">
      {{ error }}
      <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </p>
    <div
      v-if="loading"
      class="skeleton h-9 mt-3 rounded"
      role="status"
      :aria-label="i18n.t('common.loading')"
    />
    <div v-else class="mt-3 space-y-2">
      <a
        v-for="provider in providers"
        :key="provider.id"
        class="btn w-full"
        :href="`/auth/oauth/${provider.id}${typeof route.query.redirect === 'string' ? `?redirect=${encodeURIComponent(route.query.redirect)}` : ''}`"
      >
        <AppIcon :name="icons[provider.id] || 'public'" />
        {{ i18n.t('auth.with_provider', { provider: provider.displayName }) }}
      </a>
    </div>
  </div>
</template>
