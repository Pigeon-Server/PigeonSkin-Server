<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, ApiError, type AuditLogItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';

const i18n = useI18n();

const ACTIONS = [
  'admin.search.submit',
  'admin.user.create',
  'admin.user.update',
  'admin.user.delete',
  'admin.user.revoke_sessions',
  'admin.user.reset_password',
  'admin.player.update',
  'admin.player.delete',
  'admin.texture.delete',
  'admin.texture.update',
  'admin.texture.import',
  'admin.closet.delete',
  'admin.report.resolve',
  'admin.comment.delete',
  'admin.settings.update',
  'admin.broadcast',
  'admin.translation.update',
  'admin.translation.delete',
  'admin.update.deploy',
  'admin.closet.add',
  'admin.pigeon.key.create',
  'admin.pigeon.key.update',
  'admin.vote.create',
  'admin.vote.update',
  'admin.vote.publish',
  'admin.vote.close',
  'admin.vote.cancel',
  'admin.vote.archive',
  'admin.vote.export',
  'admin.live2d.upload',
  'admin.live2d.update',
  'admin.ai_jobs.retry',
  'admin.ai_jobs.cancel',
  'admin.ai_jobs.backfill',
  'admin.texture_flags.clear',
  'admin.search_submissions.retry',
] as const;

const items = ref<AuditLogItem[]>([]);
const total = ref(0);
const totalPages = ref(1);
const page = ref(1);
const action = ref('');
const search = ref('');
const errMsg = ref('');
const loading = ref(true);
let generation = 0;

async function load() {
  const id = ++generation;
  loading.value = true;
  errMsg.value = '';
  try {
    const data = await adminApi.auditLog({
      action: action.value || undefined,
      q: search.value.trim() || undefined,
      page: page.value,
    });
    if (id !== generation) return;
    items.value = data.items;
    total.value = data.total;
    totalPages.value = data.totalPages;
  } catch (error) {
    if (id === generation) errMsg.value = i18n.t(error instanceof ApiError ? error.code : 'common.network');
  } finally { if (id === generation) loading.value = false; }
}

function changeAction() {
  page.value = 1;
  void load();
}

function fmtTime(ts: number): string {
  return i18n.d(ts);
}

function actionLabel(value: string): string {
  return ACTIONS.includes(value as typeof ACTIONS[number])
    ? i18n.t(`admin.action.${value.replace('admin.', '').replaceAll('.', '_')}`)
    : value;
}

onMounted(load);
</script>

<template>
  <div class="page page--dense"><PageHeader :title="i18n.t('admin.audit_log')" />
    <div class="flex flex-wrap items-center gap-2">
      <AppSelect v-model="action" class="max-w-64" :options="[{ value: '', label: i18n.t('admin.audit_all_actions') }, ...ACTIONS.map(a => ({ value: a, label: actionLabel(a) }))]" @change="changeAction" />
      <SearchExpressionField
        v-model="search"
        schema-key="auditLog"
        class="max-w-sm"
        :aria-label="i18n.t('general.search')"
        :placeholder="i18n.t('general.search')"
        @submit="page = 1; load()"
      />
      <span class="text-sm text-muted">{{ i18n.t('common.count', { count: i18n.n(total) }) }}</span>
    </div>
    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>

    <AppSkeleton v-if="loading" :count="3" /><div v-else-if="!errMsg" class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="table">
        <thead>
          <tr>
            <th>{{ i18n.t('admin.audit_time') }}</th>
            <th>{{ i18n.t('admin.audit_actor') }}</th>
            <th>{{ i18n.t('admin.audit_action') }}</th>
            <th>{{ i18n.t('admin.audit_target') }}</th>
            <th>{{ i18n.t('admin.audit_detail') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in items" :key="log.id">
            <td class="whitespace-nowrap text-muted">{{ fmtTime(log.createdAt) }}</td>
            <td class="text-muted">{{ log.actorId === null ? '-' : `#${log.actorId}` }}</td>
            <td>
              <span class="badge badge-default font-mono text-xs">{{ actionLabel(log.action) }}</span>
            </td>
            <td class="text-muted">
              {{ log.targetType ? `${log.targetType}${log.targetId === null ? '' : ` #${log.targetId}`}` : '-' }}
            </td>
            <td class="max-w-md break-all text-muted">{{ log.detail ?? '-' }}</td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="5" class="py-6 text-center text-muted">{{ i18n.t('admin.audit_empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="!errMsg && totalPages > 1" class="pagination">
      <AppButton class="btn btn-sm" :disabled="page <= 1" @click="page--; load()">{{ i18n.t('common.prev') }}</AppButton>
      <span class="px-2 py-1 text-sm text-muted">{{ page }} / {{ totalPages }}</span>
      <AppButton class="btn btn-sm" :disabled="page >= totalPages" @click="page++; load()">{{ i18n.t('common.next') }}</AppButton>
    </div>
  </div>
</template>
