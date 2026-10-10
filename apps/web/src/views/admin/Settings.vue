<script setup lang="ts">
import { LOCALE_OPTIONS, normalizeLocale } from '@pigeon-skin/shared/locales';
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
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
import { isSettingVisible } from '@/lib/setting-visibility';

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
// Tabs 滑动指示条：跟随选中项的位置与宽度移动。
// Tabs.List 组件没有转发元素 ref,直接查本页唯一的 tablist DOM。
// 语言切换、字体加载、窗口缩放都会改变标签宽度，用 ResizeObserver 兜底校准，
// 时序上不依赖任何一次性的 nextTick。
const indicatorStyle = ref<{ left: string; width: string }>({ left: '0', width: '0' });
function moveIndicator() {
  const list = document.querySelector<HTMLElement>('.settings-tabs');
  const current = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!list || !current) return;
  // 指示条是 list 的绝对定位子元素，与滚动内容同坐标系：offsetLeft 天然随内容滚动，
  // 不要再减 scrollLeft（会双重补偿把指示条挪到中间）。
  indicatorStyle.value = { left: `${current.offsetLeft}px`, width: `${current.offsetWidth}px` };
  // 溢出时把激活项滚进可视区（Vuetify Tabs 的 selected 行为）
  const target = Math.max(0, current.offsetLeft - list.clientWidth / 2 + current.offsetWidth / 2);
  if (Math.abs(list.scrollLeft - target) > 4) {
    list.scrollTo({ left: target, behavior: 'smooth' });
  }
}
let indicatorObserver: ResizeObserver | undefined;
watch(tab, () => nextTick(moveIndicator));
onMounted(() => {
  nextTick(moveIndicator);
  const list = document.querySelector<HTMLElement>('.settings-tabs');
  if (list && typeof ResizeObserver !== 'undefined') {
    indicatorObserver = new ResizeObserver(moveIndicator);
    indicatorObserver.observe(list);
    // 子元素(标签文字)尺寸变化不触发 list 自身的 resize,兜底观察一次首帧后的布局
    requestAnimationFrame(() => nextTick(moveIndicator));
  }
});
onBeforeUnmount(() => indicatorObserver?.disconnect());
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');
// AI 模型列表（反馈：模型列表自动获取）——跨 AI 字段共享一份
const aiModelOptions = ref<string[]>([]);
const aiModelsLoading = ref(false);
// 生效驱动：管理员显式选择优先，否则用服务端按部署 env 算出的值
const effectiveAiDriver = computed(() =>
  (edits.value.ai_driver || data.value?.aiEffectiveDriver || '') as 'workers' | 'openai' | 'anthropic' | 'systemone' | '',
);
const aiTesting = ref(false);
const aiTestResult = ref('');
async function testAiConnection(model?: string, modelField?: string) {
  if (aiTesting.value) return;
  aiTesting.value = true;
  aiTestResult.value = '';
  error.value = '';
  try {
    const result = await adminApi.aiTest(model, {
      modelField,
      edits: {
        ai_driver: edits.value.ai_driver,
        ai_api_key: edits.value.ai_api_key,
        openai_base_url: edits.value.openai_base_url,
        ai_timeout_seconds: edits.value.ai_timeout_seconds,
        ai_systemone_api_key: edits.value.ai_systemone_api_key,
        ai_cloudflare_account_id: edits.value.ai_cloudflare_account_id,
        ai_cloudflare_api_token: edits.value.ai_cloudflare_api_token,
      },
    });
    aiTestResult.value = result.ok
      ? i18n.t('admin.ai_test_ok', { model: result.model ?? '' })
      : i18n.t('admin.ai_test_fail', { model: result.model ?? '' });
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    aiTesting.value = false;
  }
}
async function fetchAiModels() {
  if (aiModelsLoading.value) return;
  aiModelsLoading.value = true;
  error.value = '';
  try {
    // 表单未保存值一并传入：保存前也能按当前配置拉列表
    const result = await adminApi.aiModels({
      ai_driver: edits.value.ai_driver,
      ai_api_key: edits.value.ai_api_key,
      openai_base_url: edits.value.openai_base_url,
      ai_systemone_api_key: edits.value.ai_systemone_api_key,
      ai_cloudflare_account_id: edits.value.ai_cloudflare_account_id,
      ai_cloudflare_api_token: edits.value.ai_cloudflare_api_token,
    });
    if (result.models === null) {
      notice.value = i18n.t('admin.ai_models_unavailable');
      return;
    }
    aiModelOptions.value = result.models;
    if (result.models.length === 0) notice.value = i18n.t('admin.ai_models_empty');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    aiModelsLoading.value = false;
  }
}
const groups = [
  { id: 'services', title: 'admin.group_services', keys: ['site_url', 'mail_driver', 'mail_from', 'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_username', 'smtp_password', 'resend_api_key'] },
  { id: 'security', title: 'admin.group_security', keys: ['captcha_driver', 'captcha_site_key', 'captcha_secret', 'recaptcha_v3_threshold', 'aliyun_captcha_access_key_id', 'rate_limit_enabled', 'skinlib_guard_enabled'] },
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
      'allow_anonymous_download',
      'private_texture_status',
      'texture_name_regexp',
      'comments_enabled',
      'textures_description_limit',
    ],
  },
  {
    id: 'ai',
    title: 'admin.group_ai',
    keys: [
      'texture_ai_translation',
      'texture_ai_moderation',
      'comments_ai_moderation',
      'notification_ai_translation',
      'ai_driver',
      'openai_base_url',
      'ai_api_key',
      'ai_systemone_api_key',
      'ai_cloudflare_account_id',
      'ai_cloudflare_api_token',
      'ai_max_concurrency',
      'ai_timeout_seconds',
      'ai_reasoning',
      'ai_discriminative_threshold',
      'ai_texture_translate_model',
      'ai_texture_translate_prompt',
      'ai_texture_moderate_mode',
      'ai_texture_moderate_model',
      'ai_texture_moderate_prompt',
      'ai_comments_moderation_mode',
      'ai_comments_moderation_model',
      'ai_comments_moderation_prompt',
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
      'home_style',
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
  ).filter((k) =>
    // 字段联动可见性：只有当字段对运行行为有影响时才显示，规则见 setting-visibility.ts
    isSettingVisible(k, {
      values: data.value!.values,
      edits: edits.value,
      aiEffectiveDriver: data.value!.aiEffectiveDriver,
    }),
  );
});
// 会被提交的差异：未保存修改 ∩ 当前可见键。隐藏字段的残留修改不提交也不触发
// "未保存"提示，但保留在 edits 里，字段重新可见（如把开关改回来）时恢复显示。
const changed = computed(() => {
  if (!data.value) return [];
  return Object.keys(edits.value).filter(
    (k) =>
      edits.value[k] !== data.value?.values[k] &&
      isSettingVisible(k, {
        values: data.value!.values,
        edits: edits.value,
        aiEffectiveDriver: data.value!.aiEffectiveDriver,
      }),
  );
});
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
// 发信配置的连通性自检：把测试邮件发到填的地址（留空发给自己）。
// 发送的是已保存的配置，有未保存的修改时先提示保存，避免拿旧配置测出新问题。
const testTo = ref('');
const testing = ref(false);
const testResult = ref<{ ok: boolean; reason: 'not-configured' | 'provider-error' | null; detail: { phase: string; code: number | null } | null } | null>(null);
async function sendTestMail() {
  if (testing.value || changed.value.length) return;
  testing.value = true;
  error.value = '';
  testResult.value = null;
  try {
    testResult.value = await adminApi.sendTestEmail(testTo.value.trim() || undefined);
  } catch (e) {
    // 请求本身失败（如限流 429）走通用错误提示，不冒充发信失败
    error.value = apiErrorMessage(e);
  } finally {
    testing.value = false;
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
  <div class="settings-tabs" role="tablist" :aria-label="i18n.t('general.options')">
    <button
      v-for="group in groups"
      :key="group.id"
      type="button"
      role="tab"
      class="settings-tab"
      :aria-selected="tab === group.id"
      :data-selected="tab === group.id || undefined"
      :tabindex="tab === group.id ? 0 : -1"
      @click="tab = group.id"
    >
      {{ i18n.t(group.title) }}
    </button>
    <span class="settings-tab-indicator" :style="indicatorStyle" aria-hidden="true" />
  </div>

    <Transition name="tab-panel" mode="out-in">
      <div :key="tab" class="settings-panel">
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
              <SettingField
                v-model="edits[key]"
                :name="key"
                :spec="data.specs[key]!"
                :ai-default="data.aiDefaults?.[key]"
                :model-options="aiModelOptions"
                :models-loading="aiModelsLoading"
                :effective-driver="effectiveAiDriver"
                :test-result="aiTestResult"
                :test-loading="aiTesting"
                @fetch-models="fetchAiModels"
                @test-connection="testAiConnection(edits[key], key)"
              />
              <p v-if="i18n.te(`admin.setting_hint.${key}`)" class="text-sm text-muted md:col-start-2">{{ i18n.t(`admin.setting_hint.${key}`) }}</p>
            </div>
            <div v-if="tab === 'services' && session.user.value?.role === 'super_admin'" class="grid gap-3 border-b border-line py-5 md:grid-cols-[minmax(200px,1fr)_2fr]">
              <label for="mail-test-to" class="font-medium">{{ i18n.t('admin.mail_test') }}</label>
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <AppInput
                    id="mail-test-to"
                    v-model="testTo"
                    type="email"
                    class="max-w-80"
                    :placeholder="i18n.t('admin.mail_test_to')"
                    :aria-label="i18n.t('admin.mail_test_to')"
                  />
                  <AppButton class="btn-primary btn-sm" :loading="testing" :disabled="changed.length > 0" @click="sendTestMail">
                    {{ i18n.t('admin.mail_test_send') }}
                  </AppButton>
                </div>
                <p v-if="changed.length" class="text-sm text-muted">{{ i18n.t('admin.mail_test_unsaved') }}</p>
                <p v-if="testResult" class="text-sm" :class="testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'" role="status">
                  {{ testResult.ok ? i18n.t('admin.mail_test_sent') : testResult.reason === 'not-configured' ? i18n.t('admin.mail_test_not_configured') : i18n.t('admin.mail_test_failed') }}
                  <span v-if="!testResult.ok && testResult.detail?.phase" class="opacity-80">
                    {{ i18n.t('admin.mail_test_detail', { phase: i18n.t(`admin.mail_phase_${testResult.detail.phase}`), code: testResult.detail.code ?? '—' }) }}
                  </span>
                </p>
              </div>
            </div>
            <EmptyState v-if="!keys.length" :title="i18n.t('general.noResult')" icon="translate" />
          </fieldset>
        </AppForm>
      </div>
    </Transition>
</template>
