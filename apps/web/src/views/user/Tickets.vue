<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ticketApi, type TicketCategory, type TicketSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
const router = useRouter();

const items = ref<TicketSummary[]>([]);
const unread = ref(0);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref(false);

const categories = ref<TicketCategory[]>([]);
const title = ref('');
const categoryId = ref(0);
const description = ref('');
const files = ref<File[]>([]);
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

const categoryOptions = computed(() =>
  categories.value.map(c => ({
    value: c.id,
    label: c.name,
  })),
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [categoryData, data] = await Promise.all([
      ticketApi.categories(),
      ticketApi.list(),
    ]);
    categories.value = categoryData.items;
    if (!categoryId.value && categories.value[0]) {
      categoryId.value = categories.value[0].id;
    }
    items.value = data.items;
    unread.value = data.unread;
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

async function create() {
  if (busy.value || !title.value.trim() || !description.value.trim() || !categoryId.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await ticketApi.create({
      title: title.value.trim(),
      categoryId: categoryId.value,
      description: description.value.trim(),
      files: files.value,
    });
    title.value = '';
    description.value = '';
    files.value = [];
    notice.value = i18n.t('ticket.created');
    await router.push(`/tickets/${result.id}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <PageHeader :title="i18n.t('ticket.title')">
    <div class="flex items-center gap-2">
      <span v-if="unread" class="badge badge-warning inline-flex items-center gap-1 font-semibold">
        <AppIcon name="mail" class="!text-xs" />
        {{ unread }} {{ i18n.t('ticket.unread') }}
      </span>
      <AppButton class="btn-sm" :loading="loading" @click="load">
        <AppIcon name="refresh" />
      </AppButton>
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

  <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
    <!-- 左侧：工单列表卡片 -->
    <section class="panel !p-0 overflow-hidden">
      <header class="flex items-center justify-between border-b border-line px-4 py-3">
        <div class="flex items-center gap-2">
          <AppIcon name="confirmation_number" class="text-brand-600 !text-xl" />
          <h2 class="font-semibold text-sm">{{ i18n.t('ticket.title') }}</h2>
          <span class="text-xs text-muted">({{ items.length }})</span>
        </div>
      </header>

      <AppSkeleton v-if="loading && !items.length" class="p-4" :count="4" />

      <div v-else-if="items.length" class="divide-y divide-line">
        <div
          v-for="item in items"
          :key="item.id"
          class="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-surface-2/60 transition-colors cursor-pointer"
          @click="router.push(`/tickets/${item.id}`)"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs font-semibold text-muted bg-surface-2 px-1.5 py-0.5 rounded border border-line">
                {{ item.ticketNumber }}
              </span>
              <span v-if="item.userUnread" class="badge badge-warning inline-flex items-center gap-1 text-[11px]">
                <span class="h-1.5 w-1.5 rounded-full bg-amber-600 animate-pulse" />
                {{ i18n.t('ticket.unread') }}
              </span>
              <span class="text-xs text-muted truncate">
                {{ item.categoryName }}
              </span>
            </div>
            <h3 class="text-sm font-semibold text-foreground group-hover:text-brand-600 transition-colors line-clamp-1">
              {{ item.title }}
            </h3>
            <p class="text-xs text-muted line-clamp-1">
              {{ item.description }}
            </p>
          </div>

          <div class="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-line/60">
            <span class="badge inline-flex items-center gap-1 text-xs" :class="statusBadgeClass(item.status)">
              <AppIcon :name="statusIcon(item.status)" class="!text-xs" />
              {{ i18n.t(`ticket.status.${item.status}`) }}
            </span>
            <span class="text-xs text-muted font-mono">
              {{ i18n.d(item.updatedAt, 'short') }}
            </span>
          </div>
        </div>
      </div>

      <div v-else class="p-8">
        <EmptyState
          :title="i18n.t('ticket.empty')"
          class="py-6"
        />
      </div>
    </section>

    <!-- 右侧：提交新工单面板 -->
    <section class="panel !p-0 overflow-hidden">
      <header class="border-b border-line px-4 py-3 flex items-center gap-2">
        <AppIcon name="add_circle_outline" class="text-brand-600 !text-xl" />
        <h2 class="font-semibold text-sm">{{ i18n.t('ticket.create') }}</h2>
      </header>

      <div class="p-4 sm:p-5 space-y-4">
        <div>
          <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
            {{ i18n.t('ticket.category_label') }}
          </label>
          <AppSelect
            v-model="categoryId"
            class="w-full"
            :options="categoryOptions"
            :placeholder="i18n.t('ticket.select_category')"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
            {{ i18n.t('ticket.subject') }}
          </label>
          <AppInput
            v-model="title"
            class="w-full"
            :placeholder="i18n.t('ticket.subject')"
            maxlength="160"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold text-muted mb-1 uppercase tracking-wider">
            {{ i18n.t('ticket.description') }}
          </label>
          <AppInput
            v-model="description"
            multiline
            class="w-full min-h-36"
            :placeholder="i18n.t('ticket.description')"
            maxlength="20000"
          />
        </div>

        <!-- 附件上传区域 -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-muted uppercase tracking-wider">
              {{ i18n.t('ticket.attachments') }}
            </label>
            <span class="text-[11px] text-muted">
              {{ files.length }}/5
            </span>
          </div>

          <div
            class="rounded-lg border border-dashed border-line bg-surface-2/40 p-3 hover:border-brand-500 transition-colors flex flex-col items-center justify-center text-center cursor-pointer"
            @click="fileInput?.click()"
          >
            <AppIcon name="cloud_upload" class="text-muted !text-2xl" />
            <p class="mt-1 text-xs text-brand-600 font-medium">
              {{ i18n.t('ticket.attach_files') }}
            </p>
            <p class="text-[11px] text-muted mt-0.5">
              {{ i18n.t('ticket.file_limit_hint') }}
            </p>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden"
              accept="image/*,.pdf,.txt,.csv,.zip"
              @change="onFileChange"
            />
          </div>

          <!-- 已选择文件列表 -->
          <div v-if="files.length" class="space-y-1.5 pt-1">
            <div
              v-for="(file, idx) in files"
              :key="idx"
              class="flex items-center justify-between gap-2 rounded bg-surface-2 px-2.5 py-1.5 text-xs border border-line"
            >
              <div class="flex items-center gap-1.5 min-w-0">
                <AppIcon name="attach_file" class="text-muted !text-sm shrink-0" />
                <span class="truncate font-medium">{{ file.name }}</span>
                <span class="text-muted text-[11px] shrink-0 font-mono">({{ formatBytes(file.size) }})</span>
              </div>
              <button
                type="button"
                class="text-muted hover:text-danger shrink-0 focus:outline-none"
                @click.stop="removeFile(idx)"
              >
                <AppIcon name="close" class="!text-sm" />
              </button>
            </div>
          </div>
        </div>

        <AppButton
          class="btn-primary w-full mt-2"
          :disabled="!title.trim() || !description.trim() || !categoryId"
          :loading="busy"
          @click="create"
        >
          <AppIcon name="send" />
          <span>{{ i18n.t('ticket.submit') }}</span>
        </AppButton>
      </div>
    </section>
  </div>
</template>
