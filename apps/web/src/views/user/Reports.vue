<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { reportApi, type ReportItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const items = ref<ReportItem[]>([]);
const loading = ref(true);
const error = ref('');
async function load() {
  loading.value = true; error.value = '';
  try { items.value = (await reportApi.mine()).items; }
  catch (e) { error.value = apiErrorMessage(e); }
  finally { loading.value = false; }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('general.my-reports')" />
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
  <AppSkeleton v-if="loading" :count="3" />
  <div v-else-if="items.length" class="panel !p-0 overflow-x-auto">
    <table class="table"><thead><tr><th>{{ i18n.t('admin.texture_id') }}</th><th>{{ i18n.t('report.reason') }}</th><th>{{ i18n.t('report.status') }}</th><th>{{ i18n.t('report.time') }}</th></tr></thead>
      <tbody><tr v-for="r in items" :key="r.id"><td><router-link :to="`/skinlib/${r.textureId}`" class="text-brand-600">#{{ r.textureId }}</router-link></td><td class="max-w-md whitespace-pre-wrap break-words">{{ r.reason }}</td><td><span class="badge" :class="r.status === 'resolved' ? 'badge-success' : ''">{{ i18n.t(`report.${r.status}`) }}</span></td><td>{{ i18n.d(r.createdAt) }}</td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else-if="!error" :title="i18n.t('report.empty')" icon="outlined_flag" />
</template>
