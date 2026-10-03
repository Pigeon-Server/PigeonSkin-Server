<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, type YggLogItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const actions = ['authenticate', 'refresh', 'signout', 'join', 'upload-skin', 'upload-cape'];
const items = ref<YggLogItem[]>([]);
const action = ref('');
const page = ref(1);
const totalPages = ref(1);
const loading = ref(true);
const error = ref('');
const selected = ref<YggLogItem | null>(null);
const detailOpen = ref(false);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await adminApi.yggLogs({ action: action.value, page: page.value });
    items.value = data.items;
    totalPages.value = data.totalPages;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('integration.yggdrasil.logs')">
    <router-link to="/admin/integrations?module=yggdrasil" class="btn">
      <AppIcon name="arrow_back" />
      {{ i18n.t('general.back') }}
    </router-link>
  </PageHeader>
  <AppSelect v-model="action" class="max-w-64 mb-4" :options="[{ value: '', label: i18n.t('common.all') }, ...actions.map(item => ({ value: item, label: i18n.t(`integration.yggdrasil.actions.${item}`) }))]" :aria-label="i18n.t('admin.audit_action')" @change="page = 1; load()" />
  <p v-if="error" class="alert alert-danger" role="alert">
    {{ error }}
    <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
  </p>
  <AppSkeleton v-if="loading" :count="3" />
  <div v-else class="overflow-x-auto rounded-lg border border-line bg-surface">
    <table class="table">
      <thead>
        <tr>
          <th>{{ i18n.t('common.id') }}</th>
          <th>{{ i18n.t('admin.audit_action') }}</th>
          <th>{{ i18n.t('integration.yggdrasil.user_id') }}</th>
          <th>{{ i18n.t('integration.yggdrasil.player_id') }}</th>
          <th>{{ i18n.t('integration.yggdrasil.ip') }}</th>
          <th>{{ i18n.t('admin.audit_time') }}</th>
          <th>{{ i18n.t('admin.audit_detail') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td>{{ i18n.n(item.id) }}</td>
          <td>
            {{ actions.includes(item.action) ? i18n.t(`integration.yggdrasil.actions.${item.action}`) : item.action }}
          </td>
          <td>{{ item.userId === null ? i18n.t('common.none') : i18n.n(item.userId) }}</td>
          <td>{{ item.playerId === null ? i18n.t('common.none') : i18n.n(item.playerId) }}</td>
          <td class="font-mono text-xs">{{ item.ip || i18n.t('common.none') }}</td>
          <td class="whitespace-nowrap">{{ i18n.d(item.createdAt) }}</td>
          <td>
            <AppButton class="btn-sm" @click="selected = item; detailOpen = true">
              {{ i18n.t('integration.yggdrasil.details') }}
            </AppButton>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="7" class="py-6 text-center text-muted">{{ i18n.t('admin.audit_empty') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <AppPagination
    v-model="page"
    :total-pages="totalPages"
    :busy="loading"
    @update:model-value="load"
  />
  <AppDialog v-model="detailOpen" :title="i18n.t('integration.yggdrasil.details')">
    <pre
      class="whitespace-pre-wrap break-all text-xs"
      >{{ selected?.body || i18n.t('common.none') }}</pre
    >
  </AppDialog>
</template>
