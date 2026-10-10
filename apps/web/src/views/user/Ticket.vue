<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ticketApi, type TicketDetail } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import UserAvatar from '@/components/UserAvatar.vue';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const i18n = useI18n();
const session = useSessionStore();

const data = ref<TicketDetail | null>(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const body = ref('');
const files = ref<File[]>([]);
const busy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeClass(status: string) {
  switch (status) {
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

function statusIcon(status: string) {
  switch (status) {
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

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

// 将消息和事件按时间统一排序展示
const timelineItems = computed(() => {
  if (!data.value) return [];
  const msgs = (data.value.messages || []).map(m => ({
    kind: 'message' as const,
    id: `msg-${m.id}`,
    time: m.createdAt,
    data: m,
  }));
  const evts = (data.value.events || []).map(e => ({
    kind: 'event' as const,
    id: `evt-${e.id}`,
    time: e.createdAt,
    data: e,
  }));
  return [...msgs, ...evts].sort((a, b) => a.time - b.time);
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await ticketApi.get(Number(route.params.id));
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files) return;
  const newFiles = Array.from(target.files);
  const combined = [...files.value, ...newFiles];
  if (combined.length > 5) {
    error.value = '最多上传 5 个附件';
    return;
  }
  files.value = combined;
  if (fileInput.value) fileInput.value.value = '';
}

function removeFile(index: number) {
  files.value.splice(index, 1);
}

async function reply() {
  if ((!body.value.trim() && !files.value.length) || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await ticketApi.reply(Number(route.params.id), body.value.trim(), files.value);
    body.value = '';
    files.value = [];
    notice.value = i18n.t('ticket.reply');
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <PageHeader :title="data?.ticket.ticketNumber || i18n.t('ticket.title')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/tickets" class="page-back">
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('ticket.back_to_list') }}</span>
        </router-link>
      </nav>
    </template>
    <div v-if="data" class="flex flex-wrap items-center gap-2">
      <span class="badge badge-default">
        {{ data.ticket.categoryName }}
      </span>
      <span class="badge inline-flex items-center gap-1 font-semibold" :class="statusBadgeClass(data.ticket.status)">
        <AppIcon :name="statusIcon(data.ticket.status)" class="!text-xs" />
        {{ i18n.t(`ticket.status.${data.ticket.status}`) }}
      </span>
    </div>
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

  <AppSkeleton v-if="loading && !data" :count="4" />

  <div v-if="data" class="space-y-6">
    <!-- 工单标题与基础概要卡片 -->
    <section class="panel p-4 sm:p-5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 class="text-base sm:text-lg font-bold text-foreground">
            {{ data.ticket.title }}
          </h2>
          <div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span class="font-mono">{{ data.ticket.ticketNumber }}</span>
            <span>·</span>
            <span>{{ data.ticket.categoryName }}</span>
            <span>·</span>
            <span>{{ i18n.d(data.ticket.createdAt) }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 消息对话与事件流 (Timeline) -->
    <section class="space-y-4">
      <div v-for="item in timelineItems" :key="item.id">
        <!-- 系统流转事件 -->
        <div v-if="item.kind === 'event'" class="flex items-center justify-center my-3">
          <div class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted border border-line">
            <AppIcon name="timeline" class="!text-xs" />
            <span v-if="item.data.type === 'created'">
              {{ i18n.t('ticket.event_created') }}
            </span>
            <span v-else-if="item.data.type === 'status_changed' && item.data.toStatus">
              {{ i18n.t('ticket.event_status_changed', { status: i18n.t(`ticket.status.${item.data.toStatus}`) }) }}
            </span>
            <span v-else>
              {{ item.data.detail || item.data.type }}
            </span>
            <span class="font-mono text-[11px] opacity-70">
              ({{ i18n.d(item.time, 'short') }})
            </span>
          </div>
        </div>

        <!-- 消息气泡 -->
        <article
          v-else
          class="flex gap-3 max-w-3xl"
          :class="item.data.authorType === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'"
        >
          <!-- 头像 -->
          <div class="shrink-0 mt-0.5">
            <UserAvatar
              v-if="item.data.authorType === 'user'"
              :texture-id="session.user.value?.avatarTextureId || null"
              :user-id="session.user.value?.id || null"
              :name="session.user.value?.nickname || ''"
              class="h-9 w-9 rounded-full border border-line bg-surface-2 object-contain"
            />
            <div
              v-else
              class="h-9 w-9 rounded-full bg-brand-600 text-white flex items-center justify-center shadow-sm"
            >
              <AppIcon name="support_agent" class="!text-lg" />
            </div>
          </div>

          <!-- 气泡内容 -->
          <div class="min-w-0 max-w-[85%] space-y-1">
            <div
              class="flex items-center gap-2 text-xs text-muted"
              :class="item.data.authorType === 'user' ? 'justify-end' : 'justify-start'"
            >
              <span class="font-semibold text-foreground">
                {{ item.data.authorType === 'user' ? i18n.t('ticket.you') : (item.data.authorName || i18n.t('ticket.support')) }}
              </span>
              <span
                v-if="item.data.authorType === 'admin'"
                class="badge badge-primary text-[10px] py-0 px-1"
              >
                {{ i18n.t('ticket.admin') }}
              </span>
              <span class="font-mono text-[11px]">{{ i18n.d(item.data.createdAt, 'short') }}</span>
            </div>

            <div
              class="rounded-2xl p-4 shadow-sm border"
              :class="item.data.authorType === 'user'
                ? 'bg-brand-50 text-foreground border-brand-200 dark:bg-brand-950/40 dark:border-brand-800/50 rounded-tr-sm'
                : 'bg-surface text-foreground border-line rounded-tl-sm'"
            >
              <p class="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {{ item.data.body }}
              </p>

              <!-- 该条消息下的附件列表 -->
              <div
                v-if="data.attachments.filter(a => a.messageId === item.data.id).length"
                class="mt-3 pt-2.5 border-t border-line/60 space-y-2"
              >
                <div
                  v-for="file in data.attachments.filter(a => a.messageId === item.data.id)"
                  :key="file.id"
                  class="flex items-center justify-between gap-3 rounded-lg bg-surface-2/80 p-2 text-xs border border-line"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <AppIcon
                      :name="isImage(file.mimeType) ? 'image' : 'description'"
                      class="text-brand-600 !text-base shrink-0"
                    />
                    <span class="font-medium truncate">{{ file.fileName }}</span>
                    <span class="text-muted font-mono text-[11px] shrink-0">({{ formatBytes(file.sizeBytes) }})</span>
                  </div>
                  <a
                    :href="ticketApi.attachmentUrl(data.ticket.id, file.id)"
                    target="_blank"
                    class="btn btn-sm btn-icon text-muted hover:text-brand-600 shrink-0"
                    :download="file.fileName"
                  >
                    <AppIcon name="download" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- 回复工单卡片 -->
    <section class="panel !p-0 overflow-hidden">
      <header class="border-b border-line px-4 py-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <AppIcon name="reply" class="text-brand-600 !text-xl" />
          <h3 class="font-semibold text-sm">{{ i18n.t('ticket.reply') }}</h3>
        </div>
        <span v-if="data.ticket.status === 'closed'" class="text-xs text-muted">
          {{ i18n.t('ticket.closed_notice') }}
        </span>
      </header>

      <div class="p-4 sm:p-5 space-y-3">
        <AppInput
          v-model="body"
          multiline
          class="w-full min-h-28"
          :placeholder="i18n.t('ticket.reply_placeholder')"
          maxlength="20000"
        />

        <!-- 附件选择 -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted">
              {{ i18n.t('ticket.file_limit_hint') }}
            </span>
            <button
              type="button"
              class="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 font-medium"
              @click="fileInput?.click()"
            >
              <AppIcon name="attach_file" class="!text-sm" />
              <span>{{ i18n.t('ticket.attach_files') }}</span>
              <span v-if="files.length">({{ files.length }}/5)</span>
            </button>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden"
              accept="image/*,.pdf,.txt,.csv,.zip"
              @change="onFileChange"
            />
          </div>

          <div v-if="files.length" class="flex flex-wrap gap-2 pt-1">
            <div
              v-for="(file, idx) in files"
              :key="idx"
              class="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs border border-line"
            >
              <AppIcon name="attach_file" class="!text-xs text-muted" />
              <span class="max-w-[140px] truncate font-medium">{{ file.name }}</span>
              <span class="text-muted text-[10px]">({{ formatBytes(file.size) }})</span>
              <button
                type="button"
                class="text-muted hover:text-danger ml-0.5"
                @click="removeFile(idx)"
              >
                <AppIcon name="close" class="!text-xs" />
              </button>
            </div>
          </div>
        </div>

        <div class="pt-2 flex justify-end">
          <AppButton
            class="btn-primary"
            :disabled="!body.trim() && !files.length"
            :loading="busy"
            @click="reply"
          >
            <AppIcon name="send" />
            <span>{{ i18n.t('ticket.reply') }}</span>
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>
