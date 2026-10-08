<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { adminApi, type AiJobItem, type SearchSubmissionRecord, type TaskRunItem, type TextureFlagItem } from '@/api';
import { useI18n } from '@/stores/i18n';

const i18n = useI18n();

const tab = ref<'ai' | 'flags' | 'search' | 'runs'>('ai');
const loading = ref(true);
const errMsg = ref('');
const notice = ref('');

// AI 任务
const jobs = ref<AiJobItem[]>([]);
const jobKind = ref('');
const jobStatus = ref('');
const jobPage = ref(1);
const jobTotal = ref(0);
const jobTotalPages = ref(1);

// 审核标记
const flags = ref<TextureFlagItem[]>([]);
const flagPage = ref(1);
const flagTotal = ref(0);
const flagTotalPages = ref(1);

// 搜索提交
const submissions = ref<SearchSubmissionRecord[]>([]);
const subPage = ref(1);
const subTotal = ref(0);
const subTotalPages = ref(1);

// 定时任务
const runs = ref<TaskRunItem[]>([]);

const JOB_KINDS = ['translate_texture', 'moderate_texture_name', 'moderate_texture_description'] as const;
const JOB_STATUSES = ['pending', 'processing', 'done', 'failed', 'cancelled'] as const;
const ENGINES = ['google', 'bing', 'baidu'] as const;

async function loadJobs() {
  const data = await adminApi.aiJobs({ kind: jobKind.value || undefined, status: jobStatus.value || undefined, page: jobPage.value });
  jobs.value = data.items;
  jobTotal.value = data.total;
  jobTotalPages.value = data.totalPages;
}

async function loadFlags() {
  const data = await adminApi.textureFlags(flagPage.value);
  flags.value = data.items;
  flagTotal.value = data.total;
  flagTotalPages.value = data.totalPages;
}

async function loadSubmissions() {
  const data = await adminApi.searchSubmissionRecords(subPage.value);
  submissions.value = data.items;
  subTotal.value = data.total;
  subTotalPages.value = data.totalPages;
}

async function loadRuns() {
  const data = await adminApi.taskRuns();
  runs.value = data.items;
}

async function load() {
  loading.value = true;
  errMsg.value = '';
  notice.value = '';
  try {
    if (tab.value === 'ai') await loadJobs();
    else if (tab.value === 'flags') await loadFlags();
    else if (tab.value === 'search') await loadSubmissions();
    else await loadRuns();
  } catch {
    errMsg.value = i18n.t('common.internal_error');
  } finally { loading.value = false; }
}

function switchTab(next: typeof tab.value) {
  tab.value = next;
  void load();
}

async function retryJob(id: number) {
  try {
    await adminApi.retryAiJob(id);
    notice.value = i18n.t('admin.task_retry');
    await loadJobs();
  } catch { errMsg.value = i18n.t('common.internal_error'); }
}

async function cancelJob(id: number) {
  try {
    await adminApi.cancelAiJob(id);
    await loadJobs();
  } catch { errMsg.value = i18n.t('common.internal_error'); }
}

async function clearFlag(id: number, field: 'name' | 'description') {
  try {
    await adminApi.clearTextureFlag(id, field);
    await loadFlags();
  } catch { errMsg.value = i18n.t('common.internal_error'); }
}

async function retrySubmissions(engine: string) {
  try {
    await adminApi.retrySearchSubmissions(engine);
    await loadSubmissions();
  } catch { errMsg.value = i18n.t('common.internal_error'); }
}

function jobKindLabel(kind: string): string {
  return i18n.t(`admin.job_${kind}`);
}

function statusLabel(status: string): string {
  return i18n.t(`admin.status_${status}`);
}

function fmtTime(ts: number): string {
  return i18n.d(ts);
}

watch(jobPage, () => { void loadJobs(); });
watch(flagPage, () => { void loadFlags(); });
watch(subPage, () => { void loadSubmissions(); });

onMounted(load);
</script>

<template>
  <div class="page page--dense">
    <PageHeader :title="i18n.t('admin.tasks_title')" />

    <div class="flex flex-wrap gap-1">
      <AppButton
        v-for="t in (['ai', 'flags', 'search', 'runs'] as const)"
        :key="t"
        class="!border-0 !bg-transparent !px-3 !py-1.5 text-sm"
        :class="tab === t ? '!text-brand-600 underline underline-offset-4' : 'text-muted'"
        @click="switchTab(t)"
      >
        {{ i18n.t(t === 'ai' ? 'admin.tasks_ai_jobs' : t === 'flags' ? 'admin.task_flagged_content' : t === 'search' ? 'admin.tasks_search_submissions' : 'admin.task_runs') }}
      </AppButton>
    </div>

    <p v-if="errMsg" class="text-sm text-red-600">{{ errMsg }}</p>
    <p v-else-if="notice" class="text-sm text-green-600">{{ notice }}</p>

    <AppCard v-if="loading" class="p-8 text-center text-sm text-muted">{{ i18n.t('common.loading') }}</AppCard>

    <template v-else>
      <!-- AI 任务队列 -->
      <template v-if="tab === 'ai'">
        <div class="flex flex-wrap items-center gap-2">
          <AppSelect v-model="jobKind" class="max-w-48" :options="[{ value: '', label: i18n.t('admin.task_all_types') }, ...JOB_KINDS.map(k => ({ value: k, label: jobKindLabel(k) }))]" @change="() => { jobPage = 1; void loadJobs(); }" />
          <AppSelect v-model="jobStatus" class="max-w-40" :options="[{ value: '', label: i18n.t('admin.task_all_statuses') }, ...JOB_STATUSES.map(s => ({ value: s, label: statusLabel(s) }))]" @change="() => { jobPage = 1; void loadJobs(); }" />
        </div>
        <AppCard class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted">
                <th class="py-2 pr-3 font-medium">ID</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.tasks_ai_jobs') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('skinlib.show.uploader') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_status_col') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_attempts') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_last_error') }}</th>
                <th class="py-2 pr-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id" class="border-b last:border-0">
                <td class="py-2 pr-3">{{ job.id }}</td>
                <td class="py-2 pr-3">{{ jobKindLabel(job.kind) }}</td>
                <td class="py-2 pr-3">
                  <RouterLink v-if="job.texture" :to="`/skinlib/${job.texture.id}`" class="hover:underline">{{ job.texture.name }}</RouterLink>
                  <span v-else class="text-muted">#{{ job.tid }}</span>
                </td>
                <td class="py-2 pr-3">{{ statusLabel(job.status) }}</td>
                <td class="py-2 pr-3">{{ job.attempts }}</td>
                <td class="py-2 pr-3 max-w-64 truncate" :title="job.lastError">{{ job.lastError || '—' }}</td>
                <td class="py-2 pr-3 whitespace-nowrap">
                  <AppButton v-if="job.status === 'failed' || job.status === 'pending' || job.status === 'done'" class="!border-0 !bg-transparent !p-0 text-xs text-brand-600 hover:underline" @click="retryJob(job.id)">{{ i18n.t('admin.task_retry') }}</AppButton>
                  <AppButton v-if="job.status === 'pending'" class="ml-2 !border-0 !bg-transparent !p-0 text-xs text-muted hover:underline" @click="cancelJob(job.id)">{{ i18n.t('admin.task_cancel') }}</AppButton>
                </td>
              </tr>
              <tr v-if="jobs.length === 0"><td colspan="7" class="py-6 text-center text-muted">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </AppCard>
        <AppPagination v-model="jobPage" :total-pages="jobTotalPages" :busy="loading" />
      </template>

      <!-- 审核标记 -->
      <template v-else-if="tab === 'flags'">
        <AppCard class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted">
                <th class="py-2 pr-3 font-medium">ID</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('skinlib.show.name') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.tasks_ai_jobs') }}</th>
                <th class="py-2 pr-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in flags" :key="item.id" class="border-b last:border-0">
                <td class="py-2 pr-3">
                  <RouterLink :to="`/skinlib/${item.id}`" class="hover:underline">{{ item.id }}</RouterLink>
                </td>
                <td class="py-2 pr-3">{{ item.name }}</td>
                <td class="py-2 pr-3 space-x-2">
                  <span v-if="item.nameFlagged" class="text-red-600">{{ i18n.t('admin.job_moderate_texture_name') }}: {{ item.nameFlagReason }}</span>
                  <span v-if="item.descriptionFlagged" class="text-red-600">{{ i18n.t('admin.job_moderate_texture_description') }}: {{ item.descriptionFlagReason }}</span>
                </td>
                <td class="py-2 pr-3 whitespace-nowrap">
                  <AppButton v-if="item.nameFlagged" class="!border-0 !bg-transparent !p-0 text-xs text-brand-600 hover:underline" @click="clearFlag(item.id, 'name')">{{ i18n.t('admin.task_clear_flag') }}</AppButton>
                  <AppButton v-if="item.descriptionFlagged" class="ml-2 !border-0 !bg-transparent !p-0 text-xs text-brand-600 hover:underline" @click="clearFlag(item.id, 'description')">{{ i18n.t('admin.task_clear_flag') }}</AppButton>
                </td>
              </tr>
              <tr v-if="flags.length === 0"><td colspan="4" class="py-6 text-center text-muted">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </AppCard>
        <AppPagination v-model="flagPage" :total-pages="flagTotalPages" :busy="loading" />
      </template>

      <!-- 搜索提交 -->
      <template v-else-if="tab === 'search'">
        <AppCard class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted">
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.tasks_search_submissions') }}</th>
                <th class="py-2 pr-3 font-medium">ID</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_status_col') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_attempts') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_last_error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in submissions" :key="i" class="border-b last:border-0">
                <td class="py-2 pr-3 uppercase">{{ s.engine }}</td>
                <td class="py-2 pr-3">{{ s.textureId }}</td>
                <td class="py-2 pr-3">{{ statusLabel(s.status === 'submitted' ? 'submitted' : s.status) }}</td>
                <td class="py-2 pr-3">{{ s.attempts }}</td>
                <td class="py-2 pr-3 max-w-64 truncate" :title="s.lastError">{{ s.lastError || '—' }}</td>
              </tr>
              <tr v-if="submissions.length === 0"><td colspan="5" class="py-6 text-center text-muted">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </AppCard>
        <div class="flex flex-wrap gap-2">
          <AppButton v-for="e in ENGINES" :key="e" class="!px-3 !py-1.5 text-xs" @click="retrySubmissions(e)">{{ i18n.t('admin.task_retry') }} {{ e.toUpperCase() }}</AppButton>
        </div>
        <AppPagination v-model="subPage" :total-pages="subTotalPages" :busy="loading" />
      </template>

      <!-- 定时任务 -->
      <template v-else>
        <AppCard class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted">
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_runs') }}</th>
                <th class="py-2 pr-3 font-medium">{{ statusLabel('done') }}</th>
                <th class="py-2 pr-3 font-medium">{{ i18n.t('admin.task_last_error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id" class="border-b last:border-0">
                <td class="py-2 pr-3">{{ run.name }} · {{ fmtTime(run.ranAt) }}</td>
                <td class="py-2 pr-3">
                  <span :class="run.ok ? 'text-green-600' : 'text-red-600'">{{ run.ok ? '✓' : '✗' }}</span>
                </td>
                <td class="py-2 pr-3 max-w-96 truncate" :title="run.detail">{{ run.detail || '—' }}</td>
              </tr>
              <tr v-if="runs.length === 0"><td colspan="3" class="py-6 text-center text-muted">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </AppCard>
      </template>
    </template>
  </div>
</template>
