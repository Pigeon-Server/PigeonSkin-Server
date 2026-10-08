<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useSiteSettings } from '@/stores/site';
import LocaleSelect from '@/components/LocaleSelect.vue';
import SiteFooter from '@/components/SiteFooter.vue';
import OverlayScrollbar from '@/components/ui/OverlayScrollbar.vue';

const i18n = useI18n();
const session = useSessionStore();
const site = useSiteSettings();
const scrollBody = ref<HTMLElement | null>(null);
const scrollId = useId();
const siteName = computed(() => site.get('site_name') || i18n.t('home.title'));
const backgroundUrl = computed(() => site.get('home_background_url'));
const fixedBackground = computed(() => site.get('home_fixed_background') === 'true');
const showIntro = computed(() => site.get('home_show_intro') !== 'false');
const features = ['first', 'second', 'third'] as const;
const mainAction = computed(() =>
  session.user.value
    ? { to: '/user', label: i18n.t('general.user-center') }
    : site.get('registration_enabled') !== 'false'
      ? { to: '/register', label: i18n.t('auth.register') }
      : { to: '/login', label: i18n.t('general.login') },
);
</script>

<template>
  <div class="hp-wrapper">
    <header class="hp-nav">
      <div class="hp-container">
        <router-link to="/" class="brand brand-minecraft">{{ siteName }}</router-link>
        <nav class="hp-nav-menu" :aria-label="i18n.t('general.index')">
          <router-link to="/skinlib" class="hp-nav-link">{{ i18n.t('general.skinlib') }}</router-link>
          <LocaleSelect />
          <router-link v-if="session.user.value" to="/user" class="hp-nav-link">
            {{ i18n.t('general.user-center') }}
          </router-link>
          <router-link v-else to="/login" class="hp-nav-link">
            <AppIcon name="login" class="!text-base" />
            <span class="hp-nav-label">{{ i18n.t('general.login') }}</span>
          </router-link>
        </nav>
      </div>
    </header>
    <div class="hp-viewport">
      <div
        v-if="backgroundUrl && fixedBackground"
        class="hp-background"
        :style="{ backgroundImage: `url('${backgroundUrl}')` }"
        aria-hidden="true"
      />
      <div :id="scrollId" ref="scrollBody" class="hp-body">
        <div
          v-if="backgroundUrl && !fixedBackground"
          class="hp-background"
          :style="{ backgroundImage: `url('${backgroundUrl}')` }"
          aria-hidden="true"
        />
        <div class="hp-splash">
          <h1 class="hp-splash-head">{{ siteName }}</h1>
          <p class="hp-splash-subhead">{{ site.get('site_description') }}</p>
          <router-link :to="mainAction.to" class="hp-main-button">{{ mainAction.label }}</router-link>
        </div>
        <template v-if="showIntro">
          <section class="hp-intro">
            <h2>{{ i18n.t('home.classic.features_title') }}</h2>
            <div class="hp-intro-grid">
              <article v-for="feature in features" :key="feature">
                <AppIcon :name="i18n.t(`home.classic.features.${feature}.icon`)" class="hp-intro-icon" />
                <h3>{{ i18n.t(`home.classic.features.${feature}.name`) }}</h3>
                <p>{{ i18n.t(`home.classic.features.${feature}.desc`) }}</p>
              </article>
            </div>
          </section>
          <section class="hp-footer-wrap">
            <div class="hp-container hp-footer-inner">
              <p>{{ i18n.t('home.classic.introduction', { sitename: siteName }) }}</p>
              <router-link to="/register" class="hp-main-button">{{ i18n.t('home.classic.start') }}</router-link>
            </div>
          </section>
        </template>
        <SiteFooter v-if="showIntro" class="hp-copyright" />
        <SiteFooter v-else class="hp-copyright hp-copyright-fixed" />
      </div>
      <OverlayScrollbar :target="scrollBody" :label="i18n.t('general.index')" />
    </div>
  </div>
</template>

<style scoped>
.hp-wrapper {
  --public-gutter: clamp(20px, 5vw, 80px);
  position: relative;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--brand-deep);
  background-size: cover;
  background-position: center 0;
  background-repeat: no-repeat;
}
.hp-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
}
.hp-body {
  position: relative;
  z-index: 1;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.hp-body::-webkit-scrollbar {
  display: none;
}
.hp-background {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100%;
  z-index: 0;
  background-size: cover;
  background-position: center 0;
  background-repeat: no-repeat;
  filter: brightness(0.6);
  pointer-events: none;
}
.hp-nav {
  position: relative;
  flex-shrink: 0;
  z-index: 60;
  background: var(--navbar-bg, color-mix(in srgb, #fff 12%, transparent));
  color: var(--navbar-ink, var(--ink));
  backdrop-filter: blur(8px);
}
.hp-nav > .hp-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-block: 10px;
}
.hp-container {
  width: 100%;
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: 16px;
}
.hp-nav .brand {
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
.hp-nav-menu {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  flex-shrink: 0;
}
.hp-nav-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 5px;
  color: inherit;
  white-space: nowrap;
  transition: background 0.18s;
}
.hp-nav-link:hover {
  background: color-mix(in srgb, #fff 18%, transparent);
}
/* 经典版导航内禁用全局 .btn 的不透明 hover 底色（在导航色上会变成黑/灰块） */
.hp-nav :deep(.btn-icon:hover:not(:disabled)) {
  background: color-mix(in srgb, #fff 18%, transparent);
  border-color: transparent;
}
.hp-nav :deep(.btn-icon:hover:not(:disabled) .material-icons) {
  color: inherit;
}
.hp-splash {
  position: relative;
  min-height: 100%;
  width: 80%;
  margin-inline: auto;
  text-align: center;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.hp-splash-head {
  font-family: 'Minecraft', Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: clamp(28px, 5vw, 250%);
  line-height: 1.5em;
  margin: 0.2em 0 0.5em;
  padding: 0.8em 0.5em 1em;
  text-shadow:
    0 4px 3px rgba(0, 0, 0, 0.4),
    0 8px 13px rgba(0, 0, 0, 0.1),
    0 18px 23px rgba(0, 0, 0, 0.1);
  overflow-wrap: anywhere;
}
.hp-splash-subhead {
  font-size: 16px;
  letter-spacing: 0.05em;
  margin-bottom: 3em;
  max-width: 640px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
}
.hp-main-button {
  display: inline-block;
  background: transparent;
  border: 1px solid #fff;
  border-radius: 5px;
  color: #fff;
  font-size: 120%;
  padding: 0.8em 2.5em;
  transition: color 0.25s, border-color 0.25s, background-color 0.25s;
}
.hp-main-button:hover {
  background-color: hsla(0, 0%, 100%, 0.2);
  color: #fff;
}
.hp-intro {
  position: relative;
  background: var(--v0-surface);
  color: var(--ink);
  border-top: 5px solid var(--v0-border);
  padding: 50px 0;
  text-align: center;
}
.hp-intro h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 40px;
}
.hp-intro-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(28px, 4vw, 64px);
  max-width: 1200px;
  margin: 0 auto;
}
.hp-intro-icon {
  font-size: 80px;
  color: var(--brand);
}
.hp-intro-grid h3 {
  font-size: 20px;
  font-weight: 650;
  margin: 16px 0 10px;
}
.hp-intro-grid p {
  color: var(--v0-muted);
  line-height: 1.8;
}
.hp-footer-wrap {
  position: relative;
  background: #2f2f2f;
  color: #fff;
  padding: 50px 0;
}
.hp-footer-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.hp-footer-wrap p {
  flex: 1 1 420px;
  min-width: 0;
  line-height: 1.8;
}
.hp-copyright {
  position: relative;
  background: #222;
  color: #fff;
}
/* 经典版版权条走老版 container 对齐，覆盖 SiteFooter 继承的全站 frame-inset */
.hp-copyright :deep(.app-footer) {
  padding-inline: 16px;
  width: 100%;
  max-width: 1200px;
  margin-inline: auto;
  justify-content: center;
}
.hp-copyright-fixed {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
}
@media (max-width: 767px) {
  .hp-nav > .hp-container {
    padding-block: 8px;
    gap: 8px;
  }
  .hp-nav .brand {
    font-size: 15px;
  }
  .hp-nav-menu {
    gap: 2px;
    font-size: 12px;
  }
  .hp-nav-link {
    padding: 6px 7px;
  }
  .hp-splash {
    width: 100%;
  }
  .hp-intro-grid {
    grid-template-columns: 1fr;
  }
  .hp-intro-icon {
    font-size: 56px;
  }
}
</style>
