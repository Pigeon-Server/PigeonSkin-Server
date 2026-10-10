<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { adminApi, type AdminStats } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const stats = ref<AdminStats | null>(null);
const chart = ref<Array<{ date: string; users: number; textures: number }>>([]);
const loading = ref(true);
const error = ref('');
const cards = [
  { field: 'users', label: 'admin.stats_users', icon: 'groups' },
  { field: 'players', label: 'admin.stats_players', icon: 'sports_esports' },
  { field: 'textures', label: 'admin.stats_textures', icon: 'texture' },
  { field: 'pendingReports', label: 'admin.stats_reports', icon: 'flag' },
  { field: 'storageKb', label: 'admin.stats_storage', icon: 'storage' },
] as const;
const max = computed(() => Math.ceil(Math.max(1, ...chart.value.flatMap((d) => [d.users, d.textures])) / 4) * 4);
function calendarDate(key: string) { const [year, month, day] = key.split('-').map(Number); return new Date(year!, month! - 1, day!); }
const points = (field: 'users' | 'textures') =>
  chart.value
    .map((d, index) => `${20 + index * 30},${190 - (d[field] / max.value) * 160}`)
    .join(' ');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [s, c] = await Promise.all([adminApi.stats(), adminApi.chart()]);
    stats.value = s;
    chart.value = c;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('general.dashboard')">
    <AppButton :loading="loading" @click="load">
      <AppIcon name="refresh" />
      {{ i18n.t('common.retry') }}
    </AppButton>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  <AppSkeleton v-if="loading" :count="5" /><template v-else-if="stats"><div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
    <div v-for="card in cards" :key="card.field" class="panel !p-4">
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted">{{ i18n.t(card.label) }}</span>
        <AppIcon :name="card.icon" class="text-brand-600" />
      </div>
      <p class="mt-3 text-2xl font-semibold tabular-nums">
        {{ stats ? i18n.n(stats[card.field]) : i18n.t('common.loading') }}
      </p>
    </div>
  </div>
  <section class="panel">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="font-semibold">{{ i18n.t('admin.chart_title') }}</h2>
      <div class="flex gap-5 text-xs">
        <span class="text-brand-600">{{ i18n.t('admin.chart_registrations') }}</span>
        <span class="text-blue-600">{{ i18n.t('admin.chart_uploads') }}</span>
      </div>
    </div>
    <svg
      viewBox="0 0 940 230"
      class="w-full mt-5"
      role="img"
      :aria-label="i18n.t('admin.chart_title')"
    >
      <g v-for="n in 5" :key="n">
        <line
          x1="20"
          x2="920"
          :y1="30 + (n - 1) * 40"
          :y2="30 + (n - 1) * 40"
          stroke="var(--v0-border)"
        />
        <text x="20" :y="25 + (n - 1) * 40" font-size="10" fill="var(--v0-muted)">
          {{ i18n.n(Math.round(max * (5 - n) / 4)) }}
        </text>
      </g>
      <polyline :points="points('users')" fill="none" stroke="var(--brand-base)" stroke-width="2.5" />
      <polyline :points="points('textures')" fill="none" stroke="#2563eb" stroke-dasharray="5 3" stroke-width="2.5" />
      <g v-for="(day, index) in chart" :key="day.date">
        <circle :cx="20 + index * 30" :cy="190 - day.users / max * 160" r="3" fill="var(--brand-base)">
          <title>
            {{ i18n.t('admin.chart_point', { date: i18n.d(calendarDate(day.date), 'short'), users: i18n.n(day.users), textures: i18n.n(day.textures) }) }}
          </title>
        </circle>
        <text
          v-if="index % 5 === 0"
          :x="20 + index * 30"
          y="220"
          font-size="10"
          fill="var(--v0-muted)"
        >
          {{ i18n.d(calendarDate(day.date), 'short') }}
        </text>
      </g>
    </svg>
  </section>
  <div class="grid gap-3 sm:grid-cols-3">
    <router-link
      v-for="entry in [{ to: '/admin/reports', label: 'general.report-manage', icon: 'flag' }, { to: '/admin/notifications', label: 'admin.broadcast', icon: 'campaign' }, { to: '/admin/status', label: 'general.status', icon: 'monitor_heart' }]"
      :key="entry.to"
      :to="entry.to"
      class="panel flex items-center gap-3 hover:border-brand-400"
    >
      <AppIcon :name="entry.icon" class="text-brand-600" />
      {{ i18n.t(entry.label) }}
      <AppIcon name="arrow_forward" class="ml-auto text-muted" />
    </router-link>
  </div>
  </template>
</template>
