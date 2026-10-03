<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { textureApi, textureUrl, type TextureSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useSiteSettings } from '@/stores/site';
import SkinViewer from '@/components/SkinViewer.vue';
import { defaultSkinUrl } from '@/lib/default-skin';

const i18n = useI18n();
const session = useSessionStore();
const site = useSiteSettings();

const featured = ref<TextureSummary[]>([]);
const activeSkinIndex = ref(0);

const activeTexture = computed<TextureSummary | null>(() => {
  if (featured.value.length === 0) return null;
  return featured.value[activeSkinIndex.value] ?? featured.value[0] ?? null;
});

const backgrounds = computed(() => ({
  desktop: site.get('home_background_url'),
  tablet: site.get('home_background_tablet_url'),
  mobile: site.get('home_background_mobile_url'),
}));
const hasBackground = computed(() => Object.values(backgrounds.value).some(Boolean));

const headlines = computed(() => [
  i18n.t('home.hero_title'),
  i18n.t('home.hero_title_2'),
  i18n.t('home.hero_title_3'),
  i18n.t('home.hero_title_4'),
  i18n.t('home.hero_title_5'),
]);

const currentHeadlineIndex = ref(0);
const headlineFade = ref(true);
const reducedMotion = ref(false);
let headlineRotateTimer = 0;

function rotateHeadline() {
  if (reducedMotion.value) return;
  headlineFade.value = false;
  window.setTimeout(() => {
    currentHeadlineIndex.value = (currentHeadlineIndex.value + 1) % headlines.value.length;
    headlineFade.value = true;
  }, 240);
}

function startHeadlineTimer() {
  stopHeadlineTimer();
  if (reducedMotion.value) return;
  headlineRotateTimer = window.setInterval(rotateHeadline, 4800);
}

function stopHeadlineTimer() {
  if (headlineRotateTimer) {
    window.clearInterval(headlineRotateTimer);
    headlineRotateTimer = 0;
  }
}

const motionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function updateMotion(event?: MediaQueryList | MediaQueryListEvent) {
  reducedMotion.value = Boolean(event ? event.matches : motionQuery?.matches);
  if (reducedMotion.value) {
    stopHeadlineTimer();
    headlineFade.value = true;
  } else {
    startHeadlineTimer();
  }
}

const features = [
  { icon: 'texture', title: 'home.f_upload_title', body: 'home.f_upload_body' },
  { icon: 'sports_esports', title: 'home.f_player_title', body: 'home.f_player_body' },
  { icon: 'hub', title: 'home.f_api_title', body: 'home.f_api_body' },
];

onMounted(async () => {
  if (motionQuery) {
    motionQuery.addEventListener('change', updateMotion);
    updateMotion();
  }

  try {
    const pool = (await textureApi.list({ perPage: 12, kind: 'skin', sort: 'created' })).items;
    if (pool.length > 0) {
      // 随机选取 4 款精选展示
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const item = pool[i]!;
        pool[i] = pool[j]!;
        pool[j] = item;
      }
      featured.value = pool.slice(0, 4);
    }
  } catch {
    featured.value = [];
  }
});

watch(i18n.locale, () => {
  currentHeadlineIndex.value = 0;
  headlineFade.value = true;
});

onBeforeUnmount(() => {
  stopHeadlineTimer();
  motionQuery?.removeEventListener('change', updateMotion);
});
</script>

<template>
  <div class="home-page">
    <!-- 首屏主展示区 Hero Section -->
    <section
      class="home-hero"
      :class="{ 'home-hero-fixed': site.get('home_fixed_background') === 'true' }"
    >
      <!-- 自定义背景图层 -->
      <picture v-if="hasBackground" class="home-hero-background" aria-hidden="true">
        <source
          v-if="backgrounds.mobile || backgrounds.tablet"
          media="(max-width: 767px)"
          :srcset="backgrounds.mobile || backgrounds.tablet || backgrounds.desktop"
        />
        <source
          v-if="backgrounds.tablet"
          media="(min-width: 768px) and (max-width: 1024px)"
          :srcset="backgrounds.tablet"
        />
        <img :src="backgrounds.desktop || backgrounds.tablet || backgrounds.mobile" alt="" />
      </picture>

      <!-- 左侧文案与行动召唤区 -->
      <div class="hero-copy z-10">
        <!-- 品牌徽章小标签 -->
        <div class="inline-flex items-center gap-2 rounded-full border border-line bg-surface/85 px-3 py-1 text-xs font-semibold tracking-wider text-brand-600 shadow-sm backdrop-blur">
          <AppIcon name="shield" class="!text-sm" />
          <span>{{ i18n.t('home.product') }}</span>
        </div>

        <!-- 标语轮播：固定行高，平滑淡入，杜绝标题抖动 -->
        <div class="hero-headline-container mt-4 min-h-[5rem] sm:min-h-[6rem]">
          <h1
            class="hero-headline font-bold text-ink tracking-tight transition-opacity duration-300"
            :class="headlineFade ? 'opacity-100' : 'opacity-0'"
          >
            {{ headlines[currentHeadlineIndex] }}
          </h1>
        </div>

        <p class="hero-description mt-3 text-sm text-muted sm:text-base leading-relaxed max-w-lg">
          {{ site.get('site_description') || i18n.t('home.hero_description') }}
        </p>

        <!-- 行动按钮组 -->
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <router-link
            to="/skinlib"
            class="btn btn-primary !px-6 !py-3 !text-sm font-semibold inline-flex items-center gap-2 shadow-sm"
          >
            <span>{{ i18n.t('home.cta_browse') }}</span>
            <AppIcon name="arrow_forward" />
          </router-link>

          <router-link
            v-if="session.user.value"
            to="/user"
            class="btn !px-6 !py-3 !text-sm font-semibold inline-flex items-center gap-2 bg-surface shadow-sm"
          >
            <AppIcon name="account_circle" />
            <span>{{ i18n.t('general.user-center') }}</span>
          </router-link>

          <router-link
            v-else-if="site.get('registration_enabled') !== 'false'"
            to="/register"
            class="btn !px-6 !py-3 !text-sm font-semibold inline-flex items-center gap-2 bg-surface shadow-sm"
          >
            <AppIcon name="person_add" />
            <span>{{ i18n.t('home.cta_register') }}</span>
          </router-link>

          <router-link
            v-else
            to="/login"
            class="btn !px-6 !py-3 !text-sm font-semibold inline-flex items-center gap-2 bg-surface shadow-sm"
          >
            <AppIcon name="login" />
            <span>{{ i18n.t('general.login') }}</span>
          </router-link>
        </div>

        <!-- 客户端兼容性徽标 -->
        <div class="mt-8 flex items-center gap-2 text-xs text-muted">
          <AppIcon name="check_circle" class="!text-sm text-brand-600" />
          <span>{{ i18n.t('home.compatibility') }}</span>
        </div>
      </div>

      <!-- 右侧：交互式 3D 材质舞台 -->
      <div class="hero-showcase z-10">
        <div class="showcase-card rounded-2xl border border-line bg-surface/90 shadow-xl backdrop-blur overflow-hidden">
          <!-- 3D 模型舞台区 -->
          <div class="showcase-canvas-wrap relative h-[360px] sm:h-[400px] flex items-center justify-center">
            <SkinViewer
              v-if="activeTexture"
              :skin-url="textureUrl(activeTexture.hash)"
              :slim="activeTexture.model === 'slim'"
              :height="360"
              :animated="true"
              :controls="false"
              class="w-full h-full"
            />
            <SkinViewer
              v-else
              :skin-url="defaultSkinUrl"
              :height="360"
              :animated="true"
              :controls="false"
              class="w-full h-full"
            />

            <!-- 舞台悬浮材质信息条 -->
            <div
              v-if="activeTexture"
              class="absolute top-3 left-3 right-3 flex items-center justify-between rounded-lg bg-surface/80 px-3 py-1.5 backdrop-blur text-xs border border-line/60"
            >
              <div class="min-w-0 pr-2">
                <span class="font-semibold text-ink truncate block" :title="activeTexture.name">
                  {{ activeTexture.name }}
                </span>
                <span class="text-[11px] text-muted truncate block">
                  {{ activeTexture.uploaderName || i18n.t('admin.anonymous') }}
                </span>
              </div>
              <router-link
                :to="`/skinlib/${activeTexture.id}`"
                class="shrink-0 text-brand-600 hover:underline font-medium inline-flex items-center gap-0.5 text-xs"
              >
                <span>{{ i18n.t('general.explore') }}</span>
                <AppIcon name="chevron_right" class="!text-sm" />
              </router-link>
            </div>
          </div>

          <!-- 精选材质快速换装切换条 -->
          <div
            v-if="featured.length > 1"
            class="showcase-switcher flex items-center gap-2 p-3 border-t border-line/60 bg-surface-2/40 overflow-x-auto"
          >
            <button
              v-for="(skin, index) in featured"
              :key="skin.id"
              type="button"
              class="flex flex-1 min-w-[70px] flex-col items-center gap-1 rounded-lg border p-1.5 transition-all text-center"
              :class="
                activeSkinIndex === index
                  ? '!border-brand-500 bg-brand-500/10 shadow-sm'
                  : 'border-transparent hover:border-line hover:bg-surface'
              "
              @click="activeSkinIndex = index"
            >
              <span class="block w-full truncate text-[11px] font-medium text-ink" :title="skin.name">
                {{ skin.name }}
              </span>
              <span class="text-[10px] text-muted">
                {{ skin.model === 'slim' ? 'Alex' : 'Steve' }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心特性卡片网格 Features Section -->
    <section
      v-if="site.get('home_show_intro') !== 'false'"
      class="home-features-section max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-14 border-t border-line"
    >
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <article
          v-for="feature in features"
          :key="feature.title"
          class="feature-card rounded-xl border border-line bg-surface p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md"
        >
          <div class="feature-icon flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 mb-4">
            <AppIcon :name="feature.icon" class="!text-2xl" />
          </div>
          <h2 class="text-base font-bold text-ink mb-2">
            {{ i18n.t(feature.title) }}
          </h2>
          <p class="text-xs sm:text-sm text-muted leading-relaxed">
            {{ i18n.t(feature.body) }}
          </p>
        </article>
      </div>
    </section>

    <!-- 底部转化横幅 Bottom CTA Section -->
    <section class="home-bottom-cta max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div class="rounded-2xl border border-line bg-surface p-8 sm:p-10 shadow-sm text-center flex flex-col items-center">
        <h2 class="text-xl sm:text-2xl font-bold text-ink">
          {{ i18n.t('home.hero_title_4') }}
        </h2>
        <p class="mt-2 text-sm text-muted max-w-md">
          {{ i18n.t('home.hero_description') }}
        </p>
        <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
          <router-link
            to="/skinlib"
            class="btn btn-primary !px-6 !py-2.5 font-semibold"
          >
            {{ i18n.t('home.cta_browse') }}
          </router-link>
          <router-link
            v-if="!session.user.value && site.get('registration_enabled') !== 'false'"
            to="/register"
            class="btn !px-6 !py-2.5 font-semibold"
          >
            {{ i18n.t('home.cta_register') }}
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  width: 100%;
  overflow-x: hidden;
}

.home-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(32px, 5vw, 80px);
  padding: clamp(48px, 8vh, 100px) clamp(16px, 4vw, 48px);
  min-height: 560px;
  position: relative;
  isolation: isolate;
}

.home-hero-background {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.home-hero-background::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--v0-surface) 96%, transparent),
    color-mix(in srgb, var(--v0-surface) 60%, transparent) 55%,
    color-mix(in srgb, var(--v0-surface) 30%, transparent)
  );
}

.home-hero-background img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.home-hero-fixed .home-hero-background {
  position: fixed;
  height: 100vh;
}

.hero-copy {
  min-width: 0;
}

.hero-headline {
  font-size: clamp(34px, 4.2vw, 56px);
  line-height: 1.18;
  white-space: pre-line;
}

.hero-showcase {
  width: 100%;
  max-width: 480px;
  margin-inline: auto;
}

.showcase-canvas-wrap {
  background-color: var(--v0-surface-2);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--v0-border) 40%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--v0-border) 40%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 40%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 40%, transparent) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

@media (max-width: 960px) {
  .home-hero {
    grid-template-columns: 1fr;
    padding: 40px 20px 32px;
    gap: 36px;
  }

  .hero-headline {
    font-size: clamp(28px, 7vw, 42px);
  }

  .home-hero-background::after {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--v0-surface) 94%, transparent),
      color-mix(in srgb, var(--v0-surface) 75%, transparent)
    );
  }

  .hero-showcase {
    max-width: 420px;
  }
}
</style>
