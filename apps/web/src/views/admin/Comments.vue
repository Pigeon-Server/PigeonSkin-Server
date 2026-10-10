<script setup lang="ts">
import { confirmAction } from '@/stores/dialog';
import { onMounted, ref } from 'vue';
import { adminApi, type CommentItem } from '@/api';
import { useI18n } from '@/stores/i18n';

const i18n = useI18n();

const items = ref<CommentItem[]>([]);
const total = ref(0);
const totalPages = ref(1);
const page = ref(1);
const status = ref<'' | 'pending' | 'rejected' | 'published' | 'deleted'>('');
const errMsg = ref('');
const loading = ref(true);
const notice = ref('');

async function load() {
  loading.value = true;
  errMsg.value = '';
  errMsg.value = '';
  try {
    const data = await adminApi.comments(status.value, page.value);
    items.value = data.items;
    total.value = data.total;
    totalPages.value = data.totalPages;
  } catch {
    errMsg.value = i18n.t('common.internal_error');
  } finally { loading.value = false; }
}

function changeStatus() {
  page.value = 1;
  void load();
}

async function remove(id: number) {
  if (!await confirmAction(i18n.t('comments.delete_confirm'))) return;
  try {
    await adminApi.deleteComment(id);
    notice.value = i18n.t('comments.deleted');
    await load();
  } catch (e) {
    notice.value = '';
    errMsg.value = e instanceof Error && e.message ? i18n.t('common.internal_error') : i18n.t('common.network');
  }
}

function fmtTime(ts: number): string {
  return i18n.d(ts);
}

onMounted(load);
</script>

<template>
  <div class="page page--dense"><PageHeader :title="i18n.t('admin.comments_title')" />
    <div class="flex flex-wrap items-center gap-2">
      <AppSelect v-model="status" class="max-w-48" :options="[{ value: '', label: i18n.t('admin.comment_all_status') }, ...['published', 'pending', 'rejected', 'deleted'].map(value => ({ value, label: i18n.t(`comments.status_${value}`) }))]" @change="changeStatus" />
      <span class="text-sm text-muted">{{ i18n.t('common.count', { count: i18n.n(total) }) }}</span>
    </div>
    <p v-if="notice" class="alert alert-success">{{ notice }}</p>
    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>

    <AppSkeleton v-if="loading" :count="3" /><div v-else class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="table">
        <thead>
          <tr>
            <th>{{ i18n.t('common.id') }}</th>
            <th>{{ i18n.t('admin.comment_content') }}</th>
            <th>{{ i18n.t('admin.comment_user') }}</th>
            <th>{{ i18n.t('admin.comment_texture') }}</th>
            <th>{{ i18n.t('admin.comment_status') }}</th>
            <th>{{ i18n.t('admin.comment_ai_flag') }}</th>
            <th class="text-right">{{ i18n.t('common.delete') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in items" :key="c.id">
            <td class="text-muted">#{{ c.id }}</td>
            <td class="max-w-md break-all">
              {{ c.content }}
              <span class="block text-xs text-muted">{{ fmtTime(c.createdAt) }}</span>
            </td>
            <td class="whitespace-nowrap">
              {{ c.userName }}
              <span class="block text-xs text-muted">#{{ c.userId }}</span>
            </td>
            <td>
              <router-link
                v-if="c.textureId"
                :to="`/skinlib/${c.textureId}`"
                class="text-brand-600 hover:underline dark:text-brand-300"
              >
                #{{ c.textureId }}
              </router-link>
              <span v-else>-</span>
            </td>
            <td>
              <span class="badge" :class="c.status === 'deleted' ? 'badge-danger' : 'badge-success'">
                {{ i18n.t(c.status === 'deleted' ? 'comments.status_deleted' : 'comments.status_published') }}
              </span>
            </td>
            <td>
              <span v-if="c.aiFlagged" class="badge badge-danger">{{ i18n.t('comments.ai_flagged') }}</span>
              <span v-else class="text-muted">-</span>
            </td>
            <td class="text-right">
              <AppButton
                v-if="c.status !== 'deleted'"
                class="btn btn-sm btn-danger"
                @click="remove(c.id)"
              >
                {{ i18n.t('common.delete') }}
              </AppButton>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="7" class="py-6 text-center text-muted">{{ i18n.t('admin.comment_empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <AppButton class="btn btn-sm" :disabled="page <= 1" @click="page--; load()">{{ i18n.t('common.prev') }}</AppButton>
      <span class="px-2 py-1 text-sm text-muted">{{ page }} / {{ totalPages }}</span>
      <AppButton class="btn btn-sm" :disabled="page >= totalPages" @click="page++; load()">{{ i18n.t('common.next') }}</AppButton>
    </div>
  </div>
</template>
