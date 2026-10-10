<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, voteApi, type VoteDetail } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import VoteResults from '@/components/VoteResults.vue';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n(), session = useSessionStore(), route = useRoute();
const vote = ref<VoteDetail | null>(null), choices = ref<string[]>([]), error = ref(''), busy = ref(false), loading = ref(true);
const canVote = computed(() => !!vote.value && vote.value.status === 'active' && !vote.value.ballot && vote.value.eligibility.eligible);
const singleChoice = computed({ get: () => choices.value[0] || null, set: value => { choices.value = value ? [String(value)] : []; } });
const ballotOptions = computed(() => vote.value?.options.map(option => ({ value: option.id, label: option.title, description: option.description || undefined, disabled: !canVote.value || busy.value || (vote.value!.maxChoices > 1 && !choices.value.includes(option.id) && choices.value.length >= vote.value!.maxChoices) })) || []);
async function load() {
  loading.value = true; error.value = '';
  try { vote.value = await voteApi.detail(String(route.params.id)); choices.value = vote.value.ballot?.optionIds || []; }
  catch (e) { error.value = apiErrorMessage(e); }
  finally { loading.value = false; }
}
async function submit() {
  if (!vote.value || !canVote.value || busy.value || !choices.value.length) return;
  const selected = vote.value.options.filter(o => choices.value.includes(o.id)).map(o => o.title).join('、');
  if (!await confirmAction(i18n.t('votes.confirm_selection', { choices: selected }))) return;
  busy.value = true; error.value = '';
  try { vote.value = await voteApi.cast(vote.value.id, choices.value, vote.value.version); choices.value = vote.value.ballot?.optionIds || []; }
  catch (e) { error.value = apiErrorMessage(e); if (e instanceof ApiError && ['votes.changed', 'votes.closed', 'votes.already_voted'].includes(e.code)) vote.value = await voteApi.detail(String(route.params.id)); }
  finally { busy.value = false; }
}
watch(() => route.params.id, load); onMounted(load);
</script>
<template>
  <PageHeader :title="vote?.title || i18n.t('votes.title')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/votes" class="page-back">
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('votes.back') }}</span>
        </router-link>
      </nav>
    </template>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p><AppSkeleton v-if="loading" :count="3" />
  <div v-else-if="vote" class="space-y-5">
    <section class="panel space-y-4">
      <div class="flex flex-wrap gap-3 items-center"><span class="badge">{{ i18n.t(`votes.states.${vote.status}`) }}</span><span class="text-sm text-muted">{{ new Date(vote.startsAt).toLocaleString() }} — {{ new Date(vote.endsAt).toLocaleString() }}</span></div>
      <p class="whitespace-pre-wrap">{{ vote.description }}</p>
      <p v-if="vote.closedAt" class="text-sm text-muted">{{ i18n.t('votes.closed_at', { date: new Date(vote.closedAt).toLocaleString() }) }}</p>
      <p class="text-sm text-muted">{{ i18n.t(vote.maxChoices === 1 ? 'votes.single_rule' : 'votes.multiple_rule', { max: vote.maxChoices }) }} {{ i18n.t('votes.once_rule') }}</p>
      <ul v-if="vote.requirements.registeredBefore || vote.requirements.minScore || vote.requirements.requireVerified || vote.requirements.playRules.length" class="text-sm list-disc pl-5 space-y-1">
        <li v-if="vote.requirements.registeredBefore">{{ i18n.t('votes.registration_rule', { date: new Date(vote.requirements.registeredBefore).toLocaleString() }) }}</li>
        <li v-if="vote.requirements.minScore">{{ i18n.t('votes.score_rule', { score: vote.requirements.minScore }) }}</li>
        <li v-if="vote.requirements.requireVerified">{{ i18n.t('votes.email_rule') }}</li>
        <li v-if="vote.requirements.playRules.length">{{ i18n.t('votes.requirements_unavailable') }}</li>
      </ul>
    </section>
    <section class="panel space-y-4">
      <p v-if="vote.ballot" class="alert alert-success" role="status">{{ i18n.t('votes.submitted') }}</p>
      <p v-else-if="!session.user.value" class="text-muted"><router-link :to="{ path: '/login', query: { redirect: route.fullPath } }" class="underline">{{ i18n.t('votes.login_to_vote') }}</router-link></p>
      <p v-else-if="!vote.eligibility.eligible" class="alert alert-warning">{{ i18n.t(vote.eligibility.reason || 'votes.ineligible') }}</p>
      <AppRadioGroup v-if="vote.maxChoices === 1" v-model="singleChoice" name="ballot" class="grid gap-3" :options="ballotOptions" />
      <AppCheckboxGroup v-else v-model="choices" class="grid gap-3" :disabled="!canVote || busy" :options="ballotOptions" />
      <AppButton v-if="canVote" class="btn-primary" :disabled="!choices.length || busy" :loading="busy" @click="submit">{{ i18n.t('votes.submit') }}</AppButton>
    </section>
    <section class="panel"><VoteResults :vote="vote" /></section>
  </div>
</template>
