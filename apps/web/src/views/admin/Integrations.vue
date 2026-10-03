<script setup lang="ts">
import { LOCALE_OPTIONS, normalizeLocale, type Locale } from '@pigeon-skin/shared/locales';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi, type IntegrationStatus } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useSiteSettings } from '@/stores/site';
import { confirmAction } from '@/stores/dialog';
import { integrationModules } from '@/lib/integrations';
import { generateSigningKey } from '@/lib/signing-key';
import SettingField from '@/components/SettingField.vue';
import CopyField from '@/components/ui/CopyField.vue';
import SearchSubmissionPanel from '@/components/SearchSubmissionPanel.vue';
import OfficialResourcePanel from '@/components/OfficialResourcePanel.vue';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
const session = useSessionStore();
const site = useSiteSettings();
const route = useRoute();
const router = useRouter();
const data = ref<Awaited<ReturnType<typeof adminApi.getSettings>> | null>(null);
const status = ref<IntegrationStatus | null>(null);
const edits = ref<Record<string, string>>({});
const generatorLocale = ref<Locale>(normalizeLocale(i18n.locale.value));
let pendingLocale: Locale | undefined;
const loading = ref(true);
const busy = ref(false);
const generating = ref(false);
const error = ref('');
const notice = ref('');
const active = computed(
  () =>
    integrationModules.find((module) => module.id === route.query.module) || integrationModules[0],
);
const keys = computed(() => active.value.keys.filter((key) => !!data.value?.specs[key] && (!data.value.specs[key]!.superAdminOnly || session.user.value?.role === 'super_admin')));
const changed = computed(() =>
  [
    ...keys.value,
    ...(active.value.id === 'yggdrasil' && session.user.value?.role === 'super_admin'
      ? ['ygg_private_key']
      : []),
  ].filter((key) => edits.value[key] !== data.value?.values[key]),
);
const busyAll = computed(() => busy.value || generating.value);
watch(
  () => active.value.id,
  () => {
    error.value = '';
    notice.value = '';
  },
);
function flushLocale() {
  if (busyAll.value || loading.value || !pendingLocale) return;
  const next = pendingLocale;
  pendingLocale = undefined;
  void changeGeneratorLocale(next);
}
async function changeGeneratorLocale(next: Locale) {
  if (next === generatorLocale.value) return;
  if (active.value.id !== 'generator') { generatorLocale.value = next; return; }
  if (busyAll.value || loading.value) { pendingLocale = next; return; }
  if (changed.value.length && !await confirmAction(i18n.t('integration.unsaved'))) return;
  generatorLocale.value = next;
  await load();
}
async function selectGeneratorLocale(value: string | number | null) {
  const next = normalizeLocale(String(value ?? ''));
  await changeGeneratorLocale(next);
}
watch(i18n.locale, value => { void changeGeneratorLocale(normalizeLocale(value)); });
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [settings, state] = await Promise.all([adminApi.getSettings(active.value.id === 'generator' ? generatorLocale.value : undefined), adminApi.integrations()]);
    data.value = settings;
    status.value = state;
    edits.value = { ...settings.values };
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false; flushLocale();
  }
}
async function select(module: string) {
  if (busyAll.value) return;
  if (changed.value.length && !(await confirmAction(i18n.t('integration.unsaved')))) return;
  if (data.value) edits.value = { ...data.value.values };
  await router.replace({ query: { module } });
  await load();
}
async function save() {
  if (busyAll.value || !changed.value.length) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const reloadPage = changed.value.some((key) => ['gtag_id', 'adsense_client_id'].includes(key));
  try {
    await adminApi.patchSettings(
      changed.value.map((key) => ({
        key,
        value:
          data.value?.specs[key]?.kind === 'integer'
            ? Number(edits.value[key])
            : edits.value[key] || '',
        ...(data.value?.specs[key]?.localizable ? { locale: generatorLocale.value } : {}),
      })),
    );
    await load();
    await site.fetch(true);
    notice.value = i18n.t('admin.setting_saved');
    if (reloadPage) location.reload();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false; flushLocale();
  }
}
async function generateKey() {
  if (busyAll.value) return;
  if (
    edits.value.ygg_private_key &&
    !(await confirmAction(i18n.t('integration.yggdrasil.replace_key')))
  )
    return;
  generating.value = true;
  error.value = '';
  notice.value = '';
  try {
    edits.value.ygg_private_key = await generateSigningKey();
    notice.value = i18n.t('integration.yggdrasil.generated');
  } catch {
    error.value = i18n.t('integration.yggdrasil.generate_failed');
  } finally {
    generating.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('integration.title')">
    <AppSelect v-if="active.id === 'generator'" :model-value="generatorLocale" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" :disabled="busyAll || loading" class="!w-auto" :aria-label="i18n.t('admin.localized')" @change="selectGeneratorLocale" />
    <AppButton :loading="loading" :disabled="busyAll" @click="load">
      <AppIcon name="refresh" />
      {{ i18n.t('common.refresh') }}
    </AppButton>
  </PageHeader>
  <div class="grid items-start gap-4 xl:grid-cols-[208px_minmax(0,1fr)]">
    <nav class="integration-nav" :aria-label="i18n.t('integration.title')">
      <AppButton
        v-for="module in integrationModules"
        :key="module.id"
        :class="{ selected: active.id === module.id }"
        :disabled="busyAll"
        @click="select(module.id)"
      >
        <AppIcon :name="module.icon" />
        {{ i18n.t(`integration.modules.${module.id}`) }}
      </AppButton>
    </nav>
    <div class="min-w-0 space-y-4">
      <p v-if="error" class="alert alert-danger" role="alert">
        {{ error }}
        <AppButton v-if="!data" class="btn-sm ml-2" @click="load">
          {{ i18n.t('common.retry') }}
        </AppButton>
      </p>
      <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
      <AppSkeleton v-if="loading" :count="3" />
      <template v-else-if="data && status">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg font-semibold">{{ i18n.t(`integration.modules.${active.id}`) }}</h2>
          <AppButton
            v-if="keys.length || active.id === 'yggdrasil'"
            class="btn-primary"
            :loading="busy"
            :disabled="!changed.length || generating"
            @click="save"
          >
            <AppIcon name="save" />
            {{ i18n.t('common.save') }}
          </AppButton>
        </header>
        <section v-if="active.id === 'pigeon' || active.id === 'votes'" class="panel">
          <router-link :to="active.id === 'pigeon' ? '/admin/pigeon-api' : '/admin/votes'" class="btn">{{ i18n.t(active.id === 'pigeon' ? 'pigeon.title' : 'votes.management') }}</router-link>
        </section>
        <SearchSubmissionPanel v-if="active.id === 'search'" :key="notice" />
        <OfficialResourcePanel v-if="active.id === 'resources'" :key="notice" />
        <section v-if="active.id === 'oauth'" class="space-y-3">
          <router-link to="/admin/integrations/connect" class="btn">{{ i18n.t('oauth.server_title') }}</router-link>
          <p class="text-sm text-muted">{{ i18n.t('integration.oauth.help') }}</p>
          <article v-for="provider in status.providers" :key="provider.id" class="panel space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-semibold">{{ i18n.t(`integration.providers.${provider.id}`) }}</h3>
              <span class="badge" :class="provider.configured ? 'badge-success' : 'badge-default'">
                {{ i18n.t(provider.configured ? 'integration.configured' : 'integration.not_configured') }}
              </span>
            </div>
            <CopyField
              :label="i18n.t('integration.oauth.callback')"
              :value="provider.callbackUrl"
            />
          </article>
        </section>
        <section v-if="active.id === 'mojang'" class="panel space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="font-semibold">{{ i18n.t('integration.mojang.application') }}</h3>
            <span
              class="badge"
              :class="status.mojang.configured ? 'badge-success' : 'badge-default'"
            >
              {{ i18n.t(status.mojang.configured ? 'integration.configured' : 'integration.not_configured') }}
            </span>
          </div>
          <p class="text-sm text-muted">
            {{ i18n.t(status.mojang.usesMicrosoft ? 'integration.mojang.microsoft_credentials' : 'integration.mojang.independent_credentials') }}
          </p>
          <CopyField
            :label="i18n.t('integration.oauth.callback')"
            :value="status.mojang.callbackUrl"
          />
          <router-link to="/profile" class="btn btn-sm">
            <AppIcon name="verified_user" />
            {{ i18n.t('settings.mojang') }}
          </router-link>
        </section>
        <section v-if="active.id === 'yggdrasil'" class="panel space-y-3">
          <router-link to="/admin/integrations/connect" class="btn">{{ i18n.t('oauth.server_title') }}</router-link>
          <CopyField
            :label="i18n.t('integration.yggdrasil.api_root')"
            :value="status.apiRoot"
            :draggable="true"
          />
          <div class="flex flex-wrap gap-2">
            <router-link to="/user" class="btn btn-sm">
              <AppIcon name="sports_esports" />
              {{ i18n.t('integration.launcher.title') }}
            </router-link>
            <router-link to="/admin/integrations/yggdrasil/logs" class="btn btn-sm">
              <AppIcon name="history" />
              {{ i18n.t('integration.yggdrasil.logs') }}
            </router-link>
          </div>
        </section>
        <div
          :class="active.id === 'yggdrasil' ? 'grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.8fr)]' : ''"
        >
          <AppForm v-if="keys.length" class="panel" @submit.prevent="save">
            <fieldset :disabled="busyAll" class="min-w-0">
              <div
                v-for="key in keys"
                :key="key"
                class="grid gap-3 border-b border-line py-4 last:border-0 md:grid-cols-[minmax(180px,1fr)_2fr]"
              >
                <label :for="`setting-${key}`" class="text-sm font-medium">
                  {{ i18n.t(`admin.setting.${key}`) }}
                </label>
                <div class="min-w-0">
                  <SettingField v-model="edits[key]" :name="key" :spec="data.specs[key]!" />
                  <p class="mt-2 text-xs text-muted">{{ i18n.t(`integration.help.${key}`) }}</p>
                </div>
              </div>
            </fieldset>
          </AppForm>
          <section v-if="active.id === 'yggdrasil'" class="panel space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-semibold">{{ i18n.t('integration.yggdrasil.keypair') }}</h3>
              <span
                class="badge"
                :class="status.signingKey.valid ? 'badge-success' : status.signingKey.configured ? 'badge-danger' : 'badge-default'"
              >
                {{ i18n.t(status.signingKey.valid ? 'integration.yggdrasil.valid' : status.signingKey.configured ? 'integration.yggdrasil.invalid' : 'integration.not_configured') }}
              </span>
            </div>
            <template v-if="session.user.value?.role === 'super_admin'">
              <label for="signing-key" class="block text-xs text-muted">
                {{ i18n.t('admin.setting.ygg_private_key') }}
              </label>
              <AppInput
                id="signing-key"
                v-model="edits.ygg_private_key"
                :disabled="busyAll"
                multiline
                class="min-h-40 font-mono text-xs"
              />
              <div class="flex flex-wrap gap-2">
                <AppButton :loading="generating" :disabled="busy" @click="generateKey">
                  <AppIcon name="key" />
                  {{ i18n.t('integration.yggdrasil.generate') }}
                </AppButton>
                <AppButton
                  class="btn-primary"
                  :disabled="!changed.length || generating"
                  :loading="busy"
                  @click="save"
                >
                  {{ i18n.t('common.save') }}
                </AppButton>
              </div>
              <p class="text-xs text-muted">{{ i18n.t('integration.yggdrasil.key_hint') }}</p>
            </template>
            <p v-else class="text-sm text-muted">
              {{ i18n.t('integration.yggdrasil.super_admin') }}
            </p>
            <CopyField
              v-if="status.signingKey.publicKey"
              :label="i18n.t('integration.yggdrasil.public_key')"
              :value="status.signingKey.publicKey"
            />
            <div v-if="status.signingKey.fingerprint">
              <p class="text-xs text-muted">{{ i18n.t('integration.yggdrasil.fingerprint') }}</p>
              <code class="block break-all mt-1 text-xs">{{ status.signingKey.fingerprint }}</code>
            </div>
          </section>
        </div>
        <div v-if="active.id === 'description'" class="flex flex-wrap gap-2">
          <router-link to="/skinlib/upload" class="btn">
            <AppIcon name="upload_file" />
            {{ i18n.t('skinlib.upload.title') }}
          </router-link>
          <router-link to="/skinlib" class="btn">{{ i18n.t('general.skinlib') }}</router-link>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.integration-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.integration-nav :deep(.btn) {
  justify-content: flex-start;
  font-size: 12px;
}
.integration-nav :deep(.selected) {
  color: var(--brand);
  background: var(--brand-soft);
  border-color: var(--brand);
}
@media (min-width: 1280px) {
  .integration-nav {
    flex-direction: column;
    position: sticky;
    top: 74px;
  }
  .integration-nav :deep(.btn) {
    padding: 9px 12px;
    width: 100%;
  }
}
</style>
