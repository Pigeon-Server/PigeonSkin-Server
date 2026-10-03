<script setup lang="ts">
import type { VoteDetail } from '@/api';
import { useI18n } from '@/stores/i18n';
defineProps<{ vote: VoteDetail }>();
const i18n = useI18n();
function percent(count: number | null, total: number | null) { return total ? Math.round((count || 0) / total * 1000) / 10 : 0; }
</script>
<template>
  <section v-if="vote.resultsVisible" class="space-y-4">
    <h2 class="text-lg font-semibold">{{ i18n.t('votes.results') }}</h2>
    <p class="text-sm text-muted">{{ i18n.t('votes.participants', { count: vote.participants || 0 }) }}</p>
    <div v-for="option in vote.options" :key="option.id" class="space-y-2">
      <div class="flex justify-between gap-3"><span>{{ option.title }}</span><span class="text-sm">{{ i18n.t('votes.count', { count: option.votes || 0 }) }} · {{ percent(option.votes, vote.participants) }}%</span></div>
      <div class="h-2 rounded-full bg-line overflow-hidden" role="meter" :aria-label="option.title" :aria-valuenow="percent(option.votes, vote.participants)" aria-valuemin="0" aria-valuemax="100"><div class="h-full rounded-full bg-primary" :style="{ width: `${percent(option.votes, vote.participants)}%` }" /></div>
    </div>
    <p v-if="vote.maxChoices > 1" class="text-xs text-muted">{{ i18n.t('votes.multiple_percent') }}</p>
  </section>
  <p v-else class="text-sm text-muted">{{ i18n.t(vote.resultsPolicy === 'after_vote' ? 'votes.hidden_until_vote' : 'votes.hidden_until_close') }}</p>
</template>
