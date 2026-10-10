<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { commentApi, type CommentItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import UserAvatar from '@/components/UserAvatar.vue';
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { apiErrorMessage } from '@/lib/api-error';
const props = defineProps<{ textureId: number }>();
const emit = defineEmits<{ count: [value: number] }>();
const i18n = useI18n();
const session = useSessionStore();
const items = ref<CommentItem[]>([]),
  content = ref('');
const page = ref(1),
  totalPages = ref(1),
  total = ref(0);
const loading = ref(true),
  posting = ref(false),
  deleting = ref<number | null>(null);
const listError = ref(''),
  formError = ref(''),
  notice = ref('');
const captchaToken = ref(''),
  captchaRandstr = ref('');
const challenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);
let requestId = 0;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let submittedId: number | null = null;
function schedulePending() {
  clearTimeout(pendingTimer);
  if (!items.value.some(comment => comment.status === 'pending' && comment.userId === session.user.value?.id)) return;
  pendingTimer = setTimeout(() => {
    if (document.hidden) schedulePending();
    else void load(page.value, true);
  }, 3000);
}
async function load(next = page.value, silent = false) {
  const id = ++requestId;
  if (!silent) loading.value = true;
  listError.value = '';
  try {
    const data = await commentApi.list(props.textureId, next);
    if (id !== requestId) return;
    if (next > data.totalPages) {
      await load(data.totalPages);
      return;
    }
    items.value = data.items;
    const submitted = data.items.find(comment => comment.id === submittedId);
    if (submitted && submitted.status !== 'pending') {
      notice.value = i18n.t(submitted.status === 'rejected' ? 'comments.status_rejected' : 'comments.published');
      submittedId = null;
    }
    page.value = data.page;
    totalPages.value = data.totalPages;
    total.value = data.total;
    emit('count', data.total);
    schedulePending();
  } catch (e) {
    if (id === requestId)
      listError.value = apiErrorMessage(e);
    if (id === requestId) schedulePending();
  } finally {
    if (id === requestId) loading.value = false;
  }
}
async function post() {
  if (!content.value.trim() || posting.value) return;
  posting.value = true;
  formError.value = '';
  notice.value = '';
  try {
    const created = await commentApi.create(props.textureId, content.value.trim(), captchaToken.value, captchaRandstr.value);
    submittedId = created.id;
    content.value = '';
    captchaToken.value = '';
    captchaRandstr.value = '';
    notice.value = i18n.t(created.status === 'pending' ? 'comments.pending' : 'comments.published');
    await load(1);
  } catch (e) {
    challenge.value?.reset();
    formError.value = apiErrorMessage(e);
  } finally {
    posting.value = false;
  }
}
async function remove(comment: CommentItem) {
  if (deleting.value !== null || !(await confirmAction(i18n.t('comments.delete_confirm')))) return;
  deleting.value = comment.id;
  listError.value = '';
  try {
    await commentApi.remove(comment.id);
    notice.value = i18n.t('comments.deleted');
    await load();
  } catch (e) {
    listError.value = apiErrorMessage(e);
  } finally {
    deleting.value = null;
  }
}
watch(() => [props.textureId, session.user.value?.id], () => {
  clearTimeout(pendingTimer);
  items.value = []; notice.value = ''; formError.value = ''; submittedId = null;
  void load(1);
}, { immediate: true });
onBeforeUnmount(() => { requestId++; clearTimeout(pendingTimer); });
</script>
<template>
  <section id="texture-comments" class="panel scroll-mt-20">
    <header class="mb-4 flex items-center justify-between">
      <h2 class="font-semibold">
        {{ i18n.t('comments.title') }}
        <span class="ml-2 text-xs font-normal text-muted">{{ i18n.n(total) }}</span>
      </h2>
    </header>
    <AppForm v-if="session.user.value && !session.user.value.commentsDisabled" class="mb-5" @submit.prevent="post">
      <label for="comment-content" class="mb-2 flex items-center gap-2 text-sm">
        <UserAvatar
          :texture-id="session.user.value.avatarTextureId"
          :user-id="session.user.value.id"
          :name="session.user.value.nickname"
          class="h-7 w-7 rounded"
        />
        <span class="font-medium">{{ session.user.value.nickname }}</span>
      </label>
      <AppInput
        id="comment-content"
        v-model="content"
        multiline
        class="min-h-24"
        maxlength="500"
        required
        :disabled="posting"
        :aria-label="i18n.t('comments.placeholder')"
        :placeholder="i18n.t('comments.placeholder')"
      />
      <VerificationChallenge ref="challenge" v-model="captchaToken" v-model:randstr="captchaRandstr" class="mt-2" />
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted">
          {{ i18n.t('common.characters', { count: i18n.n(content.length), max: i18n.n(500) }) }}
        </span>
        <AppButton type="submit" class="btn-primary" :loading="posting" :disabled="!content.trim()">
          <AppIcon name="send" />
          {{ i18n.t(posting ? 'comments.publishing' : 'comments.submit') }}
        </AppButton>
      </div>
      <p v-if="formError" class="mt-2 text-sm text-danger" role="alert">{{ formError }}</p>
    </AppForm>
    <p v-if="notice" class="mb-3 text-sm text-success" role="status">{{ notice }}</p>
    <p v-if="listError" class="mb-3 text-sm text-danger" role="alert">
      {{ listError }}
      <AppButton class="btn-sm ml-2" @click="load()">{{ i18n.t('common.retry') }}</AppButton>
    </p>
    <AppSkeleton v-if="loading" :count="2" />
    <div v-else-if="items.length" class="divide-y divide-line">
      <article v-for="comment in items" :key="comment.id" class="flex gap-3 py-4">
        <UserAvatar
          :texture-id="comment.avatarTextureId || null"
          :user-id="comment.userId"
          :name="comment.userName"
          class="h-9 w-9 shrink-0 rounded"
        />
        <div class="min-w-0 flex-1">
          <header class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold">{{ comment.userId === null ? i18n.t('admin.anonymous') : comment.userName }}</span>
              <template v-if="comment.userId === session.user.value?.id && (comment.status === 'pending' || comment.status === 'rejected')">
                <span class="badge" :class="comment.status === 'pending' ? 'badge-default' : 'badge-danger'" role="status"><AppIcon v-if="comment.status === 'pending'" name="schedule" class="!text-xs" />{{ i18n.t('comments.status_' + comment.status) }}</span>
                <span class="text-xs text-muted">{{ i18n.t('comments.private_notice') }}</span>
              </template>
            </div>
            <div class="flex items-center gap-2 text-xs text-muted">
              <time :datetime="new Date(comment.createdAt).toISOString()">
                {{ i18n.d(comment.createdAt) }}
              </time>
              <AppButton
                v-if="session.isAdmin.value || session.user.value?.id === comment.userId"
                class="btn-icon btn-sm"
                :disabled="deleting !== null"
                :loading="deleting === comment.id"
                :aria-label="i18n.t('common.delete')"
                @click="remove(comment)"
              >
                <AppIcon name="delete_outline" />
              </AppButton>
            </div>
          </header>
          <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
            {{ comment.content }}
          </p>
        </div>
      </article>
    </div>
    <p v-else-if="!listError" class="py-2 text-sm text-muted">
      {{ i18n.t('comments.empty') }}
    </p>
    <AppPagination
      v-model="page"
      :total-pages="totalPages"
      :busy="loading"
      @update:model-value="load(page)"
    />
  </section>
</template>
