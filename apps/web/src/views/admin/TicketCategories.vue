<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, type TicketCategory } from '@/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useI18n } from '@/stores/i18n';
import { promptValue } from '@/stores/dialog';

const i18n = useI18n();

const items = ref<TicketCategory[]>([]);
const name = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const loading = ref(true);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = (await adminApi.ticketCategories()).items;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (!name.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await adminApi.createTicketCategory(name.value.trim());
    name.value = '';
    notice.value = i18n.t('general.op-success');
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function toggle(item: TicketCategory) {
  error.value = '';
  try {
    await adminApi.updateTicketCategory(item.id, { hidden: !item.hidden });
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

async function rename(item: TicketCategory) {
  const value = await promptValue(i18n.t('ticket.category_name'), item.name);
  if (value === null || !value.trim() || value.trim() === item.name) return;
  error.value = '';
  try {
    await adminApi.updateTicketCategory(item.id, { name: value.trim() });
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

async function move(index: number, direction: 'up' | 'down') {
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.value.length) return;
  const current = items.value[index]!;
  const target = items.value[targetIndex]!;

  const newOrder = target.sortOrder;
  const oldOrder = current.sortOrder;

  try {
    await Promise.all([
      adminApi.updateTicketCategory(current.id, { sortOrder: newOrder }),
      adminApi.updateTicketCategory(target.id, { sortOrder: oldOrder }),
    ]);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

onMounted(load);
</script>

<template>
  <PageHeader :title="i18n.t('ticket.category_manage')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/admin/tickets" class="page-back">
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('ticket.back_to_list') }}</span>
        </router-link>
      </nav>
    </template>
    <AppButton class="btn-sm" :loading="loading" @click="load">
      <AppIcon name="refresh" />
    </AppButton>
  </PageHeader>

  <AppAlert v-if="notice" variant="success">
    <div class="flex items-center justify-between gap-3">
      <span>{{ notice }}</span>
      <button type="button" class="opacity-70 hover:opacity-100" @click="notice = ''">
        <AppIcon name="close" class="!text-base" />
      </button>
    </div>
  </AppAlert>

  <AppAlert v-if="error" variant="danger">
    <div class="flex items-center justify-between gap-3">
      <span>{{ error }}</span>
      <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </div>
  </AppAlert>

  <!-- 创建新分类卡片 -->
  <section class="panel p-4">
    <h2 class="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
      {{ i18n.t('ticket.category_add') }}
    </h2>
    <div class="flex flex-wrap sm:flex-nowrap gap-2">
      <AppInput
        v-model="name"
        class="flex-1"
        maxlength="80"
        :placeholder="i18n.t('ticket.category_name')"
        @keyup.enter="add"
      />
      <AppButton
        class="btn-primary"
        :disabled="!name.trim()"
        :loading="busy"
        @click="add"
      >
        <AppIcon name="add" />
        <span>{{ i18n.t('ticket.category_add') }}</span>
      </AppButton>
    </div>
  </section>

  <!-- 分类列表面板 -->
  <section class="panel !p-0 overflow-hidden">
    <header class="flex items-center justify-between border-b border-line px-4 py-3">
      <div class="flex items-center gap-2">
        <AppIcon name="category" class="text-brand-600 !text-xl" />
        <h2 class="font-semibold text-sm">{{ i18n.t('ticket.category_manage') }}</h2>
        <span class="text-xs text-muted">({{ items.length }})</span>
      </div>
    </header>

    <div class="overflow-x-auto">
      <table class="table w-full">
        <thead>
          <tr>
            <th class="w-16 text-center">{{ i18n.t('ticket.category_sort') }}</th>
            <th>{{ i18n.t('ticket.category_name') }}</th>
            <th class="w-32">{{ i18n.t('ticket.category_state') }}</th>
            <th class="w-48 text-right">{{ i18n.t('user.player.operation') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in items" :key="item.id" class="hover:bg-surface-2/60 transition-colors">
            <td class="text-center font-mono text-xs text-muted">
              <div class="flex items-center justify-center gap-1">
                <button
                  type="button"
                  class="btn-icon p-1 text-muted hover:text-foreground disabled:opacity-30"
                  :disabled="index === 0"
                  :title="i18n.t('ticket.move_up')"
                  @click="move(index, 'up')"
                >
                  <AppIcon name="keyboard_arrow_up" class="!text-sm" />
                </button>
                <button
                  type="button"
                  class="btn-icon p-1 text-muted hover:text-foreground disabled:opacity-30"
                  :disabled="index === items.length - 1"
                  :title="i18n.t('ticket.move_down')"
                  @click="move(index, 'down')"
                >
                  <AppIcon name="keyboard_arrow_down" class="!text-sm" />
                </button>
              </div>
            </td>
            <td class="font-medium text-foreground">
              <div class="flex items-center gap-2">
                <span>{{ item.name }}</span>
                <span class="font-mono text-[11px] text-muted">#{{ item.id }}</span>
              </div>
            </td>
            <td>
              <span
                class="badge inline-flex items-center gap-1 text-xs"
                :class="item.hidden ? 'badge-default opacity-80' : 'badge-success'"
              >
                <AppIcon :name="item.hidden ? 'visibility_off' : 'visibility'" class="!text-xs" />
                {{ item.hidden ? i18n.t('ticket.category_hidden') : i18n.t('ticket.category_visible') }}
              </span>
            </td>
            <td class="text-right whitespace-nowrap">
              <AppButton class="btn-sm" @click="rename(item)">
                <AppIcon name="edit" />
                <span>{{ i18n.t('common.edit') }}</span>
              </AppButton>
              <AppButton
                class="btn-sm ml-2"
                :class="item.hidden ? 'btn-secondary' : 'btn-danger'"
                @click="toggle(item)"
              >
                <AppIcon :name="item.hidden ? 'restore' : 'hide_source'" />
                <span>{{ item.hidden ? i18n.t('ticket.category_restore') : i18n.t('ticket.category_hide') }}</span>
              </AppButton>
            </td>
          </tr>
          <tr v-if="!loading && !items.length">
            <td colspan="4" class="p-8">
              <EmptyState :title="i18n.t('ticket.empty')" class="py-6" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppSkeleton v-if="loading && !items.length" class="p-4" :count="3" />
  </section>
</template>
