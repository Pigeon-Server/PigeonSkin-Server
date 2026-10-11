<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Popover } from '@vuetify/v0';
import DOMPurify from 'dompurify';
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
const kindIcon = (item: NotificationItem) =>
  item.type === 'report_reviewed' ? 'outlined_flag'
    : item.type === 'mojang_takeover' ? 'verified_user'
      : 'campaign';

// 旧站迁移过来的通知 body 是 HTML,列表摘要与详情都不能按纯文本/Markdown 直接处理。
// 与 Markdown 的区别:HTML 内容含标签与实体,Markdown 是普通文本。
const isHtmlBody = (value: string) => /<(?:p|div|br|span|a|b|strong|em|i|ul|ol|li|h[1-6]|blockquote|img)\b/i.test(value);
/** 摘要去掉标签与实体取纯文本;Markdown 原样(本身是纯文本) */
function excerpt(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(line => line.trim()).filter(Boolean).join(' ');
}
/** 详情内容:HTML 通知 sanitize 后保留结构,其余原样 */
const detailKind = computed<'html' | 'text'>(() => (selected.value && isHtmlBody(body(selected.value)) ? 'html' : 'text'));
const sanitizedBody = computed(() => (detailKind.value === 'html' ? DOMPurify.sanitize(body(selected.value!)) : ''));

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
            <span class="flex items-center gap-1.5 min-w-0">
              <AppIcon :name="kindIcon(item)" class="text-muted shrink-0 !text-base" />
              <span class="font-medium text-sm truncate">{{ title(item) }}</span>
              <span v-if="item.readAt === null" class="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 ml-auto" aria-hidden="true" />
            </span>
            <span class="block truncate text-xs text-muted mt-1 break-all">{{ excerpt(body(item)) }}</span>
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
    <div class="notification-detail">
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <AppIcon :name="selected ? kindIcon(selected) : 'campaign'" class="!text-base" />
        {{ i18n.d(selected?.createdAt ?? Date.now()) }}
      </p>
      <!-- 旧站迁移的 HTML 通知:sanitize 后原样渲染(保留其段落/链接结构);
           站内新通知与系统通知是纯文本/Markdown,按 break-words 逐段展示 -->
      <div v-if="selected && detailKind === 'html'" class="prose mt-3" v-html="sanitizedBody" />
      <p v-else-if="selected" class="mt-3 text-sm whitespace-pre-wrap break-words">{{ body(selected) }}</p>
    </div>
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
/* 长 token(API key、链接)不允许把弹窗/摘要撑宽,只能在词内断行 */
.notification-detail {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  /* 旧站 HTML 通知尾部的 <span style="float:right"> 署名不撑高父容器,
     溢出会吃掉弹窗底部 padding,必须清除浮动 */
  display: flow-root;
}
.notification-detail :deep(.prose) {
  overflow-wrap: anywhere;
  word-break: break-word;
}
</style>
