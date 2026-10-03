<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, type SearchSubmissionStatus } from '@/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import CopyField from '@/components/ui/CopyField.vue';
const i18n = useI18n();
const session = useSessionStore();
const state = ref<SearchSubmissionStatus | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const engines = [
  { id: 'google', name: 'Google', url: 'https://search.google.com/search-console' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/webmasters' },
  { id: 'baidu', name: 'Baidu', url: 'https://ziyuan.baidu.com/linksubmit/index' },
  { id: 'sogou', name: 'Sogou', url: 'https://zhanzhang.sogou.com/' },
];
async function load() {
  error.value = '';
  try { state.value = await adminApi.searchSubmissions(); }
  catch (e) { error.value = apiErrorMessage(e); }
}
async function submit() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await adminApi.submitPublicTextures();
    notice.value = i18n.t('integration.search.queued', { count: i18n.n(result.queued) });
    await load();
  } catch (e) { error.value = apiErrorMessage(e); }
  finally { busy.value = false; }
}
function count(engine: string, status: string) {
  return state.value?.counts.find(item => item.engine === engine && item.status === status)?.count || 0;
}
onMounted(load);
</script>
<template>
  <section class="panel space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="font-semibold">{{ i18n.t('integration.search.title') }}</h3>
      <div class="flex flex-wrap gap-2">
        <AppButton :disabled="busy" @click="load">{{ i18n.t('common.refresh') }}</AppButton>
        <AppButton v-if="session.user.value?.role === 'super_admin'" :loading="busy" :disabled="!state?.root || !Object.values(state?.enabled || {}).some(Boolean)" @click="submit">{{ i18n.t('integration.search.submit_all') }}</AppButton>
      </div>
    </div>
    <p class="text-sm text-muted">{{ i18n.t('integration.search.help') }}</p>
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <template v-if="state">
      <CopyField v-if="state.sitemapUrl" :label="i18n.t('integration.search.sitemap')" :value="state.sitemapUrl" />
      <p v-else class="alert alert-warning">{{ i18n.t('integration.search.site_required') }}</p>
      <p v-if="!state.queueConfigured" class="alert alert-warning">{{ i18n.t('integration.search.queue_required') }}</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <article v-for="engine in engines" :key="engine.id" class="rounded-lg border border-line p-4 space-y-2">
          <div class="flex justify-between gap-2"><strong>{{ engine.name }}</strong><span class="text-xs text-muted">{{ i18n.t(engine.id === 'sogou' ? 'integration.search.manual' : state.enabled[engine.id] ? 'common.enabled' : 'common.disabled') }}</span></div>
          <p class="text-sm text-muted">{{ i18n.t(`integration.search.${engine.id}_help`) }}</p>
          <p v-if="engine.id !== 'sogou'" class="text-xs text-muted">{{ i18n.t('integration.search.counts', { pending: i18n.n(count(engine.id, 'pending')), submitted: i18n.n(count(engine.id, 'submitted')), failed: i18n.n(count(engine.id, 'failed')) }) }}</p>
          <a :href="engine.url" target="_blank" rel="noopener noreferrer" class="text-sm text-brand-600 dark:text-brand-400">{{ i18n.t('integration.search.webmaster') }} ↗</a>
        </article>
      </div>
      <div class="overflow-x-auto">
        <table class="table">
          <thead><tr><th>{{ i18n.t('integration.search.engine') }}</th><th>{{ i18n.t('integration.search.page') }}</th><th>{{ i18n.t('integration.search.status') }}</th><th>{{ i18n.t('integration.search.response') }}</th><th>{{ i18n.t('admin.audit_time') }}</th></tr></thead>
          <tbody>
            <tr v-for="item in state.recent" :key="`${item.engine}-${item.textureId}`">
              <td>{{ engines.find(engine => engine.id === item.engine)?.name }}</td>
              <td>{{ item.textureId ? `/skinlib/${item.textureId}` : '/sitemap.xml' }}</td>
              <td>{{ i18n.t(`integration.search.${item.status}`) }}</td>
              <td>{{ item.httpStatus ?? '—' }}<span v-if="item.error"> · {{ i18n.t(item.error.startsWith('http_') ? 'integration.search.http_error' : `integration.search.${item.error}`) }}</span></td>
              <td class="whitespace-nowrap">{{ i18n.d(item.updatedAt) }}</td>
            </tr>
            <tr v-if="!state.recent.length"><td colspan="5" class="text-center text-muted">{{ i18n.t('integration.search.empty') }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
