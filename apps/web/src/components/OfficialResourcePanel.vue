<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { officialResourceApi, type OfficialResourceStatus } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const status = ref<OfficialResourceStatus | null>(null);
const loading = ref(true), syncing = ref(false), error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
function schedule() {
  clearTimeout(timer);
  if (!disposed && status.value?.running) timer = setTimeout(() => void load(), 4000);
}
async function load() {
  loading.value = !status.value; error.value = '';
  try { status.value = await officialResourceApi.status(); }
  catch (failure) { error.value = apiErrorMessage(failure); }
  finally { loading.value = false; schedule(); }
}
async function sync() {
  syncing.value = true; error.value = '';
  try { status.value = await officialResourceApi.sync(); }
  catch (failure) { error.value = apiErrorMessage(failure); }
  finally { syncing.value = false; schedule(); }
}
onMounted(load);
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
</script>
<template>
  <section class="panel">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="font-semibold">{{ i18n.t('resources.title') }}</h3>
      <AppButton class="btn-sm" :loading="syncing" :disabled="loading || status?.running" @click="sync"><AppIcon name="sync" />{{ i18n.t('resources.sync') }}</AppButton>
    </div>
    <AppSkeleton v-if="loading" :count="2" />
    <dl v-else-if="status" class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
      <div><dt class="text-muted">{{ i18n.t('general.skin') }}</dt><dd>{{ i18n.n(status.skins) }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('general.cape') }}</dt><dd>{{ i18n.n(status.capes) }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('resources.last_checked') }}</dt><dd>{{ status.checkedAt ? i18n.d(status.checkedAt) : i18n.t('resources.not_checked') }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('resources.last_success') }}</dt><dd>{{ status.succeededAt ? i18n.d(status.succeededAt) : i18n.t('resources.not_checked') }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('resources.game_version') }}</dt><dd>{{ status.clientVersion }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('resources.last_changes') }}</dt><dd>{{ i18n.t('resources.changes', { added: i18n.n(status.added), updated: i18n.n(status.updated) }) }}</dd></div>
    </dl>
    <p v-if="status?.running" class="mt-3 flex items-center gap-2 text-sm text-muted" role="status"><AppIcon name="sync" class="animate-spin" />{{ i18n.t(status.error ? 'resources.retrying' : 'resources.phases.' + status.phase) }}</p>
    <p v-else-if="status?.error" class="mt-3 text-sm text-danger" role="status">{{ i18n.t('resources.sync_failed') }}</p>
    <p v-if="status?.pending" class="mt-3 text-sm text-muted" role="status">{{ i18n.t('resources.remaining', { count: i18n.n(status.pending) }) }}</p>
    <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
    <p class="mt-3 text-xs leading-5 text-muted">{{ i18n.t('resources.schedule_hint') }}</p>
  </section>
</template>
