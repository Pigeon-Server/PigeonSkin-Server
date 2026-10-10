<script setup lang="ts">
import { confirmAction } from '@/stores/dialog';
import { onMounted, ref } from 'vue';
import { reportApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
type Row = {
  id: number;
  textureId: number;
  reason: string;
  status: string;
  createdAt: number;
  reviewedAt: number | null;
  reporterId: number;
};
const items = ref<Row[]>([]);
const status = ref<'pending' | 'resolved' | 'rejected'>('pending');
const errMsg = ref('');
const busy = ref<number | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  errMsg.value = '';
  try {
    const data = await reportApi.adminList(status.value);
    items.value = data.items;
  } catch {
    errMsg.value = i18n.t('common.internal_error');
  } finally {
    loading.value = false;
  }
}

async function resolve(id: number, action: 'delete' | 'ban' | 'reject') {
  if (busy.value || !(await confirmAction(i18n.t(`admin.report_confirm.${action}`)))) return;
  busy.value = id;
  errMsg.value = '';
  try {
    await reportApi.resolve(id, action);
    await load();
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="page page--dense">
    <PageHeader :title="i18n.t('general.report-manage')" />
    <div class="flex gap-1">
      <AppButton
        class="btn btn-sm"
        :class="status === 'pending' ? 'btn-primary' : ''"
        @click="status = 'pending'; load()"
      >
        {{ i18n.t('admin.report_pending') }}
      </AppButton>
      <AppButton
        class="btn btn-sm"
        :class="status === 'resolved' ? 'btn-primary' : ''"
        @click="status = 'resolved'; load()"
      >
        {{ i18n.t('admin.report_resolved') }}
      </AppButton>
      <AppButton
        class="btn btn-sm"
        :class="status === 'rejected' ? 'btn-primary' : ''"
        @click="status = 'rejected'; load()"
      >
        {{ i18n.t('admin.report_rejected') }}
      </AppButton>
    </div>

    <p v-if="errMsg" class="alert alert-danger">{{ errMsg }}</p>

    <AppSkeleton v-if="loading" :count="3" />
    <div v-else-if="items.length" class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="table">
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td class="text-muted">#{{ r.id }}</td>
            <td>
              <router-link :to="`/skinlib/${r.textureId}`" class="hover:underline">
                #{{ r.textureId }}
              </router-link>
            </td>
            <td class="max-w-64 whitespace-pre-wrap break-words text-muted" :title="r.reason">
              {{ r.reason }}
            </td>
            <td class="text-muted">{{ i18n.d(r.createdAt, 'short') }}</td>
            <td v-if="status === 'pending'" class="text-right">
              <AppButton
                class="btn btn-sm btn-danger"
                :disabled="busy !== null"
                @click="resolve(r.id, 'delete')"
              >
                {{ i18n.t('admin.report_delete') }}
              </AppButton>
              <AppButton
                class="btn btn-sm btn-danger ml-1"
                :disabled="busy !== null"
                @click="resolve(r.id, 'ban')"
              >
                {{ i18n.t('admin.report_ban') }}
              </AppButton>
              <AppButton
                class="btn btn-sm ml-1"
                :disabled="busy !== null"
                @click="resolve(r.id, 'reject')"
              >
                {{ i18n.t('admin.report_reject') }}
              </AppButton>
            </td>
            <td v-else class="text-right text-muted">
              {{ r.reviewedAt ? i18n.d(r.reviewedAt, 'short') : '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="rounded-xl border border-line bg-surface p-10 text-center text-muted">
      {{ i18n.t('admin.report_empty') }}
    </div>
  </div>
</template>
