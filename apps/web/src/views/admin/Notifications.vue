<script setup lang="ts">
import { ref, watch } from 'vue';
import { adminApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const title = ref('');
const content = ref('');
const target = ref('all');
const recipient = ref('');
const sendEmail = ref(false);
const busy = ref(false);
const previewBusy = ref(false);
const emailPreview = ref<{ subject: string; html: string; text: string } | null>(null);
let previewRevision = 0;
const error = ref('');
const notice = ref('');
async function send() {
  if (!(await confirmAction(i18n.t('admin.broadcast')))) return;
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
    const data = await adminApi.broadcast({ title: title.value, content: content.value, receiver, sendEmail: sendEmail.value });
    notice.value = i18n.t('admin.notification_sent', { count: i18n.n(data.sent) }) + (sendEmail.value ? ` · ${i18n.t(data.emailQueued ? 'admin.notification_email_queued' : 'admin.notification_email_queue_failed')}` : '');
    title.value = content.value = '';
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function refreshEmailPreview() {
  const revision = ++previewRevision;
  if (!sendEmail.value) { emailPreview.value = null; return; }
  previewBusy.value = true;
  try {
    const preview = await adminApi.notificationEmailPreview({ title: title.value || i18n.t('admin.notification_title'), content: content.value, locale: i18n.locale.value });
    if (revision === previewRevision) emailPreview.value = preview;
  } catch { if (revision === previewRevision) emailPreview.value = null; }
  finally { if (revision === previewRevision) previewBusy.value = false; }
}
watch([title, content, sendEmail, i18n.locale], () => { void refreshEmailPreview(); }, { immediate: true });
</script>
<template>
  <PageHeader :title="i18n.t('admin.broadcast')" />
  <div class="grid gap-6 lg:grid-cols-2">
    <AppForm class="panel space-y-4" @submit.prevent="send">
      <div>
        <label for="notif-receiver" class="mb-2 block">{{ i18n.t('admin.receiver') }}</label>
        <AppSelect id="notif-receiver" v-model="target" :options="[{ value: 'all', label: i18n.t('admin.receiver_all') }, { value: 'normal', label: i18n.t('admin.receiver_normal') }, { value: 'user', label: i18n.t('admin.receiver_user') }]" />
      </div>
      <AppCheckbox v-model="sendEmail" :label="i18n.t('admin.notification_send_email')" />
      <AppInput
        v-if="target === 'user'"
        v-model="recipient"
        required
        :aria-label="i18n.t('admin.receiver_user')"
      />
      <div>
        <label for="notif-title" class="mb-2 block">{{ i18n.t('admin.notification_title') }}</label>
        <AppInput id="notif-title" v-model="title" maxlength="20" required />
      </div>
      <div>
        <label for="notif-content" class="mb-2 block">
          {{ i18n.t('admin.notification_content') }}
        </label>
        <AppInput id="notif-content" v-model="content" multiline class="min-h-56" maxlength="10000" />
      </div>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
      <AppButton type="submit" class="btn-primary" :loading="busy">
        <AppIcon name="send" />
        {{ i18n.t('admin.broadcast') }}
      </AppButton>
    </AppForm>
    <section v-if="!sendEmail" class="panel self-start">
      <p class="eyebrow">{{ i18n.t('general.previews') }}</p>
      <h2 class="text-xl font-semibold">{{ title }}</h2>
      <MarkdownContent :content="content" />
    </section>
    <section v-else class="panel self-start space-y-3">
      <p class="eyebrow">{{ i18n.t('admin.notification_email_preview') }}</p>
      <p v-if="previewBusy" class="text-sm text-muted">{{ i18n.t('common.loading') }}</p>
      <template v-else-if="emailPreview">
        <p class="text-sm font-medium">{{ emailPreview.subject }}</p>
        <iframe class="h-[520px] w-full rounded border border-line bg-white" :srcdoc="emailPreview.html" sandbox="" title="Email preview" />
      </template>
    </section>
  </div>
</template>
