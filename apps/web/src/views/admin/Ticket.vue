<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { adminApi, type TicketDetail, type TicketStatus } from '@/api';
import { useI18n } from '@/stores/i18n';
import UserAvatar from '@/components/UserAvatar.vue';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const i18n = useI18n();

const data = ref<TicketDetail | null>(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const body = ref('');
const internal = ref(false);
const files = ref<File[]>([]);
const busy = ref(false);
const statusBusy = ref(false);
const status = ref<TicketStatus>('pending');
const fileInput = ref<HTMLInputElement | null>(null);

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
      return 'task_alt';
    case 'closed':
      return 'lock';
    default:
      return 'help_outline';
  }
}

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

const statusOptions = computed(() => [
  { value: 'pending', label: i18n.t('ticket.status.pending') },
  { value: 'in_progress', label: i18n.t('ticket.status.in_progress') },
  { value: 'waiting_user', label: i18n.t('ticket.status.waiting_user') },
  { value: 'resolved', label: i18n.t('ticket.status.resolved') },
  { value: 'closed', label: i18n.t('ticket.status.closed') },
]);

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
    data.value = await adminApi.ticket(Number(route.params.id));
    status.value = data.value.ticket.status;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

// 与后端 services/tickets.ts 的 MAX_FILE_BYTES 保持一致；前端拦截避免整包上传后才被 422
const TICKET_FILE_MAX_BYTES = 5 * 1024 * 1024;
const TICKET_MAX_FILES = 5;

// 图片附件的本地预览 URL：files 变化时重建并释放旧的，避免 objectURL 泄漏
const filePreviewUrls = ref<Array<string | null>>([]);

watch(files, value => {
  for (const url of filePreviewUrls.value) if (url) URL.revokeObjectURL(url);
  filePreviewUrls.value = value.map(file => isImage(file.type) ? URL.createObjectURL(file) : null);
}, { deep: true });

function addFiles(newFiles: File[]) {
  if (newFiles.some(file => file.size > TICKET_FILE_MAX_BYTES)) {
    error.value = i18n.t('ticket.file_too_large');
    return false;
  }
  const combined = [...files.value, ...newFiles];
  if (combined.length > TICKET_MAX_FILES) {
    error.value = i18n.t('ticket.too_many_files', { n: TICKET_MAX_FILES });
    return false;
  }
  files.value = combined;
  return true;
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files) return;
  addFiles(Array.from(target.files));
  if (fileInput.value) fileInput.value.value = '';
}

/** 截图/复制图片后直接在输入框 Ctrl+V 上传（clipboardData 里的文件走同一套校验） */
function onPaste(event: ClipboardEvent) {
  const pasted = Array.from(event.clipboardData?.files ?? []);
  if (!pasted.length) return;
  if (addFiles(pasted)) event.preventDefault();
}

function removeFile(index: number) {
  files.value.splice(index, 1);
}

async function changeStatus() {
  statusBusy.value = true;
  error.value = '';
  try {
    const res = await adminApi.ticketStatus(Number(route.params.id), status.value);
    if (res.changed) {
      notice.value = i18n.t('ticket.event_status_changed', {
        status: i18n.t(`ticket.status.${status.value}`),
      });
    }
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    statusBusy.value = false;
  }
}

async function reply() {
  if ((!body.value.trim() && !files.value.length) || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await adminApi.ticketReply(
      Number(route.params.id),
      body.value.trim(),
      internal.value,
      files.value,
    );
    body.value = '';
    files.value = [];
    notice.value = internal.value ? i18n.t('ticket.save_note') : i18n.t('ticket.reply');
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);

onBeforeUnmount(() => {
  for (const url of filePreviewUrls.value) if (url) URL.revokeObjectURL(url);
});
</script>

<template>
  <PageHeader :title="data?.ticket.ticketNumber || i18n.t('ticket.manage')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/admin/tickets" class="page-back">
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

  <AppSkeleton v-if="loading && !data" variant="detail" :count="4" />

  <div v-if="data" class="space-y-6">
    <!-- 工单控制头与状态流转面板 -->
    <section class="panel p-4 sm:p-5">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div class="space-y-1 min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-surface-2 border border-line">
              {{ data.ticket.ticketNumber }}
            </span>
            <span class="text-xs text-muted">
              {{ data.ticket.categoryName }}
            </span>
          </div>
          <h2 class="text-lg font-bold text-foreground">
            {{ data.ticket.title }}
          </h2>
          <p class="text-xs text-muted flex flex-wrap items-center gap-2">
            <span>{{ i18n.t('ticket.user') }}: <strong class="text-foreground">{{ data.ticket.userNickname || data.ticket.userEmail }}</strong></span>
            <span v-if="data.ticket.userEmail" class="font-mono text-[11px]">({{ data.ticket.userEmail }})</span>
            <span>·</span>
            <span>UID: {{ data.ticket.userId }}</span>
            <span>·</span>
            <span>{{ i18n.d(data.ticket.createdAt) }}</span>
          </p>
        </div>

        <div class="flex items-center gap-2 bg-surface-2/60 p-2.5 rounded-lg border border-line shrink-0">
          <label class="text-xs font-semibold text-muted whitespace-nowrap">
            {{ i18n.t('ticket.status_label') }}:
          </label>
          <AppSelect
            v-model="status"
            class="w-40"
            :options="statusOptions"
            @change="changeStatus"
          />
          <AppButton
            class="btn-sm"
            :loading="statusBusy"
            @click="changeStatus"
          >
            {{ i18n.t('common.edit') }}
          </AppButton>
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

        <!-- 消息或内部备注气泡 -->
        <article
          v-else
          class="flex gap-3 max-w-3xl"
          :class="item.data.internal
            ? 'mx-auto w-full max-w-3xl'
            : item.data.authorType === 'admin' ? 'ml-auto flex-row-reverse' : 'mr-auto'"
        >
          <!-- 头像 -->
          <div class="shrink-0 mt-0.5">
            <div
              v-if="item.data.internal"
              class="h-9 w-9 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-sm"
            >
              <AppIcon name="lock" class="!text-lg" />
            </div>
            <div
              v-else-if="item.data.authorType === 'admin'"
              class="h-9 w-9 rounded-full bg-brand-600 text-white flex items-center justify-center shadow-sm"
            >
              <AppIcon name="support_agent" class="!text-lg" />
            </div>
            <UserAvatar
              v-else
              :texture-id="null"
              :user-id="data.ticket.userId"
              :name="data.ticket.userNickname || ''"
              class="h-9 w-9 rounded-full border border-line bg-surface-2 object-contain"
            />
          </div>

          <!-- 气泡内容 -->
          <div class="min-w-0 max-w-[85%] space-y-1" :class="item.data.internal ? 'w-full !max-w-none' : ''">
            <div
              class="flex items-center gap-2 text-xs text-muted"
              :class="item.data.internal ? 'justify-start' : item.data.authorType === 'admin' ? 'justify-end' : 'justify-start'"
            >
              <span class="font-semibold text-foreground">
                <template v-if="item.data.internal">
                  {{ item.data.authorName || i18n.t('ticket.admin') }}
                </template>
                <template v-else-if="item.data.authorType === 'admin'">
                  {{ item.data.authorName || i18n.t('ticket.support') }}
                </template>
                <template v-else>
                  {{ data.ticket.userNickname || data.ticket.userEmail }}
                </template>
              </span>
              <span
                v-if="item.data.internal"
                class="badge badge-warning text-[10px] py-0 px-1 inline-flex items-center gap-0.5"
              >
                <AppIcon name="lock" class="!text-[10px]" />
                {{ i18n.t('ticket.internal') }}
              </span>
              <span
                v-else-if="item.data.authorType === 'admin'"
                class="badge badge-primary text-[10px] py-0 px-1"
              >
                {{ i18n.t('ticket.admin') }}
              </span>
              <span class="font-mono text-[11px]">{{ i18n.d(item.data.createdAt, 'short') }}</span>
            </div>

            <div
              class="rounded-2xl p-4 shadow-sm border"
              :class="item.data.internal
                ? 'border-dashed border-amber-300 bg-amber-50/70 text-amber-950 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200'
                : item.data.authorType === 'admin'
                ? 'bg-brand-50 text-foreground border-brand-200 dark:bg-brand-950/40 dark:border-brand-800/50 rounded-tr-sm'
                : 'bg-surface text-foreground border-line rounded-tl-sm'"
            >
              <p class="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {{ item.data.body }}
              </p>

              <!-- 附件列表：图片渲染缩略图（点击原图），其余保持文件条 -->
              <div
                v-if="data.attachments.filter(a => a.messageId === item.data.id).length"
                class="mt-3 pt-2.5 border-t border-line/60 space-y-2"
              >
                <div
                  v-if="data.attachments.filter(a => a.messageId === item.data.id && isImage(a.mimeType)).length"
                  class="flex flex-wrap gap-2"
                >
                  <a
                    v-for="file in data.attachments.filter(a => a.messageId === item.data.id && isImage(a.mimeType))"
                    :key="file.id"
                    :href="adminApi.ticketAttachmentUrl(data.ticket.id, file.id)"
                    target="_blank"
                    class="block rounded-lg overflow-hidden border border-line bg-surface-2/60 hover:border-brand-400"
                    :title="file.fileName"
                  >
                    <img
                      :src="adminApi.ticketAttachmentUrl(data.ticket.id, file.id)"
                      :alt="file.fileName"
                      class="max-h-48 max-w-[240px] w-auto object-contain"
                      loading="lazy"
                    />
                  </a>
                </div>
                <div
                  v-for="file in data.attachments.filter(a => a.messageId === item.data.id && !isImage(a.mimeType))"
                  :key="file.id"
                  class="flex items-center justify-between gap-3 rounded-lg bg-surface-2/80 p-2 text-xs border border-line"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <AppIcon
                      name="description"
                      class="text-brand-600 !text-base shrink-0"
                    />
                    <span class="font-medium truncate">{{ file.fileName }}</span>
                    <span class="text-muted font-mono text-[11px] shrink-0">({{ formatBytes(file.sizeBytes) }})</span>
                  </div>
                  <a
                    :href="adminApi.ticketAttachmentUrl(data.ticket.id, file.id)"
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

    <!-- 管理员回复 & 内部备注工作台面板 -->
    <section class="panel !p-0 overflow-hidden">
      <header class="border-b border-line px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <AppIcon :name="internal ? 'lock' : 'reply'" :class="internal ? 'text-amber-500' : 'text-brand-600'" class="!text-xl" />
          <h3 class="font-semibold text-sm">
            {{ internal ? i18n.t('ticket.save_note') : i18n.t('ticket.reply') }}
          </h3>
        </div>

        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1.5 text-xs font-semibold cursor-pointer select-none">
            <AppCheckbox v-model="internal" />
            <span :class="internal ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-muted'">
              {{ i18n.t('ticket.internal') }}
            </span>
          </label>
        </div>
      </header>

      <div class="p-4 sm:p-5 space-y-3">
        <p v-if="internal" class="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800/50 flex items-center gap-1.5">
          <AppIcon name="info" class="!text-sm text-amber-500" />
          <span>{{ i18n.t('ticket.internal_hint') }}</span>
        </p>

        <AppInput
          v-model="body"
          multiline
          class="w-full min-h-32"
          :placeholder="internal ? i18n.t('ticket.internal_hint') : i18n.t('ticket.reply_placeholder')"
          maxlength="20000"
          @paste="onPaste"
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
              <img
                v-if="filePreviewUrls[idx]"
                :src="filePreviewUrls[idx]!"
                :alt="file.name"
                class="h-5 w-5 rounded object-cover"
              />
              <AppIcon v-else name="attach_file" class="!text-xs text-muted" />
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
            :class="internal ? 'btn-warning bg-amber-500 hover:bg-amber-600 text-white' : 'btn-primary'"
            :disabled="!body.trim() && !files.length"
            :loading="busy"
            @click="reply"
          >
            <AppIcon :name="internal ? 'lock' : 'send'" />
            <span>{{ internal ? i18n.t('ticket.save_note') : i18n.t('ticket.reply') }}</span>
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>
