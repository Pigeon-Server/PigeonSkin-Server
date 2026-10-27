<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { textureSanitizeApi, type TextureSanitizeStatus } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const status = ref<TextureSanitizeStatus | null>(null);
const loading = ref(true), starting = ref(false), error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
/** 作业在跑时轮询进度；pending 归零后停止，不空转。 */
function schedule() {
  clearTimeout(timer);
  const job = status.value?.job;
  if (!disposed && job && !job.done) timer = setTimeout(() => void load(), 4000);
}
async function load() {
  loading.value = !status.value; error.value = '';
  try { status.value = await textureSanitizeApi.status(); }
  catch (failure) { error.value = apiErrorMessage(failure); }
  finally { loading.value = false; schedule(); }
}
async function start() {
  starting.value = true; error.value = '';
  try {
    await textureSanitizeApi.start();
    status.value = await textureSanitizeApi.status();
  } catch (failure) { error.value = apiErrorMessage(failure); }
  finally { starting.value = false; schedule(); }
}
onMounted(load);
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
</script>
<template>
  <section class="panel">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="font-semibold">{{ i18n.t('sanitize.title') }}</h3>
      <AppButton class="btn-sm" :loading="starting" :disabled="loading || !status?.pending" @click="start">
        <AppIcon name="cleaning_services" />{{ i18n.t('sanitize.start') }}
      </AppButton>
    </div>
    <AppSkeleton v-if="loading" variant="stats" :count="4" :columns="2" />
    <dl v-else-if="status" class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
      <div><dt class="text-muted">{{ i18n.t('sanitize.total') }}</dt><dd>{{ i18n.n(status.total) }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('sanitize.pending') }}</dt><dd>{{ i18n.n(status.pending) }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('sanitize.processed') }}</dt><dd>{{ i18n.n(status.job?.processed ?? 0) }}</dd></div>
      <div><dt class="text-muted">{{ i18n.t('sanitize.changed') }}</dt><dd>{{ i18n.n(status.job?.changed ?? 0) }}</dd></div>
    </dl>
    <p v-if="status?.job && !status.job.done" class="mt-3 flex items-center gap-2 text-sm text-muted" role="status">
      <AppIcon name="sync" class="animate-spin" />{{ i18n.t('sanitize.running') }}
    </p>
    <p v-else-if="status?.pending" class="mt-3 text-sm text-muted" role="status">
      {{ i18n.t('sanitize.remaining', { count: i18n.n(status.pending) }) }}
    </p>
    <p v-else-if="status" class="mt-3 text-sm text-muted" role="status">{{ i18n.t('sanitize.complete') }}</p>
    <p v-if="error" class="mt-3 text-sm text-danger" role="alert">
      {{ error }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </p>
    <p class="mt-3 text-xs leading-5 text-muted">{{ i18n.t('sanitize.hint') }}</p>
  </section>
</template>
