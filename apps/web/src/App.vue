<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useTheme } from '@/composables/theme';
import { useSiteSettings } from '@/stores/site';
import NotificationBell from '@/components/NotificationBell.vue';
import ActionDialog from '@/components/ui/ActionDialog.vue';
import SkinlibChallengeDialog from '@/components/SkinlibChallengeDialog.vue';
import SiteFooter from '@/components/SiteFooter.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import Live2DWidget from '@/components/Live2DWidget.vue';
import SidebarLink from '@/components/SidebarLink.vue';
import SidebarGroup from '@/components/SidebarGroup.vue';
import HomeClassic from '@/views/HomeClassic.vue';
import { applySiteTheme } from '@/lib/theme';
import { usePreferences } from '@/composables/preferences';
import LocaleSelect from '@/components/LocaleSelect.vue';
import { applyPageMetadata, baseMetadata } from '@/lib/seo';
const route = useRoute();
const session = useSessionStore();
const i18n = useI18n();
const theme = useTheme();
const preferences = usePreferences();
const site = useSiteSettings();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
try { sidebarCollapsed.value = localStorage.getItem('pigeon.sidebar.collapsed') === 'true'; } catch {}
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try { localStorage.setItem('pigeon.sidebar.collapsed', String(sidebarCollapsed.value)); } catch {}
}
const keyboardNavigation = ref(false);
const trackKeyboard = (event: KeyboardEvent) => { if (event.key === 'Tab') keyboardNavigation.value = true; };
const trackPointer = () => { keyboardNavigation.value = false; };
window.addEventListener('keydown', trackKeyboard, true);
window.addEventListener('pointerdown', trackPointer, true);
onBeforeUnmount(() => { window.removeEventListener('keydown', trackKeyboard, true); window.removeEventListener('pointerdown', trackPointer, true); });
const mobileQuery = matchMedia('(max-width: 767px)');
const mobile = ref(mobileQuery.matches);
const compactSidebar = computed(() => sidebarCollapsed.value && !mobile.value);
const updateMobile = () => { mobile.value = mobileQuery.matches; sidebarOpen.value = false; };
mobileQuery.addEventListener('change', updateMobile);
onBeforeUnmount(() => mobileQuery.removeEventListener('change', updateMobile));
const blocked = computed(() => session.user.value?.role === 'banned');
const canonicalPath = computed(() => route.matched.at(-1)?.aliasOf?.path ?? route.path);
const sessionErrorOpen = computed({
  get: () => !!session.error.value,
  set: (value) => {
    if (!value) session.error.value = '';
  },
});
const authPage = computed(() => route.meta.layout === 'auth');
const authBackgrounds = computed(() => ({
  desktop: site.get('login_background_url'),
  tablet: site.get('login_background_tablet_url'),
  mobile: site.get('login_background_mobile_url'),
}));
const hasAuthBackground = computed(() => Object.values(authBackgrounds.value).some(Boolean));
const authBackToLogin = computed(() => ['/register', '/forgot-password'].includes(canonicalPath.value));
const authHeroKeys = ['home.hero', ...Array.from({ length: 9 }, (_, index) => `auth.hero_${index + 2}`)];
const authHeroIndex = ref(-1);
const authHeroKey = computed(() => authHeroKeys[authHeroIndex.value] ?? authHeroKeys[0]);
watch(
  () => route.path,
  () => {
    if (!authPage.value) return;
    const choices = authHeroKeys.map((_, index) => index).filter(index => index !== authHeroIndex.value);
    authHeroIndex.value = choices[Math.floor(Math.random() * choices.length)]!;
  },
  { immediate: true },
);
const adminPage = computed(() => route.path.startsWith('/admin'));
const siteName = computed(() => site.get('site_name') || i18n.t('home.title'));
const gameplayMenu = [
  { title: 'general.user-center', link: '/user', icon: 'space_dashboard' },
  { title: 'general.my-closet', link: '/closet', icon: 'checkroom' },
  { title: 'general.player-manage', link: '/player', icon: 'sports_esports' },
  { title: 'integration.modules.generator', link: '/user/config', icon: 'settings_suggest' },
];
const exploreMenu = computed(() => [
  { title: 'general.skinlib', link: '/skinlib', icon: 'grid_view' },
  ...(session.user.value && site.get('votes_enabled') !== 'false'
    ? [{ title: 'votes.title', link: '/votes', icon: 'how_to_vote' }]
    : []),
  { title: 'manual.title', link: '/manual', icon: 'menu_book' },
]);
const accountSupportMenu = [
  { title: 'general.profile', link: '/profile', icon: 'account_circle' },
  { title: 'devices.title', link: '/account/devices', icon: 'devices' },
  { title: 'oauth.applications', link: '/user/applications', icon: 'verified_user' },
  { title: 'ticket.title', link: '/tickets', icon: 'support_agent' },
  { title: 'general.my-reports', link: '/reports', icon: 'outlined_flag' },
];
const adminManagementMenu = [
  { title: 'general.dashboard', link: '/admin', icon: 'space_dashboard' },
  { title: 'general.user-manage', link: '/admin/users', icon: 'people_outline' },
  { title: 'general.player-manage', link: '/admin/players', icon: 'sports_esports' },
  { title: 'general.skinlib', link: '/admin/textures', icon: 'texture' },
  { title: 'admin.comments_title', link: '/admin/comments', icon: 'chat_bubble_outline' },
  { title: 'general.report-manage', link: '/admin/reports', icon: 'outlined_flag' },
  { title: 'ticket.manage', link: '/admin/tickets', icon: 'support_agent' },
  { title: 'ticket.category_manage', link: '/admin/ticket-categories', icon: 'category' },
  { title: 'votes.management', link: '/admin/votes', icon: 'how_to_vote' },
  { title: 'manual.manage', link: '/admin/manual', icon: 'menu_book' },
];
const adminConfigurationMenu = [
  { title: 'general.options', link: '/admin/settings', icon: 'tune' },
  { title: 'integration.title', link: '/admin/integrations', icon: 'extension' },
  { title: 'notif.title', link: '/admin/notifications', icon: 'notifications_none' },
  { title: 'live2d.title', link: '/admin/live2d', icon: 'face' },
  { title: 'general.i18n', link: '/admin/translations', icon: 'translate' },
  { title: 'pigeon.title', link: '/admin/pigeon-api', icon: 'vpn_key' },
];
const adminOperationsMenu = [
  { title: 'general.status', link: '/admin/status', icon: 'monitor_heart' },
  { title: 'admin.tasks_title', link: '/admin/tasks', icon: 'task_alt' },
  { title: 'admin.audit_log', link: '/admin/audit-log', icon: 'history' },
  { title: 'general.check-update', link: '/admin/update', icon: 'system_update_alt' },
];
const navigationGroups = computed(() => {
  if (adminPage.value) {
    return [
      { title: 'sidebar.management', icon: 'people_outline', items: adminManagementMenu },
      { title: 'sidebar.configuration', icon: 'tune', items: adminConfigurationMenu },
      { title: 'sidebar.operations', icon: 'monitor_heart', items: adminOperationsMenu },
    ];
  }
  if (!session.user.value) {
    return [
      { title: 'sidebar.explore_community', icon: 'explore', items: exploreMenu.value },
    ];
  }
  return [
    { title: 'sidebar.gameplay', icon: 'checkroom', items: gameplayMenu },
    { title: 'sidebar.explore_community', icon: 'explore', items: exploreMenu.value },
    { title: 'sidebar.account_support', icon: 'manage_accounts', items: accountSupportMenu },
  ];
});
const allNavItems = computed(() => [
  ...gameplayMenu,
  ...exploreMenu.value,
  { title: 'votes.title', link: '/votes', icon: 'how_to_vote' },
  ...accountSupportMenu,
  ...adminManagementMenu,
  ...adminConfigurationMenu,
  ...adminOperationsMenu,
]);
const activeTitle = computed(
  () =>
    (typeof route.meta.title === 'string' ? route.meta.title : undefined) ??
    allNavItems.value.find((x) => x.link === canonicalPath.value)?.title ??
    (route.path.startsWith('/skinlib') ? 'general.skinlib' : 'general.index'),
);
watch([site.settings, theme.isDark], ([settings, dark]) => applySiteTheme(settings, dark), {
  immediate: true,
});
watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false;
  },
);
watch(i18n.locale, () => {
  void site.fetch(true);
});
watch(
  [site.settings, i18n.locale, activeTitle, () => route.fullPath],
  () => {
    // 手册页与纹理详情页各自管理 SEO（后者按可见性决定 indexable），
    // 这里不再兜底覆写，避免两个写入者互相打架。
    if (route.meta.layout === 'manual' || route.meta.seoSelf) return;
    const metadata = baseMetadata(route.path, route.fullPath.split('?')[1]?.split('#')[0] || '', site.settings.value, `${i18n.t(activeTitle.value)} · ${siteName.value}`);
    if (route.path === '/') metadata.title = `${siteName.value} · ${i18n.t('seo.home')}`;
    if (route.path === '/skinlib') {
      // 与服务端预渲染（services/seo.ts）保持同一标题键，避免爬虫与用户看到不同标题
      metadata.title = `${i18n.t('seo.library')} · ${siteName.value}`;
      metadata.description = i18n.t('seo.description');
    }
    applyPageMetadata(metadata);
  },
  { immediate: true },
);
</script>
<template>
  <a
    class="skip-link"
    :class="{ 'keyboard-navigation': keyboardNavigation }"
    href="#main-content"
  >
    {{ i18n.t('common.skip_content') }}
  </a>
<main v-if="blocked" id="main-content" tabindex="-1" class="min-h-screen flex flex-col items-center justify-center gap-5 p-6"><AppIcon name="block" class="!text-4xl text-danger" /><h1 class="text-xl font-semibold">{{ i18n.t('auth.account_banned') }}</h1><AppButton class="btn-primary" :loading="session.logoutBusy.value" @click="session.logout">{{ i18n.t('general.logout') }}</AppButton></main>
  <template v-else-if="authPage">
    <div class="auth-shell">
      <picture v-if="hasAuthBackground" class="auth-mobile-background" aria-hidden="true">
        <source v-if="authBackgrounds.mobile || authBackgrounds.tablet" media="(max-width: 767px)" :srcset="authBackgrounds.mobile || authBackgrounds.tablet || authBackgrounds.desktop" />
        <source v-if="authBackgrounds.tablet" media="(min-width: 768px) and (max-width: 1024px)" :srcset="authBackgrounds.tablet" />
        <img :src="authBackgrounds.desktop || authBackgrounds.tablet || authBackgrounds.mobile" alt="" />
      </picture>
      <aside class="auth-art" :class="{ 'has-auth-background': hasAuthBackground }">
        <picture v-if="hasAuthBackground" class="auth-art-background" aria-hidden="true">
          <source v-if="authBackgrounds.mobile || authBackgrounds.tablet" media="(max-width: 767px)" :srcset="authBackgrounds.mobile || authBackgrounds.tablet || authBackgrounds.desktop" />
          <source v-if="authBackgrounds.tablet" media="(min-width: 768px) and (max-width: 1024px)" :srcset="authBackgrounds.tablet" />
          <img :src="authBackgrounds.desktop || authBackgrounds.tablet || authBackgrounds.mobile" alt="" />
        </picture>
        <router-link to="/" class="brand brand-minecraft">
          <span class="truncate">{{ siteName }}</span>
        </router-link>
        <div class="auth-pixels" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h2>{{ i18n.t(`${authHeroKey}_title`) }}</h2>
        <p>{{ i18n.t(`${authHeroKey}_description`) }}</p>
        <span class="text-xs opacity-60">{{ i18n.t('home.product') }}</span>
      </aside>
      <main id="main-content" tabindex="-1" class="auth-form">
        <div class="mb-8 flex items-center justify-between">
          <router-link :to="authBackToLogin ? '/login' : '/'" class="btn btn-sm">
            <AppIcon name="arrow_back" />
            {{ i18n.t(authBackToLogin ? 'general.login' : 'general.index') }}
          </router-link>
          <LocaleSelect />
        </div>
        <router-view v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <div class="route-page" :key="route.path">
              <component :is="Component" />
            </div>
          </Transition>
        </router-view>
      </main>
    </div>
  </template>
  <main v-else-if="route.meta.layout === 'manual'" id="main-content" tabindex="-1"><router-view /></main>
  <main v-else-if="route.path === '/' && site.get('home_style') === 'classic'" id="main-content" tabindex="-1"><HomeClassic /></main>
  <div v-else-if="route.path === '/'" class="public-shell">
    <header class="public-topbar">
      <div class="flex items-center justify-between w-full min-w-0">
        <router-link to="/" class="brand brand-minecraft">
          <span class="truncate">{{ siteName }}</span>
        </router-link>
        <div class="topbar-actions">
          <LocaleSelect />
          <AppButton class="btn-icon" :aria-label="i18n.t('common.theme')" :disabled="preferences.busy.value" @click="preferences.toggleTheme">
            <AppIcon :name="theme.isDark.value ? 'light_mode' : 'dark_mode'" />
          </AppButton>
          <router-link class="btn" :to="session.user.value ? '/user' : '/login'">
            {{ i18n.t(session.user.value ? 'general.user-center' : 'general.login') }}
          </router-link>
        </div>
      </div>
    </header>
    <main id="main-content" tabindex="-1"><router-view /></main>
    <SiteFooter class="public-footer" />
  </div>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': compactSidebar, 'guest-shell': !session.user.value }">
    <button
      v-if="sidebarOpen"
      type="button"
      class="mobile-scrim"
      :aria-label="i18n.t('common.close')"
      @click="sidebarOpen = false"
    />
    <aside id="app-sidebar" class="app-sidebar" :class="{ open: sidebarOpen, collapsed: compactSidebar }" :inert="mobile && !sidebarOpen" :aria-hidden="mobile && !sidebarOpen" @keydown.esc="sidebarOpen = false">
      <div class="sidebar-header">
        <router-link to="/" class="brand" :aria-label="siteName" :title="compactSidebar ? siteName : undefined">
          <span class="sidebar-text">{{ siteName }}</span>
        </router-link>
        <AppButton v-if="!mobile" class="btn-icon sidebar-toggle" :aria-label="i18n.t(compactSidebar ? 'sidebar.expand' : 'sidebar.collapse')" :aria-expanded="!compactSidebar" aria-controls="app-sidebar" @click="toggleSidebar">
          <AppIcon name="chevron_left" />
        </AppButton>
      </div>
      <div class="sidebar-navigation">
        <template v-for="group in navigationGroups" :key="group.title">
        <SidebarGroup v-if="compactSidebar" :title="i18n.t(group.title)" :icon="group.icon" :items="group.items.map(item => ({ ...item, title: i18n.t(item.title) }))" :active-path="canonicalPath" />
        <nav v-else class="nav-group" :aria-label="i18n.t(group.title)">
          <p class="nav-label">{{ i18n.t(group.title) }}</p>
          <SidebarLink
            v-for="item in group.items"
            :key="item.link"
            :to="item.link"
            :label="i18n.t(item.title)"
            :icon="item.icon"
            :active="canonicalPath === item.link || (['/skinlib', '/votes', '/tickets', '/admin/tickets', '/admin/integrations'].includes(item.link) && canonicalPath.startsWith(`${item.link}/`))"
          />
        </nav>
        </template>
        <SidebarLink
          v-if="session.isAdmin.value"
          :to="adminPage ? '/user' : '/admin'"
          :label="i18n.t(adminPage ? 'sidebar.back_to_user' : 'general.admin-panel')"
          :icon="adminPage ? 'arrow_back' : 'admin_panel_settings'"
          class="sidebar-switch"
        />
      </div>
      <div class="sidebar-bottom">
        <router-link v-if="session.user.value" to="/skinlib/upload" class="btn btn-primary w-full" :aria-label="i18n.t('skinlib.upload.title')" :title="i18n.t('skinlib.upload.title')">
          <AppIcon name="add" />
          <span class="sidebar-text">{{ i18n.t('skinlib.upload.title') }}</span>
        </router-link>
        <div v-if="session.user.value" class="sidebar-profile mt-5">
            <router-link to="/profile" class="avatar-placeholder" :aria-label="i18n.t('general.profile')" :title="session.user.value.nickname || session.user.value.email"><UserAvatar :texture-id="session.user.value.avatarTextureId" :user-id="session.user.value.id" :name="session.user.value.nickname" class="h-full w-full rounded" /></router-link>
          <div class="sidebar-text min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              {{ session.user.value.nickname || session.user.value.email }}
            </p>
            <p class="text-xs text-muted">
              {{ session.user.value ? i18n.t('common.score_value', { score: i18n.n(session.user.value.score) }) : i18n.t('home.product') }}
            </p>
          </div>
          <AppButton
            v-if="session.user.value"
            class="btn-icon"
            :loading="session.logoutBusy.value"
            :aria-label="i18n.t('general.logout')"
            @click="session.logout"
          >
            <AppIcon name="logout" />
          </AppButton>
        </div>
        <div v-if="!session.user.value" class="flex flex-col gap-2 border-t border-line pt-4">
          <router-link to="/login" class="btn btn-primary" :aria-label="i18n.t('general.login')" :title="i18n.t('general.login')">
            <AppIcon name="login" /><span class="sidebar-text">{{ i18n.t('general.login') }}</span>
          </router-link>
          <router-link
            v-if="site.get('registration_enabled') !== 'false'"
            to="/register"
            class="btn"
            :aria-label="i18n.t('auth.register')" :title="i18n.t('auth.register')"
          >
            <AppIcon name="person_add" /><span class="sidebar-text">{{ i18n.t('auth.register') }}</span>
          </router-link>
        </div>
      </div>
    </aside>
    <div class="app-body">
      <header class="app-topbar">
        <div class="flex items-center gap-2 min-w-0">
          <AppButton
            v-if="mobile && session.user.value"
            class="btn-icon"
            :aria-label="i18n.t('common.menu')"
            :aria-expanded="sidebarOpen"
            aria-controls="app-sidebar"
            @click="sidebarOpen = !sidebarOpen"
          >
            <AppIcon name="menu" />
          </AppButton>
          <router-link v-if="!session.user.value || mobile" to="/" class="brand brand-minecraft">
            <span class="truncate">{{ siteName }}</span>
          </router-link>
        </div>
        <div class="topbar-actions shrink-0">
          <NotificationBell v-if="session.user.value" />
          <AppButton
            class="btn-icon"
            :aria-label="i18n.t('common.theme')" :disabled="preferences.busy.value"
            @click="preferences.toggleTheme"
          >
            <AppIcon :name="theme.isDark.value ? 'light_mode' : 'dark_mode'" />
          </AppButton>
          <LocaleSelect />
          <router-link v-if="!session.user.value" to="/login" class="btn btn-sm">
            {{ i18n.t('general.login') }}
          </router-link>
        </div>
      </header>
      <div class="app-scroll">
        <main id="main-content" tabindex="-1" class="app-content">
          <router-view v-slot="{ Component }">
            <Transition name="page" mode="out-in">
              <div class="route-page" :key="route.path">
                <component :is="Component" />
              </div>
            </Transition>
          </router-view>
        </main>
        <SiteFooter />
      </div>
    </div>
  </div>
  <ActionDialog />
  <SkinlibChallengeDialog />
  <Live2DWidget v-if="!blocked && !authPage && !route.path.startsWith('/manual') && !['/admin/live2d', '/admin/manual', '/auth/initialize'].includes(route.path)" />
  <AppDialog v-model="sessionErrorOpen" :title="i18n.t('general.notice')">
    <AppAlert variant="danger" role="alert">{{ i18n.t(session.error.value) }}</AppAlert>
  </AppDialog>
</template>
<style scoped>
.auth-pixels {
  position: absolute;
  top: clamp(120px, 22vh, 300px);
  right: clamp(28px, 7vw, 120px);
  width: clamp(150px, 18vw, 280px);
  height: clamp(150px, 18vw, 280px);
  transform: rotate(-12deg);
  pointer-events: none;
}
.auth-pixels span {
  display: block;
  width: 38%;
  height: 38%;
  background: var(--brand-base);
  position: absolute;
  box-shadow: clamp(6px, 1vw, 12px) clamp(6px, 1vw, 12px) 0 var(--brand-deep);
}
.auth-pixels span:nth-child(2) {
  left: 46%;
  top: 22%;
  background: var(--brand-soft);
}
.auth-pixels span:nth-child(3) {
  left: 15%;
  top: 62%;
  background: var(--brand-ink);
  width: 25%;
  height: 25%;
}
@media (max-height: 760px) and (min-width: 768px) {
  .auth-art { padding-block: 28px; }
  .auth-art h2 { padding-top: 32px; }
  .auth-pixels { top: 18%; transform: rotate(-12deg) scale(0.82); transform-origin: top right; }
}
</style>
