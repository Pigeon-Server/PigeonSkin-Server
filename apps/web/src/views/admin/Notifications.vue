<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { adminApi, ApiError, type AuditLogItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';

// 与 API 侧 notification-template.ts 的 NOTIFICATION_VARIABLES 对齐
const NOTIFICATION_VARIABLES = [
  'site_name',
  'site_url',
  'player',
  'email',
  'uid',
  'score',
  'date',
] as const;

const i18n = useI18n();
const site = useSiteSettings();

const title = ref('');
const content = ref('');
const target = ref<'all' | 'normal' | 'user'>('all');
const recipient = ref('');
const sendEmail = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');

const contentEl = ref<HTMLTextAreaElement | null>(null);

// 预览控制
const previewTab = ref<'inapp' | 'email'>('inapp');
const previewBusy = ref(false);
const simulateSample = ref(true);
const emailPreview = ref<{ subject: string; html: string; text: string } | null>(null);
let previewRevision = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

// 历史广播记录
const history = ref<AuditLogItem[]>([]);
const historyLoading = ref(false);

// 收件人有效性校验
const isRecipientValid = computed(() => {
  if (target.value !== 'user') return true;
  const val = recipient.value.trim();
  if (!val) return false;
  // 纯数字 UID 或合法邮箱
  return /^\d+$/.test(val) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
});

const recipientError = computed(() => {
  if (target.value !== 'user') return '';
  const val = recipient.value.trim();
  if (!val) return '';
  if (!isRecipientValid.value) {
    return i18n.t('admin.notification_recipient_invalid');
  }
  return '';
});

const canSend = computed(() => {
  const trimmedTitle = title.value.trim();
  return (
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= 50 &&
    content.value.length <= 10000 &&
    isRecipientValid.value &&
    !busy.value
  );
});

// 模拟变量上下文
const sampleContext = computed<Record<string, string>>(() => ({
  site_name: site.get('site_name') || 'Pigeon Skin Server',
  site_url: site.get('site_url') || (typeof window !== 'undefined' ? window.location.origin : ''),
  player: 'Steve',
  email: 'steve@example.com',
  uid: '1001',
  score: '100',
  date: new Date().toISOString().slice(0, 10),
}));

function renderVariables(text: string, simulate: boolean): string {
  if (!text) return '';
  if (!simulate) return text;
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) => {
    return sampleContext.value[name] ?? match;
  });
}

const previewTitle = computed(() => renderVariables(title.value || '', simulateSample.value));
const previewContent = computed(() => renderVariables(content.value || '', simulateSample.value));

function insertVariable(v: string) {
  const token = `{{${v}}}`;
  const el = contentEl.value;
  if (!el) {
    content.value += token;
    return;
  }
  const start = el.selectionStart ?? content.value.length;
  const end = el.selectionEnd ?? start;
  content.value = content.value.slice(0, start) + token + content.value.slice(end);
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  });
}

function resetForm() {
  title.value = '';
  content.value = '';
  recipient.value = '';
  error.value = '';
  notice.value = '';
}

async function loadHistory() {
  historyLoading.value = true;
  try {
    const data = await adminApi.auditLog({ action: 'admin.broadcast' });
    history.value = data.items.slice(0, 5);
  } catch {
    // 审计拉取失败不阻断页面
  } finally {
    historyLoading.value = false;
  }
}

function parseBroadcastDetail(detail: string | null) {
  if (!detail) return { receiver: '—', sent: '—', emailQueued: false };
  const parts: Record<string, string> = {};
  for (const seg of detail.split(',')) {
    const idx = seg.indexOf(':');
    if (idx !== -1) {
      parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
    }
  }
  let receiverLabel = parts.receiver || '—';
  if (parts.receiver === 'all') receiverLabel = i18n.t('admin.receiver_all');
  else if (parts.receiver === 'normal') receiverLabel = i18n.t('admin.receiver_normal');
  return {
    receiver: receiverLabel,
    sent: parts.sent || '0',
    emailQueued: parts.emailQueued === 'true',
  };
}

async function send() {
  if (!canSend.value) return;

  let confirmMsg = '';
  if (target.value === 'all') {
    confirmMsg = i18n.t('admin.broadcast_confirm_all');
  } else if (target.value === 'normal') {
    confirmMsg = i18n.t('admin.broadcast_confirm_normal');
  } else {
    confirmMsg = i18n.t('admin.broadcast_confirm_user', { target: recipient.value.trim() });
  }

  if (sendEmail.value) {
    confirmMsg += ` ${i18n.t('admin.broadcast_confirm_with_email')}`;
  }

  if (!(await confirmAction(confirmMsg))) return;

  busy.value = true;
  error.value = '';
  notice.value = '';

  try {
    const receiver =
      target.value === 'user'
        ? /^\d+$/.test(recipient.value.trim())
          ? Number(recipient.value.trim())
          : recipient.value.trim()
        : target.value;

    const data = await adminApi.broadcast({
      title: title.value.trim(),
      content: content.value,
      receiver,
      sendEmail: sendEmail.value,
    });

    notice.value =
      i18n.t('admin.notification_sent', { count: i18n.n(data.sent) }) +
      (sendEmail.value
        ? ` · ${i18n.t(data.emailQueued ? 'admin.notification_email_queued' : 'admin.notification_email_queue_failed')}`
        : '');
    title.value = '';
    content.value = '';
    void loadHistory();
  } catch (e) {
    if (e instanceof ApiError && e.fields?.sendEmail) {
      if (e.fields.sendEmail === 'email_not_configured') {
        error.value = i18n.t('admin.notification_email_not_configured');
        return;
      }
      if (e.fields.sendEmail === 'queue_unavailable') {
        error.value = i18n.t('admin.notification_email_queue_unavailable');
        return;
      }
    }
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function refreshEmailPreview() {
  const revision = ++previewRevision;
  if (!sendEmail.value) {
    emailPreview.value = null;
    return;
  }
  previewBusy.value = true;
  try {
    const preview = await adminApi.notificationEmailPreview({
      title: title.value || i18n.t('admin.notification_title'),
      content: content.value,
      locale: i18n.locale.value,
    });
    if (revision === previewRevision) emailPreview.value = preview;
  } catch {
    if (revision === previewRevision) emailPreview.value = null;
  } finally {
    if (revision === previewRevision) previewBusy.value = false;
  }
}

function scheduleEmailPreview() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void refreshEmailPreview();
  }, 350);
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

onMounted(() => {
  void loadHistory();
});

watch(sendEmail, (active) => {
  if (!active && previewTab.value === 'email') {
    previewTab.value = 'inapp';
  }
  if (active) {
    scheduleEmailPreview();
  } else {
    emailPreview.value = null;
  }
});

watch([title, content, () => i18n.locale.value], () => {
  if (sendEmail.value) scheduleEmailPreview();
});

watch(target, (newTarget) => {
  if (newTarget !== 'user') {
    recipient.value = '';
  }
});
</script>

<template>
  <PageHeader :title="i18n.t('admin.broadcast')">
    <AppButton
      type="button"
      class="btn-sm"
      :disabled="busy || (!title && !content && !recipient)"
      @click="resetForm"
    >
      <AppIcon name="restart_alt" class="!text-sm" />
      {{ i18n.t('admin.notification_reset') }}
    </AppButton>
  </PageHeader>

  <div class="space-y-6">
    <div class="grid items-start gap-6 lg:grid-cols-2">
      <!-- 发送表单 -->
      <AppForm class="panel space-y-4" @submit.prevent="send">
        <!-- 收件对象选择 -->
        <div class="space-y-2">
          <label for="notif-receiver" class="block font-medium text-sm">
            {{ i18n.t('admin.receiver') }}
          </label>
          <AppSelect
            id="notif-receiver"
            v-model="target"
            :options="[
              { value: 'all', label: i18n.t('admin.receiver_all') },
              { value: 'normal', label: i18n.t('admin.receiver_normal') },
              { value: 'user', label: i18n.t('admin.receiver_user') },
            ]"
          />

          <!-- 特定用户目标输入框 -->
          <div v-if="target === 'user'" class="pt-1 space-y-1">
            <AppInput
              id="notif-recipient"
              v-model="recipient"
              required
              :placeholder="i18n.t('admin.notification_recipient_placeholder')"
              :aria-label="i18n.t('admin.receiver_user')"
            />
            <p v-if="recipientError" class="text-xs text-danger" role="alert">
              {{ recipientError }}
            </p>
          </div>
        </div>

        <!-- 发送邮件勾选项 -->
        <div class="space-y-1 rounded-lg border border-line bg-surface-2/40 p-3">
          <AppCheckbox v-model="sendEmail" :label="i18n.t('admin.notification_send_email')" />
          <p class="text-xs text-muted pl-6">
            {{ i18n.t('admin.notification_send_email_hint') }}
          </p>
        </div>

        <!-- 标题 -->
        <div>
          <div class="mb-1.5 flex items-center justify-between text-sm">
            <label for="notif-title" class="font-medium">
              {{ i18n.t('admin.notification_title') }}
            </label>
            <span
              class="text-xs"
              :class="title.length >= 50 ? 'text-amber-600 font-semibold' : 'text-muted'"
            >
              {{ title.length }} / 50
            </span>
          </div>
          <AppInput
            id="notif-title"
            v-model="title"
            maxlength="50"
            required
            :placeholder="i18n.t('admin.notification_title')"
          />
        </div>

        <!-- 变量快捷工具栏 -->
        <div class="rounded-lg border border-line/80 bg-surface-2/40 p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-foreground flex items-center gap-1.5">
              <AppIcon name="data_object" class="!text-sm text-brand-600" />
              {{ i18n.t('admin.notification_variables') }}
            </span>
            <span class="text-[11px] text-muted">{{ i18n.t('admin.notification_insert_var') }}</span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="v in NOTIFICATION_VARIABLES"
              :key="v"
              type="button"
              class="inline-flex items-center gap-1 rounded border border-line bg-surface hover:bg-surface-2 hover:border-brand-400 px-2 py-1 text-xs font-mono transition text-foreground cursor-pointer shadow-2xs"
              :title="i18n.t(`admin.var_${v}`)"
              @click="insertVariable(v)"
            >
              <span class="text-brand-600 dark:text-brand-400 font-semibold" v-text="'{{' + v + '}}'" />
              <span class="text-[10px] text-muted font-sans opacity-80">({{ i18n.t(`admin.var_${v}`) }})</span>
            </button>
          </div>
          <p class="text-[11px] text-muted leading-relaxed">
            {{ i18n.t('admin.notification_variables_hint') }} · {{ i18n.t('admin.notification_ai_translation_note') }}
          </p>
        </div>

        <!-- 正文内容 -->
        <div>
          <div class="mb-1.5 flex items-center justify-between text-sm">
            <div class="flex items-center gap-2">
              <label for="notif-content" class="font-medium">
                {{ i18n.t('admin.notification_content') }}
              </label>
              <span class="text-[11px] text-muted">({{ i18n.t('admin.notification_markdown_hint') }})</span>
            </div>
            <span class="text-xs text-muted">
              {{ i18n.n(content.length) }} / 10,000
            </span>
          </div>
          <textarea
            id="notif-content"
            ref="contentEl"
            v-model="content"
            class="input min-h-56 resize-y font-mono text-sm leading-relaxed"
            maxlength="10000"
            :placeholder="i18n.t('admin.notification_content')"
          />
        </div>

        <!-- 提示与错误状态 -->
        <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
        <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>

        <!-- 提交按钮 -->
        <div class="flex items-center gap-3 pt-2">
          <AppButton type="submit" class="btn-primary" :loading="busy" :disabled="!canSend">
            <AppIcon name="send" />
            {{ i18n.t('admin.broadcast') }}
          </AppButton>
        </div>
      </AppForm>

      <!-- 右侧：实时预览面板 -->
      <section class="panel self-start space-y-4">
        <header class="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div class="flex items-center gap-2">
            <p class="eyebrow !mb-0">{{ i18n.t('general.previews') }}</p>
            <!-- 邮件开启时的 Tab 切换 -->
            <div v-if="sendEmail" class="filter-tabs ml-2">
              <AppButton
                class="btn-sm"
                :class="{ selected: previewTab === 'inapp' }"
                @click="previewTab = 'inapp'"
              >
                {{ i18n.t('admin.notification_tab_inapp') }}
              </AppButton>
              <AppButton
                class="btn-sm"
                :class="{ selected: previewTab === 'email' }"
                @click="previewTab = 'email'"
              >
                {{ i18n.t('admin.notification_tab_email') }}
              </AppButton>
            </div>
          </div>

          <!-- 模拟变量替换开关 -->
          <label class="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
            <input
              v-model="simulateSample"
              type="checkbox"
              class="checkbox checkbox-sm"
            />
            <span>{{ i18n.t('admin.notification_preview_sample_toggle') }}</span>
          </label>
        </header>

        <!-- 站内信预览卡片 -->
        <div v-if="previewTab === 'inapp'" class="space-y-3">
          <div class="rounded-xl border border-line bg-surface p-4 shadow-2xs space-y-3">
            <div class="flex items-center justify-between border-b border-line/60 pb-3">
              <div class="flex items-center gap-2.5">
                <div class="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400 shrink-0">
                  <AppIcon name="campaign" class="!text-lg" />
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs font-semibold text-foreground truncate">
                      {{ i18n.t('admin.notification_system_sender') }}
                    </span>
                    <span class="inline-block h-1.5 w-1.5 rounded-full bg-brand-500 shrink-0" />
                  </div>
                  <span class="text-[11px] text-muted">{{ i18n.t('admin.notification_just_now') }}</span>
                </div>
              </div>
              <span class="badge badge-brand text-[10px] shrink-0">
                {{ target === 'all' ? i18n.t('admin.receiver_all') : target === 'normal' ? i18n.t('admin.receiver_normal') : i18n.t('admin.receiver_user') }}
              </span>
            </div>

            <div class="space-y-2">
              <h3 class="text-base font-bold text-foreground break-words">
                {{ previewTitle || i18n.t('admin.notification_title') }}
              </h3>
              <div class="prose prose-sm dark:prose-invert max-w-none break-words min-h-16">
                <MarkdownContent v-if="previewContent" :content="previewContent" />
                <p v-else class="text-xs text-muted italic">
                  {{ i18n.t('admin.notification_empty_preview') }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- 邮件效果预览 -->
        <div v-else class="space-y-3">
          <div v-if="emailPreview" class="rounded-lg border border-line bg-surface-2/60 p-2.5 text-xs text-muted">
            <span class="font-medium text-foreground">{{ i18n.t('admin.notification_title') }}:</span>
            <span class="ml-1 text-foreground font-semibold">{{ emailPreview.subject }}</span>
          </div>
          <div class="relative min-h-[460px] rounded-lg border border-line bg-white overflow-hidden shadow-2xs">
            <div v-if="previewBusy" class="absolute inset-0 z-10 flex items-center justify-center bg-white/75 backdrop-blur-xs">
              <div class="flex items-center gap-2 text-xs text-muted">
                <AppIcon name="sync" class="animate-spin !text-base text-brand-600" />
                <span>{{ i18n.t('common.loading') }}</span>
              </div>
            </div>
            <iframe
              v-if="emailPreview"
              class="h-[520px] w-full border-0 bg-white"
              :srcdoc="emailPreview.html"
              sandbox=""
              title="Email preview"
            />
            <div v-else-if="!previewBusy" class="p-12 text-center text-xs text-muted">
              <AppIcon name="mail_outline" class="!text-4xl text-muted/50 mb-2 block mx-auto" />
              <p>{{ i18n.t('admin.notification_empty_preview') }}</p>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 底部：历史广播记录卡片 -->
    <section class="panel space-y-4">
      <header class="flex items-center justify-between border-b border-line pb-3">
        <div class="flex items-center gap-2">
          <AppIcon name="history" class="text-brand-600 !text-xl" />
          <h2 class="text-base font-semibold text-foreground">
            {{ i18n.t('admin.broadcast_history') }}
          </h2>
        </div>
        <router-link
          to="/admin/audit-log?action=admin.broadcast"
          class="text-xs text-brand-600 hover:underline flex items-center gap-1"
        >
          <span>{{ i18n.t('admin.broadcast_view_all_audit') }}</span>
          <AppIcon name="chevron_right" class="!text-sm" />
        </router-link>
      </header>

      <AppSkeleton v-if="historyLoading && !history.length" variant="table" :count="4" />
      <div v-else-if="history.length" class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs text-muted">
              <th class="py-2.5 pr-4 font-medium">{{ i18n.t('admin.audit_time') }}</th>
              <th class="py-2.5 pr-4 font-medium">{{ i18n.t('admin.receiver') }}</th>
              <th class="py-2.5 pr-4 font-medium">{{ i18n.t('admin.task_status_col') }}</th>
              <th class="py-2.5 pr-4 font-medium">{{ i18n.t('admin.notification_send_email') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in history"
              :key="item.id"
              class="border-b border-line/60 last:border-0 hover:bg-surface-2/40 transition-colors"
            >
              <td class="py-3 pr-4 whitespace-nowrap text-xs text-muted">
                {{ i18n.d(item.createdAt) }}
              </td>
              <td class="py-3 pr-4">
                <span class="badge badge-default text-xs">
                  {{ parseBroadcastDetail(item.detail).receiver }}
                </span>
              </td>
              <td class="py-3 pr-4 font-medium">
                {{ i18n.t('admin.broadcast_sent_count', { count: i18n.n(Number(parseBroadcastDetail(item.detail).sent)) }) }}
              </td>
              <td class="py-3 pr-4">
                <span
                  class="badge text-xs"
                  :class="parseBroadcastDetail(item.detail).emailQueued ? 'badge-success' : 'badge-default'"
                >
                  {{ parseBroadcastDetail(item.detail).emailQueued ? i18n.t('admin.notification_email_queued') : i18n.t('general.no') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-xs text-muted py-4 text-center">
        {{ i18n.t('admin.broadcast_empty_history') }}
      </p>
    </section>
  </div>
</template>
