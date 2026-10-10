<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi, type TicketCategory, type TicketSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';

const i18n = useI18n();
const router = useRouter();

const items = ref<TicketSummary[]>([]);
const categories = ref<TicketCategory[]>([]);
const status = ref('');
const categoryId = ref('');
const search = ref('');
const page = ref(1);
const totalPages = ref(1);
const total = ref(0);
const unread = ref(0);
const loading = ref(true);
const error = ref('');

function statusBadgeClass(s: string) {
  switch (s) {
    case 'pending':
      return 'badge-warning';
    case 'in_progress':
      return 'badge-info bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300';
    case 'waiting_user':
      return 'badge-warning bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300';
    case 'resolved':
      return 'badge-success';
    case 'closed':
      return 'badge-default opacity-80';
    default:
      return 'badge-default';
  }
}

function statusIcon(s: string) {
  switch (s) {
    case 'pending':
      return 'hourglass_empty';
    case 'in_progress':
      return 'engineering';
    case 'waiting_user':
      return 'mark_chat_unread';
    case 'resolved':
      return 'check_circle';
    case 'closed':
      return 'lock';
    default:
      return 'help_outline';
  }
}

const statusOptions = computed(() => [
  { value: '', label: i18n.t('ticket.all_statuses') },
  { value: 'pending', label: i18n.t('ticket.status.pending') },
  { value: 'in_progress', label: i18n.t('ticket.status.in_progress') },
  { value: 'waiting_user', label: i18n.t('ticket.status.waiting_user') },
  { value: 'resolved', label: i18n.t('ticket.status.resolved') },
  { value: 'closed', label: i18n.t('ticket.status.closed') },
]);

const categoryOptions = computed(() => [
  { value: '', label: i18n.t('ticket.all_categories') },
  ...categories.value.map(c => ({
    value: String(c.id),
    label: c.name + (c.hidden ? ` (${i18n.t('ticket.category_hidden')})` : ''),
  })),
]);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [categoryData, data] = await Promise.all([
      adminApi.ticketCategories(),
      adminApi.tickets({
        page: page.value,
        status: status.value || undefined,
        categoryId: categoryId.value ? Number(categoryId.value) : undefined,
        q: search.value.trim() || undefined,
      }),
    ]);
    categories.value = categoryData.items;
    items.value = data.items;
    page.value = data.page;
    totalPages.value = data.totalPages;
    total.value = data.total;
    unread.value = data.unread;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  status.value = '';
  categoryId.value = '';
  search.value = '';
  page.value = 1;
  void load();
}

watch(page, () => {
  void load();
});

onMounted(load);
</script>

<template>
  <PageHeader :title="i18n.t('ticket.manage')">
    <div class="flex items-center gap-2">
      <span v-if="unread" class="badge badge-warning inline-flex items-center gap-1 font-semibold">
        <AppIcon name="mark_email_unread" class="!text-xs" />
        {{ unread }} {{ i18n.t('ticket.unread') }}
      </span>
      <router-link to="/admin/ticket-categories" class="btn btn-sm">
        <AppIcon name="category" />
        <span>{{ i18n.t('ticket.category_manage') }}</span>
      </router-link>
    </div>
  </PageHeader>

  <AppAlert v-if="error" variant="danger">
    <div class="flex items-center justify-between gap-3">
      <span>{{ error }}</span>
      <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </div>
  </AppAlert>

  <!-- 筛选控制栏 -->
  <section class="panel p-3.5 space-y-3">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div>
        <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
          {{ i18n.t('ticket.status_label') }}
        </label>
        <AppSelect
          v-model="status"
          class="w-full"
          :options="statusOptions"
          @change="page = 1; load()"
        />
      </div>

      <div>
        <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
          {{ i18n.t('ticket.category_label') }}
        </label>
        <AppSelect
          v-model="categoryId"
          class="w-full"
          :options="categoryOptions"
          @change="page = 1; load()"
        />
      </div>

      <div class="sm:col-span-2 lg:col-span-2 flex items-end gap-2">
        <div class="flex-1">
          <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
            {{ i18n.t('general.search') }}
          </label>
          <SearchExpressionField
            v-model="search"
            schema-key="tickets"
            class="w-full"
            :placeholder="i18n.t('general.search')"
            @submit="page = 1; load()"
          />
        </div>
        <AppButton class="btn-primary" @click="page = 1; load()">
          <AppIcon name="search" />
          <span>{{ i18n.t('common.search') }}</span>
        </AppButton>
        <AppButton class="btn-sm" @click="resetFilters">
          {{ i18n.t('skinlib.reset') }}
        </AppButton>
      </div>
    </div>
  </section>

  <!-- 工单列表表格面板 -->
  <section class="panel !p-0 overflow-hidden">
    <header class="flex items-center justify-between border-b border-line px-4 py-3">
      <div class="flex items-center gap-2">
        <AppIcon name="view_list" class="text-brand-600 !text-xl" />
        <h2 class="font-semibold text-sm">{{ i18n.t('ticket.manage') }}</h2>
        <span class="text-xs text-muted">({{ total }})</span>
      </div>
      <AppButton class="btn-sm" :loading="loading" @click="load">
        <AppIcon name="refresh" />
      </AppButton>
    </header>

    <div class="overflow-x-auto">
      <table class="table w-full">
        <thead>
          <tr>
            <th class="w-28">{{ i18n.t('ticket.number') }}</th>
            <th>{{ i18n.t('ticket.subject') }}</th>
            <th class="w-32">{{ i18n.t('ticket.category_label') }}</th>
            <th class="w-40">{{ i18n.t('ticket.user') }}</th>
            <th class="w-32">{{ i18n.t('ticket.status_label') }}</th>
            <th class="w-36 text-right">{{ i18n.t('ticket.updated') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            class="cursor-pointer hover:bg-surface-2/60 transition-colors"
            @click="router.push(`/admin/tickets/${item.id}`)"
          >
            <td class="font-mono text-xs font-semibold whitespace-nowrap">
              <div class="flex items-center gap-1.5">
                <span>{{ item.ticketNumber }}</span>
                <span v-if="item.adminUnread" class="badge badge-warning text-[10px] py-0 px-1">
                  {{ i18n.t('ticket.unread') }}
                </span>
              </div>
            </td>
            <td>
              <p class="font-semibold text-foreground line-clamp-1 hover:text-brand-600 transition-colors">
                {{ item.title }}
              </p>
            </td>
            <td class="text-xs text-muted">
              {{ item.categoryName }}
            </td>
            <td class="text-xs">
              <div class="truncate font-medium text-foreground">
                {{ item.userNickname || item.userEmail }}
              </div>
              <div v-if="item.userNickname && item.userEmail" class="truncate text-[11px] text-muted">
                {{ item.userEmail }}
              </div>
            </td>
            <td>
              <span class="badge inline-flex items-center gap-1 text-xs" :class="statusBadgeClass(item.status)">
                <AppIcon :name="statusIcon(item.status)" class="!text-xs" />
                {{ i18n.t(`ticket.status.${item.status}`) }}
              </span>
            </td>
            <td class="text-right text-xs text-muted font-mono whitespace-nowrap">
              {{ i18n.d(item.updatedAt, 'short') }}
            </td>
          </tr>
          <tr v-if="!loading && !items.length">
            <td colspan="6" class="p-8">
              <EmptyState :title="i18n.t('ticket.empty')" class="py-6" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppSkeleton v-if="loading && !items.length" class="p-4" :count="4" />

    <footer v-if="totalPages > 1" class="border-t border-line p-3 flex justify-center">
      <AppPagination v-model="page" :total-pages="totalPages" />
    </footer>
  </section>
</template>
