<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, meApi, mojangApi, type ScoreInfo, type MojangStatus } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import LauncherSetup from '@/components/LauncherSetup.vue';
import { apiErrorMessage } from '@/lib/api-error';
const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();
const info = ref<ScoreInfo | null>(null);
const mojang = ref<MojangStatus | null>(null);
const loading = ref(true),
  busy = ref(false),
  scoreOpen = ref(false);
const error = ref(''),
  notice = ref(''),
  mojangError = ref('');
const score = computed(() => info.value?.score ?? session.user.value?.score ?? 0);
const animatedScore = ref<number | null>(null);
let scoreAnimation = 0;
const usage = computed(() =>
  info.value
    ? [
        {
          key: 'players',
          icon: 'sports_esports',
          used: info.value.usage.players,
          rate: info.value.rates.perPlayer,
        },
        {
          key: 'storage',
          icon: 'storage',
          used: info.value.usage.storageKb,
          rate: info.value.rates.perKbPublic,
        },
      ]
    : [],
);
function capacity(used: number, rate: number) {
  return rate > 0 ? Math.floor(used + Math.max(0, score.value) / rate) : null;
}
function totalLabel(used: number, rate: number) {
  const total = capacity(used, rate);
  return total === null ? i18n.t('common.unlimited') : i18n.n(total);
}
function percentage(used: number, rate: number) {
  const total = capacity(used, rate);
  return total && total > 0 ? Math.min(100, (used / total) * 100) : 0;
}
function animateScore(from: number, to: number) {
  cancelAnimationFrame(scoreAnimation);
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animatedScore.value = null;
    return;
  }
  const start = performance.now();
  const duration = 800;
  animatedScore.value = from;
  const frame = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    animatedScore.value = Math.round(from + (to - from) * eased);
    if (progress < 1) scoreAnimation = requestAnimationFrame(frame);
    else {
      animatedScore.value = null;
      scoreAnimation = 0;
    }
  };
  scoreAnimation = requestAnimationFrame(frame);
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    info.value = await meApi.score();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function loadMojang() {
  mojangError.value = '';
  try {
    mojang.value = await mojangApi.status();
  } catch (e) {
    mojangError.value = apiErrorMessage(e);
  }
}
async function sign() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const previousScore = score.value;
  try {
    const result = await meApi.sign();
    notice.value = i18n.t('dash.signed_reward', { score: i18n.n(result.reward) });
    info.value = await meApi.score();
    await session.fetchSession();
    animateScore(previousScore, score.value);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function sendVerification() {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.verifyEmailRequest();
    if (result.ok) notice.value = i18n.t('user.verification.success');
    else error.value = i18n.t('auth.mail_unavailable');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void site.fetch();
  void load();
  void loadMojang();
});
onBeforeUnmount(() => cancelAnimationFrame(scoreAnimation));
</script>
<template>
  <PageHeader :title="i18n.t('general.dashboard')">
    <span v-if="mojang?.verified" class="badge badge-success">
      {{ i18n.t('integration.mojang.badge') }}
    </span>
  </PageHeader>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
    <div class="min-w-0 space-y-4">
      <div
        v-if="!session.user.value?.emailVerified && site.get('require_email_verification') === 'true'"
        class="alert alert-warning flex flex-wrap items-center justify-between gap-2"
      >
        <span>{{ i18n.t('user.unverified_ext') }}</span>
        <AppButton class="btn-sm" :loading="busy" @click="sendVerification">
          {{ i18n.t('user.verification.send_ext') }}
        </AppButton>
      </div>
      <section class="panel !p-0 overflow-hidden">
        <header class="border-b border-line px-4 py-3">
          <h2 class="font-semibold text-sm">{{ i18n.t('user.used.title') }}</h2>
        </header>
        <p v-if="error" class="m-4 text-sm text-danger" role="alert">
          {{ error }}
          <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
        </p>
        <AppSkeleton v-if="loading && !info" class="p-4" :count="2" />
        <div
          v-else-if="info"
          class="grid items-center gap-5 p-4 md:grid-cols-[minmax(0,1fr)_220px]"
        >
          <div class="space-y-3">
            <div
              v-for="item in usage"
              :key="item.key"
              class="rounded border border-line bg-brand-50 p-3"
            >
              <div class="flex items-center gap-3">
                <AppIcon :name="item.icon" class="text-brand-600 !text-3xl" />
                <div class="min-w-0 flex-1">
                  <p class="text-xs text-muted">{{ i18n.t(`user.used.${item.key}`) }}</p>
                  <p class="mt-1 text-sm font-semibold tabular-nums">
                    {{ i18n.t(item.key === 'storage' ? 'dash.storage_ratio' : 'dash.usage_ratio', { used: i18n.n(item.used), total: totalLabel(item.used, item.rate) }) }}
                  </p>
                </div>
              </div>
              <div class="mt-3 h-1 rounded bg-surface-2 overflow-hidden">
                <div
                  class="h-full bg-brand-600"
                  :style="{ width: `${percentage(item.used, item.rate)}%` }"
                />
              </div>
            </div>
          </div>
          <div class="text-center">
            <p class="text-xs text-muted">{{ i18n.t('user.cur-score') }}</p>
            <AppButton
              class="!border-0 !bg-transparent !p-2 max-w-full"
              :aria-label="i18n.t('dash.score_details')"
              @click="scoreOpen = true"
            >
              <span class="text-3xl font-semibold tabular-nums">{{ i18n.n(animatedScore ?? score) }}</span>
            </AppButton>
            <p class="text-xs text-muted">{{ i18n.t('user.score-notice') }}</p>
          </div>
        </div>
        <footer
          class="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2 px-4 py-3"
        >
          <AppButton class="btn-primary" :disabled="!info?.canSignIn" :loading="busy" @click="sign">
            <AppIcon name="calendar_today" />
            {{ i18n.t(info?.canSignIn ? 'user.sign' : 'user.signed_ext') }}
          </AppButton>
          <span v-if="info?.nextSignAt && !info.canSignIn" class="text-xs text-muted">
            {{ i18n.t('dash.next_sign', { date: i18n.d(info.nextSignAt) }) }}
          </span>
        </footer>
      </section>
      <LauncherSetup v-if="site.get('ygg_show_config_section') === 'true'" />
    </div>
    <div class="min-w-0 space-y-4">
      <section class="panel !p-0 overflow-hidden">
        <header class="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 class="font-semibold text-sm">{{ i18n.t('dash.announcement') }}</h2>
          <router-link
            v-if="session.isAdmin.value"
            to="/admin/customize"
            class="btn btn-sm btn-icon"
            :aria-label="i18n.t('common.edit')"
          >
            <AppIcon name="edit" />
          </router-link>
        </header>
        <div class="p-4">
          <MarkdownContent v-if="site.get('announcement')" :content="site.get('announcement')" />
          <p v-else class="text-sm text-muted">{{ i18n.t('dash.no_announcement') }}</p>
        </div>
      </section>
      <section v-if="mojang && !mojang.verified" class="panel space-y-3">
        <h2 class="font-semibold text-sm">{{ i18n.t('settings.mojang') }}</h2>
        <p class="text-sm text-muted">{{ i18n.t('integration.mojang.verify_notice') }}</p>
        <p v-if="Number(site.get('mojang_verification_score_award')) > 0" class="text-sm">
          {{ i18n.t('dash.verification_reward', { score: i18n.n(Number(site.get('mojang_verification_score_award'))) }) }}
        </p>
        <a v-if="mojang.available" href="/mojang/verify" class="btn btn-primary">
          <AppIcon name="verified_user" />
          {{ i18n.t('settings.mojang_go_verify') }}
        </a>
        <p v-else class="text-xs text-muted">{{ i18n.t('settings.mojang_unavailable') }}</p>
      </section>
      <p v-if="mojangError" class="text-sm text-danger" role="alert">
        {{ mojangError }}
        <AppButton class="btn-sm ml-2" @click="loadMojang">{{ i18n.t('common.retry') }}</AppButton>
      </p>
    </div>
  </div>
  <AppDialog v-model="scoreOpen" :title="i18n.t('dash.score_details')">
    <div class="space-y-4">
      <p>
        {{ i18n.t('dash.initial_score', { score: i18n.n(Number(site.get('initial_score')) || 0) }) }}
      </p>
      <p v-if="info">
        {{ i18n.t('dash.sign_reward_range', { min: i18n.n(info.signReward.min), max: i18n.n(info.signReward.max) }) }}
      </p>
      <p>
        {{ i18n.t(site.get('refund_on_delete') === 'true' ? 'dash.refund_enabled' : 'dash.refund_disabled') }}
      </p>
      <dl v-if="info" class="grid grid-cols-2 gap-3 border-t border-line pt-4">
        <dt>{{ i18n.t('admin.setting.score_per_player') }}</dt>
        <dd>{{ i18n.n(info.rates.perPlayer) }}</dd>
        <dt>{{ i18n.t('admin.setting.score_per_kb_public') }}</dt>
        <dd>{{ i18n.n(info.rates.perKbPublic) }}</dd>
        <dt>{{ i18n.t('admin.setting.score_per_kb_private') }}</dt>
        <dd>{{ i18n.n(info.rates.perKbPrivate) }}</dd>
        <dt>{{ i18n.t('admin.setting.score_per_closet_item') }}</dt>
        <dd>{{ i18n.n(info.rates.perClosetItem) }}</dd>
      </dl>
    </div>
  </AppDialog>
</template>
