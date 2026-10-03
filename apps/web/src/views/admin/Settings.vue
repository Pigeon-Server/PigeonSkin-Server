<script setup lang="ts">
import { LOCALE_OPTIONS, normalizeLocale } from '@pigeon-skin/shared/locales';
import { computed, onMounted, ref, watch } from 'vue';
import { adminApi } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import SettingField from '@/components/SettingField.vue';
import { integrationModules } from '@/lib/integrations';
import { useRoute, onBeforeRouteLeave } from 'vue-router';
import { confirmAction } from '@/stores/dialog';
import { decodeLegacyContent } from '@/lib/content';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
const session = useSessionStore();
const site = useSiteSettings();
type Data = Awaited<ReturnType<typeof adminApi.getSettings>>;
const data = ref<Data | null>(null);
const edits = ref<Record<string, string>>({});
const locale = ref<string>(normalizeLocale(i18n.locale.value));
let pendingLocale: string | undefined;
const route = useRoute();
const tab = ref(
  route.path.endsWith('/score')
    ? 'score'
    : route.path.endsWith('/customize')
      ? 'appearance'
      : route.path.endsWith('/resource')
        ? 'resource'
        : 'general',
);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const groups = [
  { id: 'services', title: 'admin.group_services', keys: ['site_url', 'mail_from', 'resend_api_key'] },
  { id: 'security', title: 'admin.group_security', keys: ['turnstile_enabled', 'turnstile_site_key', 'turnstile_secret', 'rate_limit_enabled'] },
  {
    id: 'general',
    title: 'admin.group_general',
    keys: ['site_name', 'site_description', 'meta_keywords', 'meta_description', 'meta_extras'],
  },
  {
    id: 'registration',
    title: 'admin.group_registration',
    keys: [
      'registration_enabled',
      'regs_per_ip',
      'require_email_verification',
      'register_with_player_name',
      'player_name_rule',
      'player_name_length_min',
      'player_name_length_max',
      'player_name_regexp',
      'restricted_email_allow',
      'restricted_email_deny',
    ],
  },
  {
    id: 'score',
    title: 'admin.settings_group_score',
    keys: [
      'initial_score',
      'score_per_player',
      'free_player_count',
      'max_player_count',
      'score_per_kb_public',
      'score_per_kb_private',
      'score_per_closet_item',
      'refund_on_delete',
      'sign_score_min',
      'sign_score_max',
      'sign_gap_hours',
      'sign_reset_mode',
      'score_award_per_texture',
      'clawback_award_on_delete',
      'score_award_per_like',
      'reporter_score_delta',
      'reporter_reward_score',
      'mojang_verification_score_award',
    ],
  },
  {
    id: 'resource',
    title: 'admin.group_resource',
    keys: [
      'max_upload_size_kb',
      'max_texture_width',
      'allow_texture_download',
      'private_texture_status',
      'texture_name_regexp',
      'comments_enabled',
      'comments_ai_moderation',
      'textures_description_limit',
    ],
  },
  {
    id: 'appearance',
    title: 'admin.group_appearance',
    keys: [
      'theme_color',
      'announcement',
      'content_policy',
      'copyright_text',
      'copyright_preset',
      'icp_beian',
      'public_security_beian',
      'home_background_url',
      'home_background_tablet_url',
      'home_background_mobile_url',
      'login_background_url',
      'login_background_tablet_url',
      'login_background_mobile_url',
      'favicon_url',
      'home_show_intro',
      'home_fixed_background',
      'navbar_color',
      'sidebar_color',
      'transparent_navbar',
      'custom_css',
      'custom_js',
    ],
  },
  {
    id: 'integrations',
    title: 'admin.group_integrations',
    keys: [
      'adsense_client_id',
      'gtag_id',
      'ygg_uuid_algorithm',
      'ygg_token_expire_1',
      'ygg_token_expire_2',
      'ygg_tokens_limit',
      'ygg_rate_limit',
      'ygg_skin_domain',
      'ygg_search_profile_max',
      'ygg_show_config_section',
      'ygg_enable_ali',
      'ygg_private_key',
    ],
  },
];
const keys = computed(() => {
  if (!data.value) return [];
  const listed = new Set([...groups.flatMap((g) => g.keys), ...integrationModules.flatMap(module => [...module.keys])]);
  return [
    ...(groups.find((g) => g.id === tab.value)?.keys || []),
    ...(tab.value === 'general' ? Object.keys(data.value.specs).filter((k) => !listed.has(k)) : []),
  ].filter(
    (k) =>
      data.value!.specs[k] &&
      // 选择语言只影响 localizable 键（编辑该语言的文案覆盖）；其余键任何语言下
      // 都显示并编辑全局值——后端 writeMany 会忽略非 localizable 键的 locale。
      // 不能按 localizable 过滤，否则非文案类 tab（如验证与限流）在选语言后变成空态。
      (!data.value!.specs[k]!.superAdminOnly || session.user.value?.role === 'super_admin'),
  );
});
const changed = computed(() =>
  Object.keys(edits.value).filter((k) => edits.value[k] !== data.value?.values[k]),
);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await adminApi.getSettings(locale.value);
    for (const key of ['announcement', 'copyright_text', 'content_policy', 'site_description']) {
      if (data.value.values[key])
        data.value.values[key] = decodeLegacyContent(data.value.values[key]!);
    }
    edits.value = { ...data.value.values };
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false; flushLocale();
  }
}
async function save() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await adminApi.patchSettings(
      changed.value.map((key) => ({
        key,
        value:
          data.value!.specs[key]?.kind === 'integer' ? Number(edits.value[key]) : edits.value[key],
        locale: locale.value,
      })),
    );
    await load();
    await site.fetch(true);
    notice.value = i18n.t('admin.setting_saved');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false; flushLocale();
  }
}
async function clearOverride(key: string) {
  if (!locale.value || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await adminApi.clearSettingOverride(key, locale.value);
    await load();
    await site.fetch(true);
    notice.value = i18n.t('admin.setting_saved');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false; flushLocale();
  }
}
function flushLocale() {
  if (loading.value || busy.value || pendingLocale === undefined) return;
  const next = pendingLocale;
  pendingLocale = undefined;
  void changeLocale(next);
}
async function changeLocale(next: string) {
  if (next === locale.value) return;
  if (busy.value || loading.value) { pendingLocale = next; return; }
  if (changed.value.length && !await confirmAction(i18n.t('integration.unsaved'))) return;
  locale.value = next;
  notice.value = '';
  await load();
}
async function selectLocale(value: string | number | null) {
  const next = String(value ?? '');
  await changeLocale(next);
}
watch(i18n.locale, value => { void changeLocale(normalizeLocale(value)); });
onBeforeRouteLeave(async () => !busy.value && (!changed.value.length || await confirmAction(i18n.t('integration.unsaved'))));
onMounted(load);
</script>

<template>
  <PageHeader :title="i18n.t('general.options')">
    <AppSelect :model-value="locale" :options="[{ value: '', label: i18n.t('admin.global_locale') }, ...LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))]" :disabled="busy || loading" class="!w-auto" :aria-label="i18n.t('admin.localized')" @change="selectLocale" />
    <AppButton class="btn-primary" :loading="busy" :disabled="!changed.length" @click="save">
      <AppIcon name="save" />
      {{ i18n.t('common.save') }}
    </AppButton>
  </PageHeader>
  <nav class="filter-tabs mb-6 flex-wrap" :aria-label="i18n.t('general.options')">
    <AppButton
      v-for="group in groups"
      :key="group.id"
      :class="{ selected: tab === group.id }"
      :aria-pressed="tab === group.id"
      @click="tab = group.id"
    >
      {{ i18n.t(group.title) }}
    </AppButton>
  </nav>
  <p v-if="error" class="alert alert-danger" role="alert">
    {{ error }}
    <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
  </p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <AppSkeleton v-if="loading" :count="3" />
  <section
    v-else-if="data && tab === 'integrations'"
    class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
  >
    <router-link
      v-for="module in integrationModules"
      :key="module.id"
      :to="{ path: '/admin/integrations', query: { module: module.id } }"
      class="panel flex items-center gap-3 hover:border-brand-400"
    >
      <AppIcon :name="module.icon" class="text-brand-600" />
      <span class="font-medium">{{ i18n.t(`integration.modules.${module.id}`) }}</span>
      <AppIcon name="chevron_right" class="ml-auto text-muted" />
    </router-link>
  </section>
  <AppForm v-else-if="data" class="panel space-y-0" @submit.prevent="save">
    <fieldset :disabled="busy" class="min-w-0">
      <div
        v-for="key in keys"
        :key="key"
        class="grid gap-3 border-b last:border-0 border-line py-5 md:grid-cols-[minmax(200px,1fr)_2fr]"
      >
        <label :for="`setting-${key}`" class="font-medium">
          {{ i18n.t(`admin.setting.${key}`) }}
          <AppButton
            v-if="locale && data.overrides.includes(key)"
            class="btn-sm ml-2"
            :disabled="busy"
            @click="clearOverride(key)"
          >
            {{ i18n.t('common.restore_default') }}
          </AppButton>
        </label>
        <SettingField v-model="edits[key]" :name="key" :spec="data.specs[key]!" />
      </div>
      <EmptyState v-if="!keys.length" :title="i18n.t('general.noResult')" icon="translate" />
    </fieldset>
  </AppForm>
</template>
