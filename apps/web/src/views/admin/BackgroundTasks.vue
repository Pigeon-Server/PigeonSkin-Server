<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { adminApi, type AiJobItem, type SearchSubmissionRecord, type TaskRunItem, type TextureFlagItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';

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

// 当前页签是否已有数据：切回加载过的页签时保留原表格，只有首次进入该页签才用骨架屏占位
const tabHasData = computed(() =>
  tab.value === 'ai'
    ? jobs.value.length > 0
    : tab.value === 'flags'
      ? flags.value.length > 0
      : tab.value === 'search'
        ? submissions.value.length > 0
        : runs.value.length > 0,
);

const JOB_KINDS = ['translate_texture', 'moderate_texture_name', 'moderate_texture_description', 'translate_notification'] as const;
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

const backfilling = ref(false);

async function backfillJobs() {
  if (backfilling.value) return;
  if (!(await confirmAction(i18n.t('admin.task_backfill_confirm')))) return;
  backfilling.value = true;
  try {
    const { results } = await adminApi.backfillAiJobs();
    notice.value = results.length === 0
      ? i18n.t('admin.task_backfill_empty')
      : i18n.t('admin.task_backfill_done', {
          detail: results.map((r) => `${jobKindLabel(r.kind)} +${r.queued}`).join(', '),
        });
    await loadJobs();
  } catch { errMsg.value = i18n.t('common.internal_error'); }
  finally { backfilling.value = false; }
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

    <div class="filter-tabs" role="group" :aria-label="i18n.t('admin.tasks_title')">
      <AppButton
        v-for="t in (['ai', 'flags', 'search', 'runs'] as const)"
        :key="t"
        :aria-pressed="tab === t"
        :class="{ selected: tab === t }"
        @click="switchTab(t)"
      >
        {{ i18n.t(t === 'ai' ? 'admin.tasks_ai_jobs' : t === 'flags' ? 'admin.task_flagged_content' : t === 'search' ? 'admin.tasks_search_submissions' : 'admin.task_runs') }}
      </AppButton>
    </div>

    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>

    <AppSkeleton v-if="loading && !tabHasData" variant="table" :columns="7" :count="8" />

    <template v-else>
      <!-- AI 任务队列 -->
      <template v-if="tab === 'ai'">
        <div class="flex flex-wrap items-center gap-2">
          <AppSelect v-model="jobKind" class="max-w-48" :options="[{ value: '', label: i18n.t('admin.task_all_types') }, ...JOB_KINDS.map(k => ({ value: k, label: jobKindLabel(k) }))]" @change="() => { jobPage = 1; void loadJobs(); }" />
          <AppSelect v-model="jobStatus" class="max-w-40" :options="[{ value: '', label: i18n.t('admin.task_all_statuses') }, ...JOB_STATUSES.map(s => ({ value: s, label: statusLabel(s) }))]" @change="() => { jobPage = 1; void loadJobs(); }" />
          <AppButton class="btn-sm ml-auto" :disabled="backfilling" @click="backfillJobs">{{ i18n.t('admin.task_backfill') }}</AppButton>
        </div>
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{{ i18n.t('admin.tasks_ai_jobs') }}</th>
                <th>{{ i18n.t('skinlib.show.uploader') }}</th>
                <th>{{ i18n.t('admin.task_status_col') }}</th>
                <th>{{ i18n.t('admin.task_attempts') }}</th>
                <th>{{ i18n.t('admin.task_last_error') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id">
                <td class="text-muted">{{ job.id }}</td>
                <td>{{ jobKindLabel(job.kind) }}</td>
                <td>
                  <RouterLink v-if="job.texture" :to="`/skinlib/${job.texture.id}`" class="hover:underline">{{ job.texture.name }}</RouterLink>
                  <span v-else class="text-muted">#{{ job.tid }}</span>
                </td>
                <td>{{ statusLabel(job.status) }}</td>
                <td>{{ job.attempts }}</td>
                <td class="max-w-64 truncate" :title="job.lastError">{{ job.lastError || '—' }}</td>
                <td class="whitespace-nowrap text-right">
                  <AppButton v-if="job.status === 'failed' || job.status === 'pending' || job.status === 'done'" class="btn-sm" @click="retryJob(job.id)">{{ i18n.t('admin.task_retry') }}</AppButton>
                  <AppButton v-if="job.status === 'pending'" class="btn-sm ml-1" @click="cancelJob(job.id)">{{ i18n.t('admin.task_cancel') }}</AppButton>
                </td>
              </tr>
              <tr v-if="jobs.length === 0"><td colspan="7" class="text-center text-muted py-6">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </div>
        <AppPagination v-model="jobPage" :total-pages="jobTotalPages" :busy="loading" />
      </template>

      <!-- 审核标记 -->
      <template v-else-if="tab === 'flags'">
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{{ i18n.t('skinlib.show.name') }}</th>
                <th>{{ i18n.t('admin.tasks_ai_jobs') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in flags" :key="item.id">
                <td>
                  <RouterLink :to="`/skinlib/${item.id}`" class="hover:underline">{{ item.id }}</RouterLink>
                </td>
                <td>{{ item.name }}</td>
                <td class="space-x-2">
                  <span v-if="item.nameFlagged" class="badge badge-danger">{{ i18n.t('admin.job_moderate_texture_name') }}: {{ item.nameFlagReason }}</span>
                  <span v-if="item.descriptionFlagged" class="badge badge-danger">{{ i18n.t('admin.job_moderate_texture_description') }}: {{ item.descriptionFlagReason }}</span>
                </td>
                <td class="whitespace-nowrap text-right">
                  <AppButton v-if="item.nameFlagged" class="btn-sm" @click="clearFlag(item.id, 'name')">{{ i18n.t('admin.task_clear_flag') }}</AppButton>
                  <AppButton v-if="item.descriptionFlagged" class="btn-sm ml-1" @click="clearFlag(item.id, 'description')">{{ i18n.t('admin.task_clear_flag') }}</AppButton>
                </td>
              </tr>
              <tr v-if="flags.length === 0"><td colspan="4" class="text-center text-muted py-6">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </div>
        <AppPagination v-model="flagPage" :total-pages="flagTotalPages" :busy="loading" />
      </template>

      <!-- 搜索提交 -->
      <template v-else-if="tab === 'search'">
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="table">
            <thead>
              <tr>
                <th>{{ i18n.t('admin.tasks_search_submissions') }}</th>
                <th>ID</th>
                <th>{{ i18n.t('admin.task_status_col') }}</th>
                <th>{{ i18n.t('admin.task_attempts') }}</th>
                <th>{{ i18n.t('admin.task_last_error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in submissions" :key="i">
                <td class="uppercase font-mono text-xs">{{ s.engine }}</td>
                <td class="text-muted">{{ s.textureId }}</td>
                <td>{{ statusLabel(s.status === 'submitted' ? 'submitted' : s.status) }}</td>
                <td>{{ s.attempts }}</td>
                <td class="max-w-64 truncate" :title="s.lastError">{{ s.lastError || '—' }}</td>
              </tr>
              <tr v-if="submissions.length === 0"><td colspan="5" class="text-center text-muted py-6">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap gap-2">
          <AppButton v-for="e in ENGINES" :key="e" class="btn-sm" @click="retrySubmissions(e)">{{ i18n.t('admin.task_retry') }} {{ e.toUpperCase() }}</AppButton>
        </div>
        <AppPagination v-model="subPage" :total-pages="subTotalPages" :busy="loading" />
      </template>

      <!-- 定时任务 -->
      <template v-else>
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="table">
            <thead>
              <tr>
                <th>{{ i18n.t('admin.task_runs') }}</th>
                <th>{{ statusLabel('done') }}</th>
                <th>{{ i18n.t('admin.task_last_error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id">
                <td class="whitespace-nowrap">{{ run.name }} · {{ fmtTime(run.ranAt) }}</td>
                <td>
                  <span class="badge" :class="run.ok ? 'badge-success' : 'badge-danger'">{{ run.ok ? i18n.t('admin.status_done') : i18n.t('admin.status_failed') }}</span>
                </td>
                <td class="max-w-96 truncate" :title="run.detail">{{ run.detail || '—' }}</td>
              </tr>
              <tr v-if="runs.length === 0"><td colspan="3" class="text-center text-muted py-6">{{ i18n.t('common.none') }}</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
