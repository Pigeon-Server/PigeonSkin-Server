<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { voteApi, type VoteSummary, type VoteDetail, type VoteContent, type VoteRecord } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import VoteResults from '@/components/VoteResults.vue';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const items = ref<VoteSummary[]>([]), page = ref(1), totalPages = ref(1), filter = ref(''), search = ref(''), busy = ref(false), loading = ref(true), error = ref('');
const open = ref(false), editing = ref<VoteDetail | null>(null), detail = ref<VoteDetail | null>(null), detailOpen = ref(false);
const recordOpen = ref(false), records = ref<VoteRecord[]>([]), recordPage = ref(1), recordPages = ref(1), recordVote = ref(''), recordUser = ref<number | null>(null);
function localDate(ms: number) { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function blank() { const now = Date.now(); return { title: '', description: '', starts: localDate(now), ends: localDate(now + 86400000), maxChoices: 1, resultsPolicy: 'after_close' as VoteContent['resultsPolicy'], registered: '', minScore: 0, requireVerified: false, options: [{ id: crypto.randomUUID() as string, title: '', description: '' }, { id: crypto.randomUUID() as string, title: '', description: '' }] }; }
const form = ref(blank());
const reviewAcknowledged = ref(false);
function addOption() { form.value.options.push({ id: crypto.randomUUID(), title: '', description: '' }); }
const validChoices = computed(() => form.value.maxChoices >= 1 && form.value.maxChoices <= form.value.options.length);
async function load() { loading.value = true; try { const data = await voteApi.adminList(page.value, filter.value, search.value); items.value = data.items; totalPages.value = data.totalPages; } finally { loading.value = false; } }
async function perform(action: () => Promise<unknown>) { if (busy.value) return; busy.value = true; error.value = ''; try { await action(); } catch (e) { error.value = apiErrorMessage(e); } finally { busy.value = false; } }
function create() { editing.value = null; reviewAcknowledged.value = false; form.value = blank(); open.value = true; error.value = ''; }
async function edit(id: string) { await perform(async () => { const v = await voteApi.adminDetail(id); editing.value = v; reviewAcknowledged.value = false; form.value = { title: v.title, description: v.description, starts: localDate(v.startsAt), ends: localDate(v.endsAt), maxChoices: v.maxChoices, resultsPolicy: v.resultsPolicy, registered: v.requirements.registeredBefore === null ? '' : localDate(v.requirements.registeredBefore), minScore: v.requirements.minScore, requireVerified: v.requirements.requireVerified, options: v.options.map(o => ({ id: o.id, title: o.title, description: o.description })) }; open.value = true; }); }
async function save() {
  if (!validChoices.value) return;
  await perform(async () => {
    const content: VoteContent = { title: form.value.title, description: form.value.description, startsAt: new Date(form.value.starts).getTime(), endsAt: new Date(form.value.ends).getTime(), maxChoices: form.value.maxChoices, resultsPolicy: form.value.resultsPolicy, registeredBefore: form.value.registered ? new Date(form.value.registered).getTime() : null, minScore: form.value.minScore, requireVerified: form.value.requireVerified, playRules: editing.value?.requirements.playRules || [], options: form.value.options };
    if (editing.value) await voteApi.edit(editing.value.id, content, editing.value.version, reviewAcknowledged.value); else await voteApi.create(content);
    open.value = false; await load();
  });
}
async function action(id: string, actionName: string) {
  if (!await confirmAction(i18n.t(`votes.confirm_${actionName}`))) return;
  await perform(async () => { const v = await voteApi.adminDetail(id); await voteApi.action(id, actionName, v.version); await load(); });
}
async function show(id: string) { await perform(async () => { detail.value = await voteApi.adminDetail(id); detailOpen.value = true; }); }
async function loadRecords() { const data = await voteApi.records(recordPage.value, recordVote.value, recordUser.value === null ? '' : String(recordUser.value)); records.value = data.items; recordPages.value = data.totalPages; }
async function showRecords(id = '') { recordVote.value = id; recordUser.value = null; recordPage.value = 1; recordOpen.value = true; await perform(loadRecords); }
async function move(delta: number) { page.value += delta; await perform(load); }
async function recordMove(delta: number) { recordPage.value += delta; await perform(loadRecords); }
async function exportRecords() { await perform(async () => { const blob = await voteApi.exportRecords(recordVote.value, recordUser.value === null ? '' : String(recordUser.value)); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'vote-records.csv'; link.click(); URL.revokeObjectURL(url); }); }
function acknowledgeReview() { reviewAcknowledged.value = !reviewAcknowledged.value; }
function swap(i: number, offset: number) { const other = form.value.options[i + offset]; if (!other) return; const current = form.value.options[i]!; form.value.options.splice(i, 1, other); form.value.options.splice(i + offset, 1, current); }
onMounted(() => perform(load));
</script>
<template>
  <PageHeader :title="i18n.t('votes.management')"><AppButton @click="showRecords()">{{ i18n.t('votes.records') }}</AppButton><AppButton class="btn-primary" @click="create">{{ i18n.t('votes.create') }}</AppButton></PageHeader>
  <p v-if="error && !open" class="alert alert-danger" role="alert">{{ error }}</p>
  <AppForm class="flex gap-3 mb-5 flex-wrap" @submit.prevent="page = 1; perform(load)"><AppInput v-model="search" class="!w-auto" :placeholder="i18n.t('votes.search')" :aria-label="i18n.t('votes.search')" /><AppSelect v-model="filter" class="!w-auto" :aria-label="i18n.t('votes.status_filter')" :options="[{ value: '', label: i18n.t('votes.all') }, ...['draft', 'scheduled', 'active', 'ended', 'closed', 'cancelled', 'archived'].map(state => ({ value: state, label: i18n.t(`votes.states.${state}`) }))]" @change="page = 1; perform(load)" /><AppButton type="submit">{{ i18n.t('votes.search') }}</AppButton></AppForm>
  <AppSkeleton v-if="loading" :count="3" />
  <p v-else-if="!items.length" class="panel text-muted">{{ i18n.t('votes.empty') }}</p>
  <div v-else class="space-y-4"><article v-for="vote in items" :key="vote.id" class="panel space-y-3"><div class="flex flex-wrap justify-between gap-3"><h2 class="text-lg font-semibold">{{ vote.title }}</h2><span class="badge">{{ i18n.t(`votes.states.${vote.status}`) }}</span></div><p class="text-sm text-muted">{{ new Date(vote.startsAt).toLocaleString() }} — {{ new Date(vote.endsAt).toLocaleString() }} · {{ i18n.t('votes.participants', { count: vote.participants || 0 }) }}</p><div class="flex gap-2 flex-wrap"><AppButton :disabled="busy" @click="show(vote.id)">{{ i18n.t('votes.statistics') }}</AppButton><AppButton :disabled="busy" @click="showRecords(vote.id)">{{ i18n.t('votes.records') }}</AppButton><template v-if="vote.status === 'draft'"><AppButton :disabled="busy" @click="edit(vote.id)">{{ i18n.t('votes.edit') }}</AppButton><AppButton :disabled="busy" @click="action(vote.id, 'publish')">{{ i18n.t('votes.publish') }}</AppButton></template><template v-if="['active', 'scheduled'].includes(vote.status)"><AppButton :disabled="busy" @click="action(vote.id, 'close')">{{ i18n.t('votes.close') }}</AppButton><AppButton :disabled="busy" @click="action(vote.id, 'cancel')">{{ i18n.t('votes.cancel_vote') }}</AppButton></template><AppButton v-if="!['active', 'scheduled', 'archived'].includes(vote.status)" :disabled="busy" @click="action(vote.id, 'archive')">{{ i18n.t('votes.archive') }}</AppButton><AppButton v-if="vote.status === 'archived'" :disabled="busy" @click="action(vote.id, 'restore')">{{ i18n.t('votes.restore') }}</AppButton></div></article></div>
  <div v-if="totalPages > 1" class="mt-5 flex gap-4 justify-center"><AppButton :disabled="page <= 1 || busy" @click="move(-1)">{{ i18n.t('votes.previous') }}</AppButton><span>{{ page }} / {{ totalPages }}</span><AppButton :disabled="page >= totalPages || busy" @click="move(1)">{{ i18n.t('votes.next') }}</AppButton></div>
  <AppDialog v-model="open" :title="i18n.t(editing ? 'votes.edit' : 'votes.create')" :busy="busy">
    <AppForm class="space-y-4" @submit.prevent="save">
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <div v-if="editing?.reviewRequired" class="alert alert-warning space-y-3"><p>{{ i18n.t('votes.legacy_review_required') }}</p><ul><li v-for="(note, index) in editing.reviewNotes" :key="index" class="text-xs break-all">{{ note.type }}：{{ note.data }}</li></ul><div class="flex gap-2"><AppCheckbox :model-value="reviewAcknowledged" :label="i18n.t('votes.review_acknowledgement')" @update:model-value="acknowledgeReview" /><span>{{ i18n.t('votes.review_acknowledgement') }}</span></div></div>
      <label class="block">{{ i18n.t('votes.subject') }}<AppInput v-model="form.title" class="mt-1" required maxlength="100" /></label><label class="block">{{ i18n.t('votes.description') }}<AppInput v-model="form.description" multiline class="mt-1" rows="3" maxlength="5000" /></label>
      <div class="grid gap-3 sm:grid-cols-2"><label>{{ i18n.t('votes.starts_at') }}<AppInput v-model="form.starts" type="datetime-local" class="mt-1" required /></label><label>{{ i18n.t('votes.ends_at') }}<AppInput v-model="form.ends" type="datetime-local" class="mt-1" required /></label></div>
      <label class="block">{{ i18n.t('votes.max_choices') }}<AppNumberField v-model="form.maxChoices" :min="1" :max="form.options.length" class="mt-1" required /></label>
      <label class="block">{{ i18n.t('votes.results_policy') }}<AppSelect v-model="form.resultsPolicy" class="mt-1" :options="['after_close', 'after_vote', 'always'].map(policy => ({ value: policy, label: i18n.t(`votes.policies.${policy}`) }))" /></label>
      <fieldset class="space-y-3"><legend class="font-semibold mb-3">{{ i18n.t('votes.eligibility_title') }}</legend><label class="block">{{ i18n.t('votes.registered_before') }}<AppInput v-model="form.registered" type="datetime-local" class="mt-1" /></label><label class="block">{{ i18n.t('votes.min_score') }}<AppNumberField v-model="form.minScore" :min="0" class="mt-1" required /></label><div class="flex gap-2"><AppCheckbox v-model="form.requireVerified" :label="i18n.t('votes.email_rule')" /><span>{{ i18n.t('votes.email_rule') }}</span></div><p class="text-xs text-muted">{{ i18n.t('votes.playtime_reserved') }}</p><p v-if="editing?.requirements.playRules.length" class="alert alert-warning">{{ i18n.t('votes.requirements_unavailable') }}</p></fieldset>
      <fieldset class="space-y-3"><legend class="font-semibold mb-3">{{ i18n.t('votes.options') }}</legend><div v-for="(option, index) in form.options" :key="option.id" class="border border-line rounded-lg p-3 space-y-2"><label class="block">{{ i18n.t('votes.option_title', { index: index + 1 }) }}<AppInput v-model="option.title" class="mt-1" required maxlength="100" /></label><label class="block text-sm">{{ i18n.t('votes.option_description') }}<AppInput v-model="option.description" multiline class="mt-1" rows="2" maxlength="1000" /></label><div class="flex gap-2"><AppButton :disabled="index === 0" @click="swap(index, -1)">{{ i18n.t('votes.move_up') }}</AppButton><AppButton :disabled="index === form.options.length - 1" @click="swap(index, 1)">{{ i18n.t('votes.move_down') }}</AppButton><AppButton :disabled="form.options.length <= 2" @click="form.options.splice(index, 1)">{{ i18n.t('votes.remove_option') }}</AppButton></div></div><AppButton :disabled="form.options.length >= 50" @click="addOption">{{ i18n.t('votes.add_option') }}</AppButton></fieldset>
      <p class="text-xs text-muted">{{ i18n.t('votes.draft_hint') }} {{ i18n.t('votes.freeze_hint') }}</p><AppButton type="submit" class="btn-primary" :disabled="busy || !validChoices || (!!editing?.reviewRequired && !reviewAcknowledged)">{{ i18n.t('votes.save_draft') }}</AppButton>
    </AppForm>
  </AppDialog>
  <AppDialog v-model="detailOpen" :title="detail?.title || i18n.t('votes.statistics')"><div v-if="detail" class="space-y-4"><p class="whitespace-pre-wrap">{{ detail.description }}</p><VoteResults :vote="detail" /></div></AppDialog>
  <AppDialog v-model="recordOpen" :title="i18n.t('votes.records')" :busy="busy">
    <p v-if="error" class="alert alert-danger mb-3" role="alert">{{ error }}</p>
    <AppButton class="mb-3" :disabled="busy" @click="exportRecords">{{ i18n.t('votes.export') }}</AppButton>
    <AppForm class="flex gap-2 mb-4" @submit.prevent="recordPage = 1; perform(loadRecords)"><AppNumberField v-model="recordUser" class="min-w-0 flex-1" :min="1" :placeholder="i18n.t('votes.user_id')" :aria-label="i18n.t('votes.user_id')" /><AppButton type="submit">{{ i18n.t('votes.search') }}</AppButton></AppForm>
    <p v-if="!records.length" class="text-muted">{{ i18n.t('votes.no_records') }}</p><article v-for="record in records" :key="record.id" class="border-b border-line py-3 text-sm space-y-1"><strong>{{ record.voteTitle }}</strong><p>{{ record.voterName }} · {{ record.userId || i18n.t('votes.deleted_user') }}</p><p>{{ record.optionTitles.join('、') }}</p><p class="text-xs text-muted">{{ new Date(record.createdAt).toLocaleString() }} · {{ record.ip }}</p></article>
    <div v-if="recordPages > 1" class="mt-4 flex gap-3 justify-center"><AppButton :disabled="recordPage <= 1 || busy" @click="recordMove(-1)">{{ i18n.t('votes.previous') }}</AppButton><span>{{ recordPage }} / {{ recordPages }}</span><AppButton :disabled="recordPage >= recordPages || busy" @click="recordMove(1)">{{ i18n.t('votes.next') }}</AppButton></div>
  </AppDialog>
</template>
