<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Popover } from '@vuetify/v0';
import { notificationApi, type NotificationItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const open = ref(false);
const selected = ref<NotificationItem | null>(null);
const detailOpen = ref(false);
const items = ref<NotificationItem[]>([]);
const unread = ref(0);
const error = ref('');
const busy = ref(false);
const loading = ref(true);
let timer: number | undefined;
const title = (item: NotificationItem) =>
  item.type === 'report_reviewed' || item.type === 'mojang_takeover' || i18n.te(item.title)
    ? i18n.t(item.title)
    : item.title;
const body = (item: NotificationItem) =>
  item.type === 'report_reviewed'
    ? i18n.t('notif.report_texture', { id: Number(item.body?.replace('texture:', '')) || 0 })
    : item.type === 'mojang_takeover'
      ? i18n.t('mojang_takeover.content', { player: item.body || '' })
      : item.body || '';
async function refresh() {
  try {
    const data = await notificationApi.list();
    items.value = data.items;
    unread.value = data.unread;
    error.value = '';
  } catch (e) {
    if (open.value) error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function markAll() {
  busy.value = true;
  try {
    await notificationApi.markAllRead();
    await refresh();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function show(item: NotificationItem) {
  selected.value = item;
  detailOpen.value = true;
  open.value = false;
  if (item.readAt === null) {
    try {
      await notificationApi.markRead(item.id);
      await refresh();
    } catch (e) {
      error.value = apiErrorMessage(e);
    }
  }
}
onMounted(() => {
  void refresh();
  timer = window.setInterval(refresh, 60000);
});
onUnmounted(() => window.clearInterval(timer));
</script>
<template>
  <Popover.Root v-model="open" position-area="bottom span-left">
    <Popover.Activator
      class="btn btn-icon relative"
      :aria-label="i18n.t('notif.title')"
      @click="refresh"
    >
      <AppIcon name="notifications_none" />
      <span
        v-if="unread"
        class="absolute top-0 right-0 bg-danger text-white text-[9px] rounded px-1"
      >
        {{ unread > 99 ? i18n.t('notif.many') : i18n.n(unread) }}
      </span>
    </Popover.Activator>
    <Popover.Content class="notification-popover">
      <header class="flex items-center justify-between border-b border-line p-3">
        <h2 class="text-sm font-semibold">{{ i18n.t('notif.title') }}</h2>
        <AppButton v-if="unread" class="btn-sm" :loading="busy" @click="markAll">
          {{ i18n.t('notif.read_all') }}
        </AppButton>
      </header>
      <p v-if="error" class="text-xs text-danger p-3" role="alert">{{ error }}</p>
      <p v-if="loading" class="p-6 text-muted text-xs">{{ i18n.t('common.loading') }}</p>
      <ul v-else class="max-h-96 overflow-auto">
        <li v-for="item in items" :key="item.id" class="border-b border-line last:border-0">
          <AppButton
            class="!rounded-none !border-0 !block !text-left !p-3 w-full !font-normal"
            :class="item.readAt === null ? '!bg-brand-50 dark:!bg-brand-900' : ''"
            @click="show(item)"
          >
            <span class="block font-medium text-sm">{{ title(item) }}</span>
            <span class="block truncate text-xs text-muted mt-1">{{ body(item) }}</span>
            <span class="block text-[10px] text-muted mt-1">{{ i18n.d(item.createdAt) }}</span>
          </AppButton>
        </li>
        <li v-if="!items.length" class="p-6 text-muted text-center text-xs">
          {{ i18n.t('notif.empty') }}
        </li>
      </ul>
    </Popover.Content>
  </Popover.Root>
  <AppDialog v-model="detailOpen" :title="selected ? title(selected) : ''">
    <MarkdownContent v-if="selected" :content="body(selected)" />
    <p v-if="selected" class="text-xs text-muted mt-4">{{ i18n.d(selected.createdAt) }}</p>
  </AppDialog>
</template>
<style scoped>
.notification-popover {
  width: min(340px, calc(100vw - 24px));
  border: 1px solid var(--v0-border);
  border-radius: 7px;
  background: var(--v0-surface);
  color: var(--ink);
  padding: 0;
  box-shadow: 0 8px 30px #26313f26;
  margin: 8px 0 0;
}
</style>
