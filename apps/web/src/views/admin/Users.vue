<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { canModifyUser } from '@pigeon-skin/shared';
import {
  adminApi,
  type AdminUserRow,
  type AdminSessionRow,
  type ClosetEntry,
} from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';

const i18n = useI18n();
const session = useSessionStore();
const items = ref<AdminUserRow[]>([]);
const page = ref(1);
const totalPages = ref(1);
const keyword = ref('');
const error = ref('');
const notice = ref('');
const loading = ref(true);
const busy = ref(false);
const open = ref(false);
const editing = ref<AdminUserRow | null>(null);
const form = reactive({
  email: '',
  nickname: '',
  password: '',
  score: 0,
  role: 'normal' as 'normal' | 'admin' | 'banned',
  emailVerified: false,
  reportingDisabled: false,
  commentsDisabled: false,
});
const sessions = ref<AdminSessionRow[]>([]);
const sessionsFor = ref<AdminUserRow | null>(null);
const sessionsOpen = ref(false);
const closet = ref<ClosetEntry[]>([]);
const closetFor = ref<AdminUserRow | null>(null);
const closetOpen = ref(false);
const closetPage = ref(1);
const closetPages = ref(1);
const textureId = ref<number | null>(null);
const temporaryPassword = ref('');
const passwordOpen = ref(false);
const canEdit = (user: AdminUserRow) =>
  !!session.user.value &&
  user.id !== session.user.value.id &&
  canModifyUser(session.user.value.role, user.role);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await adminApi.users({ keyword: keyword.value || undefined, page: page.value });
    items.value = data.items;
    totalPages.value = data.totalPages;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
function edit(user: AdminUserRow | null) {
  editing.value = user;
  Object.assign(form, {
    email: user?.email || '',
    nickname: user?.nickname || '',
    password: '',
    score: user?.score || 0,
    role: user?.role || 'normal',
    emailVerified: !!user?.emailVerifiedAt,
    reportingDisabled: !!user?.reportingDisabled,
    commentsDisabled: !!user?.commentsDisabled,
  });
  error.value = '';
  open.value = true;
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
    notice.value = i18n.t('general.op-success');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  await run(async () => {
    if (editing.value)
      await adminApi.patchUser(editing.value.id, {
        email: form.email,
        nickname: form.nickname,
        score: form.score,
        role: form.role,
        emailVerified: form.emailVerified,
        reportingDisabled: form.reportingDisabled,
        commentsDisabled: form.commentsDisabled,
      });
    else
      await adminApi.createUser({
        email: form.email,
        nickname: form.nickname,
        password: form.password,
        role: form.role,
      });
    open.value = false;
    await load();
  });
}
async function remove(user: AdminUserRow) {
  if (await confirmAction(i18n.t('admin.delete_user_confirm', { name: user.nickname })))
    await run(async () => {
      await adminApi.deleteUser(user.id);
      await load();
    });
}
async function resetPassword(user: AdminUserRow) {
  if (!(await confirmAction(i18n.t('admin.password_reset')))) return;
  await run(async () => {
    temporaryPassword.value = (await adminApi.resetPassword(user.id)).temporaryPassword;
    passwordOpen.value = true;
  });
}
async function showSessions(user: AdminUserRow) {
  sessionsFor.value = user;
  sessionsOpen.value = true;
  sessions.value = [];
  await run(async () => {
    sessions.value = (await adminApi.userSessions(user.id)).items;
  });
}
async function revoke() {
  if (!sessionsFor.value || !(await confirmAction(i18n.t('admin.revoke_sessions')))) return;
  await run(async () => {
    await adminApi.revokeUserSessions(sessionsFor.value!.id);
    sessions.value = [];
  });
}
async function loadCloset() {
  if (!closetFor.value) return;
  await run(async () => {
    const data = await adminApi.userCloset(closetFor.value!.id, closetPage.value);
    closet.value = data.items;
    closetPages.value = data.totalPages;
  });
}
async function showCloset(user: AdminUserRow) {
  closetFor.value = user;
  closet.value = [];
  closetPage.value = 1;
  closetOpen.value = true;
  await loadCloset();
}
async function addCloset() {
  if (!closetFor.value || !textureId.value) return;
  await run(() => adminApi.addUserClosetEntry(closetFor.value!.id, textureId.value!));
  await loadCloset();
}
async function removeCloset(entry: ClosetEntry) {
  if (!closetFor.value || !(await confirmAction(i18n.t('user.removeItem')))) return;
  await run(() => adminApi.deleteUserClosetEntry(closetFor.value!.id, entry.textureId));
  await loadCloset();
}
watch(page, load);
watch(closetPage, loadCloset);
onMounted(load);
</script>

<template>
  <PageHeader :title="i18n.t('general.user-manage')">
    <AppButton class="btn-primary" @click="edit(null)">
      <AppIcon name="person_add" />
      {{ i18n.t('admin.create_user') }}
    </AppButton>
  </PageHeader>
  <AppForm class="filter-bar" @submit.prevent="page === 1 ? load() : page = 1">
    <SearchExpressionField
      v-model="keyword"
      schema-key="adminUsers"
      class="max-w-sm"
      :aria-label="i18n.t('general.search')"
      :placeholder="i18n.t('admin.search_email')"
    />
    <AppButton type="submit">
      <AppIcon name="search" />
      {{ i18n.t('general.search') }}
    </AppButton>
  </AppForm>
  <p v-if="error && !open && !sessionsOpen && !closetOpen" class="alert alert-danger" role="alert">
    {{ error }}
  </p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <AppSkeleton v-if="loading" :count="3" />
  <div v-else class="panel !p-0 overflow-x-auto">
    <table class="table">
      <thead>
        <tr>
          <th>{{ i18n.t('common.id') }}</th>
          <th>{{ i18n.t('general.nickname') }}</th>
          <th>{{ i18n.t('general.email') }}</th>
          <th>{{ i18n.t('user.role') }}</th>
          <th>{{ i18n.t('general.score') }}</th>
          <th>{{ i18n.t('admin.stats_players') }}</th>
          <th>{{ i18n.t('common.actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in items" :key="user.id">
          <td class="text-muted">#{{ user.id }}</td>
          <td class="font-medium">{{ user.nickname }}</td>
          <td>
            {{ user.email }}
            <span class="block text-xs text-muted">
              {{ i18n.t(user.emailVerifiedAt ? 'admin.verified' : 'admin.unverified') }}
            </span>
          </td>
          <td>
            <span class="badge" :class="user.role === 'banned' ? 'badge-danger' : ''">
              {{ i18n.t(`admin.role_${user.role === 'super_admin' ? 'super' : user.role}`) }}
            </span>
            <span v-if="user.reportingDisabled" class="badge badge-warning ml-1">
              {{ i18n.t('admin.reporting_disabled_state') }}
            </span>
            <span v-if="user.commentsDisabled" class="badge badge-warning ml-1">
              {{ i18n.t('admin.comments_disabled_state') }}
            </span>
          </td>
          <td>{{ i18n.n(user.score) }}</td>
          <td>{{ i18n.n(user.playerCount) }}</td>
          <td>
            <div class="flex gap-1">
              <AppButton v-if="canEdit(user)" class="btn-sm" @click="edit(user)">
                {{ i18n.t('common.edit') }}
              </AppButton>
              <AppButton
                v-if="canEdit(user)"
                class="btn-icon btn-sm"
                :aria-label="i18n.t('admin.sessions')"
                @click="showSessions(user)"
              >
                <AppIcon name="devices" />
              </AppButton>
              <AppButton
                class="btn-icon btn-sm"
                :aria-label="i18n.t('admin.closet_manage')"
                @click="showCloset(user)"
              >
                <AppIcon name="checkroom" />
              </AppButton>
              <AppButton
                v-if="canEdit(user)"
                class="btn-icon btn-sm"
                :aria-label="i18n.t('admin.password_reset')"
                @click="resetPassword(user)"
              >
                <AppIcon name="key" />
              </AppButton>
              <AppButton
                v-if="canEdit(user)"
                class="btn-icon btn-sm text-danger"
                :aria-label="i18n.t('admin.delete_user')"
                @click="remove(user)"
              >
                <AppIcon name="delete_outline" />
              </AppButton>
            </div>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="7" class="text-center text-muted">{{ i18n.t('general.noResult') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <AppPagination v-model="page" :total-pages="totalPages" :busy="loading" />
  <AppDialog
    v-model="open"
    :title="i18n.t(editing ? 'admin.user_edit' : 'admin.create_user')"
    :busy="busy"
  >
    <AppForm class="space-y-4" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label for="admin-email" class="block mb-1">{{ i18n.t('general.email') }}</label>
          <AppInput id="admin-email" v-model="form.email" type="email" required />
        </div>
        <div>
          <label for="admin-nickname" class="block mb-1">{{ i18n.t('general.nickname') }}</label>
          <AppInput
            id="admin-nickname"
            v-model="form.nickname"
            maxlength="50"
            required
          />
        </div>
      </div>
      <div v-if="!editing">
        <label for="admin-password" class="block mb-1">
          {{ i18n.t('admin.user_created_password') }}
        </label>
        <AppInput
          id="admin-password"
          v-model="form.password"
          type="password"
          minlength="8"
          maxlength="32"
          autocomplete="new-password"
          required
        />
      </div>
      <div v-else>
        <label for="admin-score" class="block mb-1">{{ i18n.t('general.score') }}</label>
        <AppNumberField id="admin-score" v-model="form.score" :step="1" required />
      </div>
      <div>
        <label for="admin-role" class="block mb-1">{{ i18n.t('user.role') }}</label>
        <AppSelect id="admin-role" v-model="form.role" :options="[{ value: 'normal', label: i18n.t('admin.role_normal') }, { value: 'banned', label: i18n.t('admin.role_banned') }, ...(session.user.value?.role === 'super_admin' ? [{ value: 'admin', label: i18n.t('admin.role_admin') }] : [])]" />
      </div>
      <div v-if="editing" class="flex items-center gap-2"><AppCheckbox v-model="form.emailVerified" :label="i18n.t('admin.verified')" /><span>{{ i18n.t('admin.verified') }}</span></div>
      <div v-if="editing" class="flex items-center gap-2"><AppCheckbox v-model="form.reportingDisabled" :label="i18n.t('admin.reporting_disabled')" /><span>{{ i18n.t('admin.reporting_disabled') }}</span></div>
      <div v-if="editing" class="flex items-center gap-2"><AppCheckbox v-model="form.commentsDisabled" :label="i18n.t('admin.comments_disabled')" /><span>{{ i18n.t('admin.comments_disabled') }}</span></div>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <div class="flex justify-end">
        <AppButton type="submit" class="btn-primary" :loading="busy">
          {{ i18n.t('common.save') }}
        </AppButton>
      </div>
    </AppForm>
  </AppDialog>
  <AppDialog v-model="sessionsOpen" :title="i18n.t('admin.sessions_title')" :busy="busy">
    <p v-if="error" class="alert alert-danger">{{ error }}</p>
    <p v-if="busy">{{ i18n.t('common.loading') }}</p>
    <div v-for="s in sessions" :key="s.id" class="border-b border-line py-3 text-xs">
      <p class="font-medium">{{ s.ip || i18n.t('common.none') }}</p>
      <p class="text-muted break-all mt-1">{{ s.userAgent || i18n.t('common.none') }}</p>
      <p class="mt-1">{{ i18n.t('admin.sessions_last_seen') }} · {{ i18n.d(s.lastSeenAt) }}</p>
    </div>
    <p v-if="!sessions.length && !busy" class="text-muted py-5">
      {{ i18n.t('admin.sessions_empty') }}
    </p>
    <AppButton v-if="sessions.length" class="btn-danger mt-4" :loading="busy" @click="revoke">
      {{ i18n.t('admin.revoke_sessions') }}
    </AppButton>
  </AppDialog>
  <AppDialog v-model="closetOpen" :title="i18n.t('admin.closet_manage')" :busy="busy">
    <p v-if="error" class="alert alert-danger">{{ error }}</p>
    <AppForm class="flex gap-2 mb-3" @submit.prevent="addCloset">
      <AppNumberField v-model="textureId" :min="1" :aria-label="i18n.t('admin.texture_id')" :placeholder="i18n.t('admin.texture_id')" required />
      <AppButton type="submit" class="btn-primary" :loading="busy">
        {{ i18n.t('skinlib.addToCloset') }}
      </AppButton>
    </AppForm>
    <div
      v-for="entry in closet"
      :key="entry.textureId"
      class="flex items-center justify-between gap-2 py-2 border-b border-line"
    >
      <router-link :to="`/skinlib/${entry.textureId}`" class="truncate text-sm">
        {{ entry.itemName || entry.textureName }}
      </router-link>
      <AppButton
        class="btn-icon text-danger"
        :disabled="busy"
        :aria-label="i18n.t('user.removeItem')"
        @click="removeCloset(entry)"
      >
        <AppIcon name="delete_outline" />
      </AppButton>
    </div>
    <p v-if="!closet.length && !busy" class="text-muted py-5">
      {{ i18n.t('user.emptyClosetMsg') }}
    </p>
    <AppPagination v-model="closetPage" :total-pages="closetPages" :busy="busy" />
  </AppDialog>
  <AppDialog v-model="passwordOpen" :title="i18n.t('admin.password_temporary')">
    <code class="block p-4 bg-surface-2 break-all">{{ temporaryPassword }}</code>
  </AppDialog>
</template>
