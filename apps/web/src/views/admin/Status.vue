<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const data = ref<Awaited<ReturnType<typeof adminApi.status>> | null>(null);
const loading = ref(false);
const error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await adminApi.status();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('general.status')">
    <AppButton :loading="loading" @click="load">
      <AppIcon name="refresh" />
      {{ i18n.t('common.retry') }}
    </AppButton>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  <AppSkeleton v-if="loading" :count="4" />
  <div v-else-if="data" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <div v-for="field in ['database', 'storage'] as const" :key="field" class="panel">
      <AppIcon
        :name="field === 'database' ? 'storage' : 'cloud_queue'"
        class="text-brand-600 !text-3xl"
      />
      <p class="mt-4 text-xs text-muted">{{ i18n.t(`admin.status_${field}`) }}</p>
      <p class="mt-2 font-semibold text-xl" :class="data[field] ? 'text-brand-600' : 'text-danger'">
        {{ i18n.t(data[field] ? 'admin.status_ready' : 'admin.status_error') }}
      </p>
    </div>
    <div class="panel">
      <AppIcon name="speed" class="text-brand-600 !text-3xl" />
      <p class="mt-4 text-xs text-muted">{{ i18n.t('admin.status_latency') }}</p>
      <p class="mt-2 font-semibold text-xl">
        {{ i18n.t('admin.latency_ms', { value: i18n.n(data.latencyMs) }) }}
      </p>
    </div>
    <div class="panel">
      <AppIcon name="code" class="text-brand-600 !text-3xl" />
      <p class="mt-4 text-xs text-muted">{{ i18n.t('admin.status_version') }}</p>
      <p class="mt-2 font-semibold text-xl">{{ data.version }}</p>
      <p class="text-xs text-muted">{{ i18n.t(`admin.environment_${data.environment}`) }}</p>
    </div>
  </div>
</template>
