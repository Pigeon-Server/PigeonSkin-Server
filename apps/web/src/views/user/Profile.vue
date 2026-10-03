<script setup lang="ts">
import { LOCALE_OPTIONS, normalizeLocale, type Locale } from '@pigeon-skin/shared/locales';
import AccountSecurity from '@/components/AccountSecurity.vue';
import { computed, onMounted, ref, watch } from 'vue';
import {
  api,
  meApi,
  closetApi,
  oauthApi,
  mojangApi,
  type TextureSummary,
  type OAuthBinding,
  type OAuthProvider,
  type MojangStatus,
} from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useRouter, useRoute } from 'vue-router';
import { isErrorCode } from '@pigeon-skin/shared';
import { confirmAction } from '@/stores/dialog';
import { useTheme } from '@/composables/theme';
import AvatarPreview from '@/components/AvatarPreview.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { apiErrorMessage } from '@/lib/api-error';

const session = useSessionStore();
const i18n = useI18n();

const router = useRouter();
const route = useRoute();
const theme = useTheme();
const email = ref('');
const preferredLocale = ref<Locale>('zh_CN');
const profileBusy = ref(false);
const passwordBusy = ref(false);
const nickname = ref('');
const signature = ref('');
const oldPassword = ref('');
const newPassword = ref('');
const newPassword2 = ref('');
const myTextures = ref<Array<Pick<TextureSummary, 'id' | 'hash' | 'name'>>>([]);
const avatarPage = ref(1);
const avatarKeyword = ref('');
const filteredAvatars = computed(() =>
  myTextures.value.filter((item) =>
    item.name.toLowerCase().includes(avatarKeyword.value.toLowerCase()),
  ),
);
const avatarPages = computed(() => Math.ceil(filteredAvatars.value.length / 18));
const visibleAvatars = computed(() =>
  filteredAvatars.value.slice((avatarPage.value - 1) * 18, avatarPage.value * 18),
);
watch(avatarKeyword, () => {
  avatarPage.value = 1;
});
const profileErr = ref('');
const profileNotice = ref('');
const pwdErr = ref('');
const pwdNotice = ref('');

const oauthBindings = ref<OAuthBinding[]>([]);
const oauthAvailable = ref<OAuthProvider[]>([]);
const oauthBusy = ref('');
const hasPassword = ref(true);
const oauthNotice = ref(route.query.oauth_success === '1' ? i18n.t('oauth.linked') : '');
const oauthCallbackError = String(route.query.oauth_error || '');
const oauthErr = ref(isErrorCode(oauthCallbackError) ? i18n.t(oauthCallbackError) : '');
const oauthLoading = ref(true);
const mojangLoading = ref(true);
const avatarLoading = ref(true);
const avatarErr = ref('');

const mojang = ref<MojangStatus | null>(null);
const mojangCallbackError = String(route.query.mojang_error || '');
const mojangErr = ref(isErrorCode(mojangCallbackError) ? i18n.t(mojangCallbackError) : '');
const mojangNotice = ref('');
const mojangBusy = ref(false);
const needsMojangRefresh = ref(false);

const user = computed(() => session.user.value);
watch(() => user.value?.email, value => { if (value) email.value = value; });
watch(i18n.locale, (value) => {
  preferredLocale.value = value as Locale;
});

/** 已绑定提供商的 id 集合 */
const boundProviders = computed(() => new Set(oauthBindings.value.map((b) => b.provider)));
const oauthProviders = computed(() => [
  ...oauthAvailable.value,
  ...oauthBindings.value
    .filter((binding) => !oauthAvailable.value.some((provider) => provider.id === binding.provider))
    .map((binding) => ({ id: binding.provider, displayName: binding.provider })),
]);

onMounted(async () => {
  nickname.value = user.value?.nickname ?? '';
  email.value = user.value?.email ?? '';
  preferredLocale.value =
    normalizeLocale(user.value?.locale || i18n.locale.value);
  signature.value = user.value?.signature ?? '';
  void loadAvatars();
  void loadOauth(!!oauthCallbackError);
  void loadMojang(!!mojangCallbackError);
});

async function loadAvatars() {
  avatarLoading.value = true;
  avatarErr.value = '';
  try {
    const data = await closetApi.list({ category: 'skin' });
    myTextures.value = data.items.map((item) => ({
      id: item.textureId,
      hash: item.hash,
      name: item.itemName || item.textureName,
    }));
  } catch (e) {
    avatarErr.value = apiErrorMessage(e);
  } finally {
    avatarLoading.value = false;
  }
}
async function sendVerification() {
  if (profileBusy.value || email.value !== user.value?.email) return;
  profileBusy.value = true;
  profileErr.value = '';
  profileNotice.value = '';
  try {
    const result = await api.verifyEmailRequest();
    if (result.ok) profileNotice.value = i18n.t('user.verification.success');
    else profileErr.value = i18n.t('auth.mail_unavailable');
  } catch (e) {
    profileErr.value = apiErrorMessage(e);
  } finally {
    profileBusy.value = false;
  }
}
async function loadOauth(preserveError = false) {
  if (!user.value) return;
  oauthLoading.value = true;
  if (!preserveError) oauthErr.value = '';
  try {
    const data = await oauthApi.my();
    oauthBindings.value = data.bindings;
    oauthAvailable.value = data.available;
    hasPassword.value = data.hasPassword;
  } catch (e) {
    oauthErr.value = apiErrorMessage(e);
  } finally {
    oauthLoading.value = false;
  }
}

async function loadMojang(preserveError = false) {
  if (!user.value) return;
  mojangLoading.value = true;
  if (!preserveError) mojangErr.value = '';
  try {
    mojang.value = await mojangApi.status();
  } catch (e) {
    mojangErr.value = apiErrorMessage(e);
  } finally {
    mojangLoading.value = false;
  }
}

async function saveProfile() {
  if (profileBusy.value) return;
  profileErr.value = '';
  profileNotice.value = '';
  profileBusy.value = true;
  try {
    const result = await meApi.patchProfile({
      nickname: nickname.value,
      locale: preferredLocale.value,
      isDarkMode: theme.isDark.value,
      signature: signature.value,
    });
    profileNotice.value = i18n.t(result.emailChanged ? 'user.email_changed' : 'general.op-success');
    await i18n.setLocale(preferredLocale.value);
    await session.fetchSession();
  } catch (e) {
    profileErr.value = apiErrorMessage(e);
  } finally {
    profileBusy.value = false;
  }
}

async function changePassword() {
  if (passwordBusy.value) return;
  pwdErr.value = '';
  pwdNotice.value = '';
  if (newPassword.value !== newPassword2.value) {
    pwdErr.value = i18n.t('auth.password_mismatch');
    return;
  }
  passwordBusy.value = true;
  try {
    await meApi.changePassword(oldPassword.value, newPassword.value);
    pwdNotice.value = i18n.t('settings.password_ok');
    oldPassword.value = newPassword.value = newPassword2.value = '';
    hasPassword.value = true;
  } catch (e) {
    pwdErr.value = apiErrorMessage(e);
  } finally {
    passwordBusy.value = false;
  }
}

async function setAvatar(textureId: number) {
  if (profileBusy.value) return;
  profileBusy.value = true;
  try {
    await meApi.setAvatar(textureId);
    await session.fetchSession();
  } catch (e) {
    profileErr.value = apiErrorMessage(e);
  } finally {
    profileBusy.value = false;
  }
}

async function unbindProvider(provider: string) {
  oauthErr.value = '';
  oauthBusy.value = provider;
  try {
    await oauthApi.unbind(provider);
    await loadOauth();
  } catch (e) {
    oauthErr.value = apiErrorMessage(e);
  } finally {
    oauthBusy.value = '';
  }
}

async function unbindMojang() {
  mojangErr.value = '';
  mojangNotice.value = '';
  mojangBusy.value = true;
  try {
    await mojangApi.unbind();
    await loadMojang();
  } catch (e) {
    mojangErr.value = apiErrorMessage(e);
  } finally {
    mojangBusy.value = false;
  }
}

async function updateMojangUuid() {
  mojangErr.value = '';
  mojangNotice.value = '';
  mojangBusy.value = true;
  try {
    const result = await mojangApi.updateUuid();
    needsMojangRefresh.value = result.needsReverify;
    if (result.needsReverify) mojangErr.value = i18n.t('integration.mojang.needs_reverify');
    else mojangNotice.value = i18n.t('settings.mojang_update_ok', { name: result.name });
  } catch (e) {
    mojangErr.value = apiErrorMessage(e);
  } finally {
    mojangBusy.value = false;
  }
}
async function deleteAccount() {
  if (!(await confirmAction(i18n.t('user.delete_confirm')))) return;
  profileBusy.value = true;
  try {
    await meApi.deleteAccount();
    await session.fetchSession();
    await router.push('/');
  } catch (e) {
    profileErr.value = apiErrorMessage(e);
  } finally {
    profileBusy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-4" v-if="user">
    <PageHeader :title="i18n.t('general.profile')" />

    <AppForm class="panel" @submit.prevent="saveProfile">
      <h2 class="font-semibold">{{ i18n.t('settings.profile') }}</h2>
      <div class="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm font-medium" for="p-nick">
            {{ i18n.t('general.nickname') }}
          </label>
          <AppInput id="p-nick" v-model="nickname" maxlength="50" required />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="p-email">
            {{ i18n.t('general.email') }}
          </label>
          <AppInput id="p-email" v-model="email" type="email" required disabled />
          <p class="mt-1 text-xs text-muted">{{ i18n.t('security.email_change_required') }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <span class="badge" :class="user.emailVerified ? 'badge-success' : 'badge-default'">
              {{ i18n.t(user.emailVerified ? 'admin.verified' : 'admin.unverified') }}
            </span>
            <AppButton
              v-if="!user.emailVerified"
              class="btn-sm"
              :loading="profileBusy"
              :disabled="email !== user.email"
              @click="sendVerification"
            >
              {{ i18n.t('user.verification.send_ext') }}
            </AppButton>
          </div>
        </div>
        <div class="sm:col-span-2">
          <label class="mb-1 block text-sm font-medium" for="p-sign">
            {{ i18n.t('settings.signature') }}
          </label>
          <AppInput id="p-sign" v-model="signature" multiline class="h-24" maxlength="500" />
          <p class="mt-1 text-xs text-muted">
            {{ i18n.t('common.characters', { count: i18n.n(signature.length), max: i18n.n(500) }) }}
          </p>
        </div>
      </div>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm" for="profile-language">
            {{ i18n.t('common.language') }}
          </label>
          <AppSelect id="profile-language" v-model="preferredLocale" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" :aria-label="i18n.t('common.language')" />
        </div>
        <div class="flex items-center gap-2"><AppSwitch :model-value="theme.isDark.value" :label="i18n.t('user.theme_dark')" @update:model-value="theme.toggle" /><span>{{ i18n.t('user.theme_dark') }}</span></div>
      </div>
      <AppButton class="btn btn-primary mt-3" :loading="profileBusy" type="submit">
        {{ i18n.t('common.save') }}
      </AppButton>
      <p v-if="profileNotice" class="alert alert-success mt-3">{{ profileNotice }}</p>
      <p v-if="profileErr" class="alert alert-danger mt-3" role="alert">{{ profileErr }}</p>
    </AppForm>

    <AccountSecurity />

    <div class="rounded-xl border border-line bg-surface p-5">
      <AppForm @submit.prevent="changePassword">
        <h2 class="font-semibold">{{ i18n.t(hasPassword ? 'settings.change_password' : 'oauth.set_password') }}</h2>
        <div class="mt-3 grid gap-4 sm:grid-cols-3">
          <div v-if="hasPassword">
            <label class="mb-1 block text-sm font-medium" for="cp-old">
              {{ i18n.t('settings.old_password') }}
            </label>
            <AppInput
              id="cp-old"
              v-model="oldPassword"
              type="password"
              required
              autocomplete="current-password"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium" for="cp-new">
              {{ i18n.t('settings.new_password') }}
            </label>
            <AppInput
              id="cp-new"
              v-model="newPassword"
              type="password"
              required
              minlength="8"
              maxlength="32"
              autocomplete="new-password"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium" for="cp-new2">
              {{ i18n.t('auth.repeat-pwd') }}
            </label>
            <AppInput
              id="cp-new2"
              v-model="newPassword2"
              type="password"
              required
              autocomplete="new-password"
            />
          </div>
        </div>
        <AppButton class="btn btn-primary mt-3" :loading="passwordBusy" type="submit">
          {{ i18n.t('settings.change_password') }}
        </AppButton>
        <p v-if="pwdNotice" class="alert alert-success mt-3">{{ pwdNotice }}</p>
        <p v-if="pwdErr" class="alert alert-danger mt-3">{{ pwdErr }}</p>
      </AppForm>
    </div>

    <div class="rounded-xl border border-line bg-surface p-5">
      <h2 class="font-semibold">{{ i18n.t('settings.oauth') }}</h2>
      <p v-if="oauthNotice" class="alert alert-success mt-3" role="status">{{ oauthNotice }}</p>
      <p v-if="oauthErr" class="alert alert-danger mt-3">
        {{ oauthErr }}
        <AppButton class="btn-sm ml-2" @click="loadOauth()">{{ i18n.t('common.retry') }}</AppButton>
      </p>
      <p v-if="oauthLoading" class="mt-3 text-sm text-muted" role="status">
        {{ i18n.t('common.loading') }}
      </p>
      <div v-else class="mt-3 space-y-2">
        <div
          v-for="p in oauthProviders"
          :key="p.id"
          class="flex items-center justify-between rounded-lg border border-line px-3 py-2"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium">{{ p.displayName }}</span>
            <span v-if="boundProviders.has(p.id)" class="badge badge-success">
              {{ i18n.t('settings.oauth_bound') }}
            </span>
            <span v-else class="badge badge-default">{{ i18n.t('settings.oauth_unbound') }}</span>
          </div>
          <AppButton
            v-if="boundProviders.has(p.id)"
            class="btn btn-sm btn-danger"
            :disabled="oauthBusy === p.id"
            @click="unbindProvider(p.id)"
          >
            {{ i18n.t('settings.oauth_unbind') }}
          </AppButton>
          <a v-else class="btn btn-sm" :href="`/auth/oauth/${p.id}`">
            {{ i18n.t('settings.oauth_bind') }}
          </a>
        </div>
        <p v-if="oauthProviders.length === 0 && !oauthErr" class="text-sm text-muted">
          {{ i18n.t('settings.oauth_unavailable') }}
        </p>
      </div>
    </div>

    <div class="rounded-xl border border-line bg-surface p-5">
      <h2 class="font-semibold">{{ i18n.t('settings.mojang') }}</h2>
      <p v-if="mojangErr" class="alert alert-danger mt-3">
        {{ mojangErr }}
        <a v-if="needsMojangRefresh" class="btn btn-sm ml-2" href="/mojang/verify?refresh=true">
          {{ i18n.t('integration.mojang.reverify') }}
        </a>
        <AppButton class="btn-sm ml-2" @click="loadMojang()">
          {{ i18n.t('common.retry') }}
        </AppButton>
      </p>
      <p v-if="mojangNotice" class="alert alert-success mt-3">{{ mojangNotice }}</p>

      <p v-if="mojangLoading" class="mt-3 text-sm text-muted" role="status">
        {{ i18n.t('common.loading') }}
      </p>
      <template v-else-if="mojang?.verified">
        <span class="badge badge-success mt-3">{{ i18n.t('integration.mojang.badge') }}</span>
        <dl class="mt-3 space-y-1 text-sm">
          <div class="flex justify-between">
            <dt class="text-muted">{{ i18n.t('settings.mojang_uuid') }}</dt>
            <dd class="font-mono">{{ mojang.verified.uuid }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">{{ i18n.t('settings.mojang_verified_at') }}</dt>
            <dd>{{ i18n.d(mojang.verified.createdAt) }}</dd>
          </div>
        </dl>
        <div class="mt-3 flex gap-2">
          <AppButton class="btn btn-primary" :disabled="mojangBusy" @click="updateMojangUuid">
            {{ i18n.t('settings.mojang_update_uuid') }}
          </AppButton>
          <AppButton class="btn btn-danger" :disabled="mojangBusy" @click="unbindMojang">
            {{ i18n.t('settings.mojang_unbind') }}
          </AppButton>
        </div>
      </template>
      <template v-else-if="!mojangErr">
        <p class="mt-3 text-sm text-muted">{{ i18n.t('settings.mojang_none') }}</p>
        <p class="mt-2 text-sm text-muted">{{ i18n.t('integration.mojang.verify_notice') }}</p>
        <a v-if="mojang?.available" class="btn btn-primary mt-3 inline-block" href="/mojang/verify">
          {{ i18n.t('settings.mojang_go_verify') }}
        </a>
        <p v-else-if="mojang" class="mt-3 text-sm text-muted">
          {{ i18n.t('settings.mojang_unavailable') }}
        </p>
      </template>
    </div>

    <div class="rounded-xl border border-line bg-surface p-5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-3">
          <UserAvatar :texture-id="user.avatarTextureId" :user-id="user.id" :name="user.nickname" class="h-9 w-9 rounded" />
          <h2 class="font-semibold">{{ i18n.t('user.setAsAvatar') }}</h2>
        </div>
        <AppButton class="btn-sm inline-flex items-center gap-2" :disabled="profileBusy" @click="setAvatar(0)">
          <AvatarPreview :user-id="user.id" name="" class="h-5 w-5" />
          {{ i18n.t('user.default_avatar') }}
        </AppButton>
      </div>
      <p class="mt-1 text-sm text-muted">{{ i18n.t('settings.avatar_pick') }}</p>
      <AppInput
        v-if="myTextures.length > 18"
        v-model="avatarKeyword"
        type="search"
        class="mt-3"
        :aria-label="i18n.t('settings.avatar')"
        :placeholder="i18n.t('general.search')"
      />
      <p v-if="avatarErr" class="mt-3 text-xs text-danger" role="alert">
        {{ avatarErr }}
        <AppButton class="btn-sm ml-2" @click="loadAvatars">{{ i18n.t('common.retry') }}</AppButton>
      </p>
      <p v-if="avatarLoading" class="mt-3 text-sm text-muted" role="status">
        {{ i18n.t('common.loading') }}
      </p>
      <div v-else class="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6">
        <AppButton
          class="rounded-lg border p-1"
          :class="user.avatarTextureId === t.id ? 'border-brand-500 ring-2 ring-brand-400' : 'border-line'"
          v-for="t in visibleAvatars"
          :key="t.id"
          :disabled="profileBusy"
          @click="setAvatar(t.id)"
        >
          <AvatarPreview :hash="t.hash" :name="t.name" class="h-full w-full object-contain" />
        </AppButton>
        <p
          v-if="visibleAvatars.length === 0 && !avatarErr"
          class="col-span-full py-4 text-center text-sm text-muted"
        >
          {{ i18n.t(avatarKeyword ? 'general.noResult' : 'user.no_textures_ext') }}
        </p>
      </div>
    </div>
    <AppPagination v-model="avatarPage" :total-pages="avatarPages" />
    <section v-if="!session.isAdmin.value" class="panel !border-red-200">
      <h2 class="font-semibold text-danger">{{ i18n.t('user.delete_account') }}</h2>
      <p class="mt-2 text-sm text-muted">{{ i18n.t('user.delete_warning') }}</p>
      <AppButton class="btn-danger mt-4" :loading="profileBusy" @click="deleteAccount">
        {{ i18n.t('user.delete_account') }}
      </AppButton>
    </section>
  </div>
</template>
