<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, meApi, mojangApi, type ScoreInfo, type MojangStatus } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import LauncherSetup from '@/components/LauncherSetup.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { apiErrorMessage } from '@/lib/api-error';

const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();

const info = ref<ScoreInfo | null>(null);
const mojang = ref<MojangStatus | null>(null);
const loading = ref(true);
const busy = ref(false);
const scoreOpen = ref(false);
const error = ref('');
const notice = ref('');
const mojangError = ref('');

const user = computed(() => session.user.value);
const score = computed(() => info.value?.score ?? user.value?.score ?? 0);
const animatedScore = ref<number | null>(null);
let scoreAnimation = 0;

const isEmailUnverified = computed(
  () => !user.value?.emailVerified && site.get('require_email_verification') === 'true',
);

const roleLabel = computed(() => {
  const role = user.value?.role;
  if (role === 'super_admin') return i18n.t('admin.role_super');
  if (role === 'admin') return i18n.t('admin.role_admin');
  if (role === 'banned') return i18n.t('admin.role_banned');
  return i18n.t('admin.role_normal');
});

const usage = computed(() => {
  if (!info.value) return [];
  return [
    {
      key: 'players' as const,
      icon: 'sports_esports',
      label: i18n.t('user.used.players'),
      used: info.value.usage.players,
      rate: info.value.rates.perPlayer,
      rateLabel: i18n.t('admin.setting.score_per_player'),
    },
    {
      key: 'storage' as const,
      icon: 'storage',
      label: i18n.t('user.used.storage'),
      used: info.value.usage.storageKb,
      rate: info.value.rates.perKbPublic,
      rateLabel: i18n.t('admin.setting.score_per_kb_public'),
    },
  ];
});

const quickLinks = computed(() => [
  {
    to: '/player',
    title: i18n.t('general.player-manage'),
    desc: i18n.t('dash.manage_players'),
    icon: 'sports_esports',
    accent: 'text-sky-600 dark:text-sky-400',
  },
  {
    to: '/closet',
    title: i18n.t('general.my-closet'),
    desc: i18n.t('dash.manage_closet'),
    icon: 'checkroom',
    accent: 'text-indigo-600 dark:text-indigo-400',
  },
  {
    to: '/skinlib',
    title: i18n.t('general.skinlib'),
    desc: i18n.t('dash.explore_skinlib'),
    icon: 'photo_library',
    accent: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    to: '/skinlib/upload',
    title: i18n.t('dash.upload'),
    desc: i18n.t('dash.upload_texture'),
    icon: 'cloud_upload',
    accent: 'text-amber-600 dark:text-amber-400',
  },
  {
    to: '/tickets',
    title: i18n.t('ticket.title'),
    desc: i18n.t('dash.support_tickets'),
    icon: 'confirmation_number',
    accent: 'text-purple-600 dark:text-purple-400',
  },
  {
    to: '/votes',
    title: i18n.t('votes.title'),
    desc: i18n.t('dash.community_votes'),
    icon: 'how_to_vote',
    accent: 'text-rose-600 dark:text-rose-400',
  },
]);

function capacity(used: number, rate: number) {
  return rate > 0 ? Math.floor(used + Math.max(0, score.value) / rate) : null;
}

function totalLabel(used: number, rate: number) {
  const total = capacity(used, rate);
  return total === null ? i18n.t('common.unlimited') : i18n.n(total);
}

function percentage(used: number, rate: number) {
  const total = capacity(used, rate);
  return total && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

function progressBarClass(percent: number) {
  if (percent >= 90) return 'bg-danger';
  if (percent >= 75) return 'bg-amber-500';
  return 'bg-brand-600';
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
    if (progress < 1) {
      scoreAnimation = requestAnimationFrame(frame);
    } else {
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
    if (result.ok) {
      notice.value = i18n.t('user.verification.success');
    } else {
      error.value = i18n.t('auth.mail_unavailable');
    }
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
  <PageHeader :title="i18n.t('general.user-center')">
    <div class="flex items-center gap-2">
      <span
        v-if="mojang?.verified"
        class="badge badge-success inline-flex items-center gap-1"
      >
        <AppIcon name="verified" class="!text-sm" />
        {{ i18n.t('dash.verified_badge') }}
      </span>
      <span
        v-if="user?.role"
        class="badge"
        :class="user.role === 'banned' ? 'badge-danger' : 'badge-default'"
      >
        {{ roleLabel }}
      </span>
    </div>
  </PageHeader>

  <AppAlert v-if="notice" variant="success">
    <div class="flex items-center justify-between gap-3">
      <span>{{ notice }}</span>
      <button
        type="button"
        class="opacity-70 hover:opacity-100 text-sm"
        :aria-label="i18n.t('common.close')"
        @click="notice = ''"
      >
        <AppIcon name="close" class="!text-base" />
      </button>
    </div>
  </AppAlert>

  <AppAlert v-if="isEmailUnverified" variant="warning">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <AppIcon name="warning" class="text-amber-500 !text-xl shrink-0" />
        <span>{{ i18n.t('user.unverified_ext') }}</span>
      </div>
      <AppButton class="btn-sm" :loading="busy" @click="sendVerification">
        {{ i18n.t('user.verification.send_ext') }}
      </AppButton>
    </div>
  </AppAlert>

  <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
    <!-- 左栏主内容区 -->
    <div class="min-w-0 space-y-4">
      <!-- 用户身份画像卡片 -->
      <section v-if="user" class="panel flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4">
        <div class="flex items-center gap-4 min-w-0">
          <router-link
            to="/profile"
            class="relative group block shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            :aria-label="i18n.t('general.profile')"
          >
            <UserAvatar
              :texture-id="user.avatarTextureId"
              :user-id="user.id"
              :name="user.nickname || ''"
              class="h-14 w-14 object-contain"
            />
            <div
              class="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
            >
              <AppIcon name="edit" class="!text-sm" />
            </div>
          </router-link>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base sm:text-lg font-bold tracking-tight truncate">
                {{ user.nickname }}
              </h2>
              <span class="text-xs text-muted font-mono">UID: {{ user.id }}</span>
            </div>
            <p class="mt-0.5 text-xs sm:text-sm text-muted truncate">
              {{ user.email }}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <span
                v-if="user.emailVerified"
                class="badge badge-success inline-flex items-center gap-1 text-[11px]"
              >
                <AppIcon name="check_circle" class="!text-xs" />
                {{ i18n.t('dash.verified_badge') }}
              </span>
              <span
                v-else
                class="badge badge-warning inline-flex items-center gap-1 text-[11px]"
              >
                <AppIcon name="error_outline" class="!text-xs" />
                {{ i18n.t('dash.unverified_badge') }}
              </span>
              <span
                class="badge text-[11px]"
                :class="user.role === 'banned' ? 'badge-danger' : 'badge-default'"
              >
                {{ roleLabel }}
              </span>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap sm:flex-col items-center sm:items-end gap-2 shrink-0 border-t sm:border-t-0 border-line pt-3 sm:pt-0">
          <router-link to="/profile" class="btn btn-sm inline-flex items-center gap-1.5 w-full sm:w-auto justify-center">
            <AppIcon name="account_circle" class="!text-base" />
            <span>{{ i18n.t('general.profile') }}</span>
          </router-link>
          <router-link to="/account/security" class="btn btn-sm inline-flex items-center gap-1.5 w-full sm:w-auto justify-center">
            <AppIcon name="security" class="!text-base" />
            <span>{{ i18n.t('security.title') }}</span>
          </router-link>
        </div>
      </section>

      <!-- 积分看板与签到卡片 -->
      <section class="panel !p-0 overflow-hidden">
        <header class="flex items-center justify-between border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <AppIcon name="stars" class="text-amber-500 !text-xl" />
            <h2 class="font-semibold text-sm">{{ i18n.t('dash.score') }}</h2>
          </div>
          <AppButton
            class="btn-sm !border-0 !bg-transparent text-muted hover:text-brand-600 inline-flex items-center gap-1"
            :aria-label="i18n.t('dash.score_details')"
            @click="scoreOpen = true"
          >
            <AppIcon name="help_outline" class="!text-sm" />
            <span class="text-xs">{{ i18n.t('dash.score_details') }}</span>
          </AppButton>
        </header>

        <div class="p-4 sm:p-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p class="text-xs text-muted uppercase tracking-wider font-medium">
                {{ i18n.t('user.cur-score') }}
              </p>
              <button
                type="button"
                class="mt-1 flex items-baseline gap-2 group text-left focus:outline-none"
                :title="i18n.t('user.score-notice')"
                @click="scoreOpen = true"
              >
                <span class="text-3xl sm:text-4xl font-extrabold tracking-tight tabular-nums group-hover:text-brand-600 transition-colors">
                  {{ i18n.n(animatedScore ?? score) }}
                </span>
                <span class="text-xs text-muted group-hover:underline">
                  {{ i18n.t('user.score-notice') }}
                </span>
              </button>
              <p v-if="info" class="mt-2 text-xs text-muted flex items-center gap-1">
                <AppIcon name="info" class="!text-xs text-brand-500" />
                <span>
                  {{ i18n.t('dash.sign_reward_range', { min: i18n.n(info.signReward.min), max: i18n.n(info.signReward.max) }) }}
                </span>
              </p>
            </div>

            <div class="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
              <AppButton
                class="w-full sm:w-auto"
                :class="info?.canSignIn ? 'btn-primary' : 'btn-secondary'"
                :disabled="!info?.canSignIn"
                :loading="busy"
                @click="sign"
              >
                <AppIcon :name="info?.canSignIn ? 'event_available' : 'task_alt'" />
                <span>{{ i18n.t(info?.canSignIn ? 'user.sign' : 'dash.signed') }}</span>
              </AppButton>
              <span
                v-if="info?.nextSignAt && !info.canSignIn"
                class="text-xs text-muted"
              >
                {{ i18n.t('dash.next_sign', { date: i18n.d(info.nextSignAt) }) }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 资源使用率监控卡片 -->
      <section class="panel !p-0 overflow-hidden">
        <header class="border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <AppIcon name="bar_chart" class="text-brand-600 !text-xl" />
            <h2 class="font-semibold text-sm">{{ i18n.t('user.used.title') }}</h2>
          </div>
        </header>

        <AppAlert v-if="error" variant="danger" class="m-4">
          <div class="flex items-center justify-between gap-3">
            <span>{{ error }}</span>
            <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton>
          </div>
        </AppAlert>

        <AppSkeleton v-if="loading && !info" class="p-4" :count="2" />

        <div v-else-if="info" class="p-4 sm:p-5 space-y-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <div
              v-for="item in usage"
              :key="item.key"
              class="rounded-lg border border-line bg-surface-2/60 p-4 flex flex-col justify-between"
            >
              <div>
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="p-2 rounded-md bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400 shrink-0">
                      <AppIcon :name="item.icon" class="!text-xl" />
                    </div>
                    <div class="min-w-0">
                      <p class="text-xs font-medium text-muted truncate">{{ item.label }}</p>
                      <p class="text-base font-bold tabular-nums mt-0.5">
                        {{ i18n.t(item.key === 'storage' ? 'dash.storage_ratio' : 'dash.usage_ratio', { used: i18n.n(item.used), total: totalLabel(item.used, item.rate) }) }}
                      </p>
                    </div>
                  </div>
                  <span class="text-xs font-semibold tabular-nums text-muted">
                    {{ percentage(item.used, item.rate) }}%
                  </span>
                </div>

                <div class="mt-3.5 h-1.5 w-full rounded-full bg-line overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    :class="progressBarClass(percentage(item.used, item.rate))"
                    :style="{ width: `${percentage(item.used, item.rate)}%` }"
                  />
                </div>
              </div>

              <p class="mt-3 text-[11px] text-muted truncate" :title="item.rateLabel">
                {{ item.rateLabel }}: {{ i18n.n(item.rate) }} {{ i18n.t('dash.score') }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- 快捷通道矩阵 -->
      <section class="panel !p-0 overflow-hidden">
        <header class="border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <AppIcon name="near_me" class="text-brand-600 !text-xl" />
            <h2 class="font-semibold text-sm">{{ i18n.t('dash.quick_actions') }}</h2>
          </div>
        </header>
        <div class="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <router-link
            v-for="link in quickLinks"
            :key="link.to"
            :to="link.to"
            class="group rounded-lg border border-line bg-surface-1 p-3.5 hover:border-brand-500 hover:bg-brand-50/20 dark:hover:bg-brand-950/20 transition-all flex flex-col justify-between"
          >
            <div>
              <AppIcon :name="link.icon" class="!text-2xl transition-transform group-hover:scale-110" :class="link.accent" />
              <h3 class="mt-2 text-sm font-semibold text-foreground group-hover:text-brand-600 transition-colors">
                {{ link.title }}
              </h3>
            </div>
            <p class="mt-1 text-xs text-muted line-clamp-2">
              {{ link.desc }}
            </p>
          </router-link>
        </div>
      </section>

      <!-- 启动器快速配置模块 -->
      <LauncherSetup v-if="site.get('ygg_show_config_section') === 'true'" />
    </div>

    <!-- 右栏侧边辅助区 -->
    <div class="min-w-0 space-y-4">
      <!-- 站点公告卡片 -->
      <section class="panel !p-0 overflow-hidden">
        <header class="flex items-center justify-between border-b border-line px-4 py-3">
          <div class="flex items-center gap-2 min-w-0">
            <AppIcon name="campaign" class="text-brand-600 !text-xl shrink-0" />
            <h2 class="font-semibold text-sm truncate">{{ i18n.t('dash.announcement') }}</h2>
          </div>
          <router-link
            v-if="session.isAdmin.value"
            to="/admin/customize"
            class="btn btn-sm btn-icon text-muted hover:text-foreground"
            :aria-label="i18n.t('common.edit')"
          >
            <AppIcon name="edit" />
          </router-link>
        </header>
        <div class="p-4">
          <div
            v-if="site.get('announcement')"
            class="prose prose-sm dark:prose-invert max-h-80 overflow-y-auto pr-1"
          >
            <MarkdownContent :content="site.get('announcement')" />
          </div>
          <EmptyState
            v-else
            :title="i18n.t('dash.no_announcement')"
            class="py-6"
          />
        </div>
      </section>

      <!-- Mojang 正版验证卡片 -->
      <section v-if="mojang" class="panel !p-0 overflow-hidden">
        <header class="border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <AppIcon name="verified_user" class="text-brand-600 !text-xl" />
            <h2 class="font-semibold text-sm">{{ i18n.t('settings.mojang') }}</h2>
          </div>
        </header>

        <div class="p-4 space-y-3">
          <div v-if="mojang.verified" class="rounded-lg border border-line bg-surface-2/60 p-3.5 flex items-start gap-3">
            <div class="p-2 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 shrink-0">
              <AppIcon name="check" class="!text-lg" />
            </div>
            <div>
              <p class="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                {{ i18n.t('dash.verified_badge') }}
              </p>
              <p class="mt-0.5 text-xs text-muted">
                {{ i18n.t('dash.verified_status') }}
              </p>
            </div>
          </div>

          <template v-else>
            <p class="text-sm text-muted">
              {{ i18n.t('integration.mojang.verify_notice') }}
            </p>
            <div
              v-if="Number(site.get('mojang_verification_score_award')) > 0"
              class="rounded-md border border-line bg-brand-50/50 dark:bg-brand-950/30 p-2.5 text-xs text-brand-700 dark:text-brand-300 flex items-center gap-2"
            >
              <AppIcon name="military_tech" class="!text-base text-amber-500" />
              <span>
                {{ i18n.t('dash.verification_reward', { score: i18n.n(Number(site.get('mojang_verification_score_award'))) }) }}
              </span>
            </div>

            <div class="pt-1">
              <a
                v-if="mojang.available"
                href="/mojang/verify"
                class="btn btn-primary w-full justify-center inline-flex items-center gap-2"
              >
                <AppIcon name="verified_user" />
                <span>{{ i18n.t('settings.mojang_go_verify') }}</span>
              </a>
              <p v-else class="text-xs text-muted text-center">
                {{ i18n.t('settings.mojang_unavailable') }}
              </p>
            </div>
          </template>
        </div>
      </section>

      <AppAlert v-if="mojangError" variant="danger">
        <div class="flex items-center justify-between gap-3">
          <span>{{ mojangError }}</span>
          <AppButton class="btn-sm" @click="loadMojang">{{ i18n.t('common.retry') }}</AppButton>
        </div>
      </AppAlert>
    </div>
  </div>

  <!-- 积分规则与详情说明弹窗 -->
  <AppDialog v-model="scoreOpen" :title="i18n.t('dash.score_details')">
    <div class="space-y-5 text-sm">
      <p class="text-muted leading-relaxed">
        {{ i18n.t('dash.score_intro_text') }}
      </p>

      <div class="space-y-2">
        <h3 class="text-xs font-semibold text-muted uppercase tracking-wider">
          {{ i18n.t('dash.general_rules') }}
        </h3>
        <div class="rounded-lg border border-line bg-surface-2/60 divide-y divide-line">
          <div class="p-3 flex items-start gap-2.5">
            <AppIcon name="card_giftcard" class="text-amber-500 shrink-0 !text-lg mt-0.5" />
            <div>
              <p class="font-medium text-foreground">
                {{ i18n.t('dash.initial_score', { score: i18n.n(Number(site.get('initial_score')) || 0) }) }}
              </p>
            </div>
          </div>
          <div v-if="info" class="p-3 flex items-start gap-2.5">
            <AppIcon name="event" class="text-brand-500 shrink-0 !text-lg mt-0.5" />
            <div>
              <p class="font-medium text-foreground">
                {{ i18n.t('dash.sign_reward_range', { min: i18n.n(info.signReward.min), max: i18n.n(info.signReward.max) }) }}
              </p>
            </div>
          </div>
          <div class="p-3 flex items-start gap-2.5">
            <AppIcon name="autorenew" class="text-sky-500 shrink-0 !text-lg mt-0.5" />
            <div>
              <p class="font-medium text-foreground">
                {{ i18n.t(site.get('refund_on_delete') === 'true' ? 'dash.refund_enabled' : 'dash.refund_disabled') }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="info" class="space-y-2">
        <h3 class="text-xs font-semibold text-muted uppercase tracking-wider">
          {{ i18n.t('dash.rate_rules') }}
        </h3>
        <dl class="grid grid-cols-2 gap-2 text-xs">
          <div class="rounded border border-line bg-surface-2/40 p-2.5">
            <dt class="text-muted">{{ i18n.t('admin.setting.score_per_player') }}</dt>
            <dd class="mt-1 font-bold text-base tabular-nums">{{ i18n.n(info.rates.perPlayer) }}</dd>
          </div>
          <div class="rounded border border-line bg-surface-2/40 p-2.5">
            <dt class="text-muted">{{ i18n.t('admin.setting.score_per_kb_public') }}</dt>
            <dd class="mt-1 font-bold text-base tabular-nums">{{ i18n.n(info.rates.perKbPublic) }}</dd>
          </div>
          <div class="rounded border border-line bg-surface-2/40 p-2.5">
            <dt class="text-muted">{{ i18n.t('admin.setting.score_per_kb_private') }}</dt>
            <dd class="mt-1 font-bold text-base tabular-nums">{{ i18n.n(info.rates.perKbPrivate) }}</dd>
          </div>
          <div class="rounded border border-line bg-surface-2/40 p-2.5">
            <dt class="text-muted">{{ i18n.t('admin.setting.score_per_closet_item') }}</dt>
            <dd class="mt-1 font-bold text-base tabular-nums">{{ i18n.n(info.rates.perClosetItem) }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </AppDialog>
</template>
