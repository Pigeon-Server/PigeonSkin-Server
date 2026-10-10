<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { voteApi, type VoteSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const items = ref<VoteSummary[]>([]), page = ref(1), totalPages = ref(1), status = ref('');
const loading = ref(true), error = ref('');
async function load() {
  loading.value = true; error.value = '';
  try { const data = await voteApi.list(page.value, status.value); items.value = data.items; totalPages.value = data.totalPages; }
  catch (e) { error.value = apiErrorMessage(e); }
  finally { loading.value = false; }
}
function filter() { page.value = 1; void load(); }
function move(delta: number) { page.value += delta; void load(); }
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('votes.title')"><AppButton @click="load">{{ i18n.t('common.refresh') }}</AppButton></PageHeader>
  <div><AppSelect id="vote-filter" v-model="status" class="!w-auto" :aria-label="i18n.t('votes.status_filter')" :options="[{ value: '', label: i18n.t('votes.all') }, ...['active', 'scheduled', 'ended', 'closed', 'cancelled'].map(state => ({ value: state, label: i18n.t(`votes.states.${state}`) }))]" @change="filter" /></div>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  <AppSkeleton v-if="loading" :count="3" />
  <p v-else-if="!items.length" class="panel text-muted">{{ i18n.t('votes.empty') }}</p>
  <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    <article v-for="vote in items" :key="vote.id" class="panel flex flex-col gap-4">
      <div class="flex items-center justify-between gap-2"><span class="badge">{{ i18n.t(`votes.states.${vote.status}`) }}</span><span v-if="vote.voted" class="text-sm text-success">{{ i18n.t('votes.voted') }}</span></div>
      <h2 class="text-xl font-semibold"><router-link :to="`/votes/${vote.id}`">{{ vote.title }}</router-link></h2>
      <p class="text-muted whitespace-pre-wrap line-clamp-3">{{ vote.description }}</p>
      <p class="mt-auto text-xs text-muted">{{ i18n.t('votes.ends_at') }} {{ new Date(vote.endsAt).toLocaleString() }}</p>
      <router-link :to="`/votes/${vote.id}`" class="btn">{{ i18n.t(vote.status === 'active' && !vote.voted ? 'votes.participate' : 'votes.view') }}</router-link>
    </article>
  </div>
  <div v-if="totalPages > 1" class="flex items-center justify-center gap-4"><AppButton :disabled="page <= 1 || loading" @click="move(-1)">{{ i18n.t('votes.previous') }}</AppButton><span>{{ page }} / {{ totalPages }}</span><AppButton :disabled="page >= totalPages || loading" @click="move(1)">{{ i18n.t('votes.next') }}</AppButton></div>
</template>
