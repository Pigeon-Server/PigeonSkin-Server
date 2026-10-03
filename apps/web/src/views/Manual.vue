<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { manualSections } from '@/content/manual';
import { useManualStore } from '@/stores/manual';
import { useSessionStore } from '@/stores/session';
import { useSiteSettings } from '@/stores/site';
import { useI18n } from '@/stores/i18n';
import { useTheme } from '@/composables/theme';
import { usePreferences } from '@/composables/preferences';
import ManualNavigation from '@/components/manual/ManualNavigation.vue';
import ManualMarkdown from '@/components/manual/ManualMarkdown.vue';
import SiteFooter from '@/components/SiteFooter.vue';
import LocaleSelect from '@/components/LocaleSelect.vue';
import { LOCALES, localeTag, normalizeLocale } from '@pigeon-skin/shared/locales';
import { applyPageMetadata, baseMetadata } from '@/lib/seo';

const route = useRoute();
const router = useRouter();
const site = useSiteSettings();
const i18n = useI18n();
const theme = useTheme();
const preferences = usePreferences();
const manual = useManualStore();
const session = useSessionStore();
const siteName = computed(() => site.get('site_name') || i18n.t('home.title'));
const slug = computed(() => String(route.params.slug || ''));
const page = computed(() => manual.pages.value.find(item => item.slug === slug.value));
const sections = computed(() => manualSections(manual.content(slug.value)));
const outline = computed(() => sections.value.filter(section => section.title));
const pageIndex = computed(() => manual.pages.value.findIndex(item => item.slug === slug.value));
const previous = computed(() => manual.pages.value[pageIndex.value - 1]);
const next = computed(() => manual.pages.value[pageIndex.value + 1]);
const shortcuts = computed(() => manual.pages.value.filter(item => ['quick-start', 'faq'].includes(item.slug)));
const path = (value: string) => `/manual${value ? `/${value}` : ''}`;
const previousSitePath = (() => {
  const previous = router.options.history.state.back;
  return typeof previous === 'string' && previous.startsWith('/') && !previous.startsWith('/manual')
    ? previous
    : '/';
})();
function returnToSite() { void router.push(previousSitePath); }
const activeSection = ref('');
const outlineOpen = ref(false);
const article = ref<HTMLElement>();
const viewport = ref<HTMLElement>();
const searchOpen = ref(false);
const query = ref('');
const results = computed(() => manual.search(query.value));
const searchDialog = ref<HTMLDialogElement>();
const searchInput = ref<HTMLInputElement>();
const menuOpen = ref(false);
const menuDialog = ref<HTMLDialogElement>();
const menuButton = ref<HTMLButtonElement>();
const imageDialog = ref<HTMLDialogElement>();
const image = ref<{ source: string; caption: string } | null>(null);
const mobileQuery = matchMedia('(max-width: 767px)');
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

function updateSection() {
  let current = outline.value[0]?.id || '';
  for (const section of outline.value) {
    if ((document.getElementById(section.id)?.getBoundingClientRect().top ?? Infinity) <= 160) current = section.id;
  }
  const scroller = viewport.value;
  if (scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = outline.value.at(-1)?.id || current;
  activeSection.value = current;
}
function keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchOpen.value = true;
  }
}
function resize() { if (!mobileQuery.matches) menuOpen.value = false; }
function showImage(source: string, caption: string) { image.value = { source, caption }; }
function closeSearch() { searchOpen.value = false; }
function closeMenu() { menuOpen.value = false; }
function closeImage() { image.value = null; }
function backdrop(event: MouseEvent, close: () => void) { if (event.target === event.currentTarget) close(); }
function articleEntered() {
  if (route.hash) document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start', behavior: motionQuery.matches ? 'instant' : 'smooth' });
  article.value?.focus({ preventScroll: true });
  updateSection();
}

watch(searchOpen, async open => {
  await nextTick();
  if (open) { menuOpen.value = false; searchDialog.value?.showModal(); searchInput.value?.focus(); }
  else { searchDialog.value?.close(); query.value = ''; }
});
watch(menuOpen, async open => {
  await nextTick();
  if (open) menuDialog.value?.showModal();
  else menuDialog.value?.close();
});
watch(image, async value => {
  await nextTick();
  if (value) imageDialog.value?.showModal();
  else imageDialog.value?.close();
});
watch([page, siteName, site.settings], () => {
  const metadata = baseMetadata(route.path, '', site.settings.value, `${page.value?.title || i18n.t('common.not_found')} · ${siteName.value}`);
  metadata.description = page.value?.description || '';
  metadata.indexable = !!page.value;
  metadata.alternateLocales = manual.documents.value.find(item => item.slug === slug.value)?.availableLocales || LOCALES;
  const updatedAt = manual.documents.value.find(item => item.slug === slug.value)?.updatedAt;
  if (page.value) metadata.structuredData = [{ '@type': 'TechArticle', headline: page.value.title, description: page.value.description, url: metadata.canonical, inLanguage: localeTag(manual.contentLocale(slug.value)), ...(updatedAt ? { dateModified: new Date(updatedAt).toISOString() } : {}) }];
  applyPageMetadata(metadata);
}, { immediate: true });
watch(i18n.locale, () => { void manual.fetch(); });
watch(() => route.fullPath, async (value, oldValue) => {
  if (oldValue && value.split('#')[0] !== oldValue.split('#')[0]) void manual.fetch(true);
  searchOpen.value = false;
  menuOpen.value = false;
  image.value = null;
  if (value.split('#')[0] !== oldValue?.split('#')[0]) outlineOpen.value = false;
  await nextTick();
  if (route.hash) document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start', behavior: motionQuery.matches ? 'instant' : 'smooth' });
  else viewport.value?.scrollTo({ top: 0, behavior: 'instant' });
  if (!oldValue || value.split('#')[0] === oldValue.split('#')[0]) updateSection();
}, { immediate: true });
onMounted(() => {
  void manual.fetch(true);
  window.addEventListener('keydown', keydown);
  mobileQuery.addEventListener('change', resize);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keydown);
  mobileQuery.removeEventListener('change', resize);
  searchDialog.value?.close(); menuDialog.value?.close(); imageDialog.value?.close();
});
</script>

<template>
  <div class="manual-shell" :lang="localeTag(normalizeLocale(i18n.locale.value))">
    <header class="manual-header">
      <router-link to="/manual" class="manual-brand"><AppIcon name="menu_book" /><span><strong>{{ siteName }}</strong><small> {{ i18n.t('manual.title') }} </small></span></router-link>
      <button type="button" class="manual-search-trigger" :aria-label="i18n.t('manual.search')" @click="searchOpen = true"><AppIcon name="search" /><span> {{ i18n.t('manual.search') }} </span><kbd>Ctrl / ⌘ K</kbd></button>
      <div class="manual-header-actions"><LocaleSelect />
        <button type="button" class="manual-back" :aria-label="i18n.t('manual.back')" @click="returnToSite"><AppIcon name="arrow_back" /><span> {{ i18n.t('manual.back') }} </span></button>
        <button type="button" class="manual-icon-button" :disabled="preferences.busy.value" :aria-label="i18n.t(theme.isDark.value ? 'manual.light' : 'manual.dark')" @click="preferences.toggleTheme"><AppIcon :name="theme.isDark.value ? 'light_mode' : 'dark_mode'" /></button>
        <button ref="menuButton" type="button" class="manual-icon-button manual-menu-toggle" :aria-label="i18n.t('manual.open_navigation')" aria-controls="manual-mobile-navigation" :aria-expanded="menuOpen" @click="menuOpen = true"><AppIcon name="menu" /></button>
      </div>
    </header>

    <div ref="viewport" class="manual-viewport" @scroll.passive="updateSection">
    <div id="manual-top" class="manual-layout">
      <aside class="manual-sidebar"><ManualNavigation :active-slug="slug" /></aside>
      <div class="manual-reading">
        <Transition name="manual-page" mode="out-in" @after-enter="articleEntered">
        <article :key="slug" ref="article" tabindex="-1" class="manual-article" :lang="localeTag(manual.contentLocale(slug))">
          <p v-if="manual.error.value" class="alert alert-danger" role="alert">{{ i18n.t('manual.load_error') }}<button type="button" @click="manual.fetch(true)"> {{ i18n.t('common.retry') }} </button></p>
          <AppSkeleton v-if="manual.loading.value && !manual.loaded.value" :count="3" />
          <template v-else-if="page">
            <header class="manual-heading"><p>{{ page.group }}</p><h1>{{ page.title }}</h1><p class="manual-description">{{ page.description }}</p></header>
            <div v-if="!slug" class="manual-shortcuts">
              <router-link v-for="item in shortcuts" :key="item.slug" :to="path(item.slug)"><AppIcon :name="item.slug === 'faq' ? 'help_outline' : 'school'" /><strong>{{ item.title }}</strong><span>{{ item.description }}</span><AppIcon name="arrow_forward" /></router-link>
            </div>
            <section v-if="outline.length" class="manual-mobile-outline"><button type="button" class="manual-outline-toggle" :aria-expanded="outlineOpen" aria-controls="manual-outline-links" @click="outlineOpen = !outlineOpen"><AppIcon name="chevron_right" :class="{ expanded: outlineOpen }" /> {{ i18n.t('manual.outline') }} </button><div class="manual-outline-collapse" :class="{ expanded: outlineOpen }"><div id="manual-outline-links" :inert="!outlineOpen"><a v-for="section in outline" :key="section.id" :href="`#${section.id}`">{{ section.title }}</a></div></div></section>
            <section v-for="section in sections" :id="section.id" :key="section.id" class="manual-section">
              <h2 v-if="section.title"><a :href="`#${section.id}`">{{ section.title }}<span aria-hidden="true">#</span></a></h2>
              <ManualMarkdown :content="section.content" @image="showImage" />
            </section>
            <router-link v-if="session.isAdmin.value" :to="{ path: '/admin/manual', query: { document: slug } }" class="manual-home-link"> {{ i18n.t('manual.edit_page') }} </router-link>
            <nav class="manual-pager" :aria-label="i18n.t('manual.pagination')">
              <router-link v-if="previous" :to="path(previous.slug)"><small> {{ i18n.t('common.prev') }} </small><strong>← {{ previous.title }}</strong></router-link><span v-else />
              <router-link v-if="next" :to="path(next.slug)" class="manual-next"><small> {{ i18n.t('common.next') }} </small><strong>{{ next.title }} →</strong></router-link>
            </nav>
          </template>
          <template v-else><h1> {{ i18n.t('manual.not_found') }} </h1><p class="manual-description"> {{ i18n.t('manual.not_found_description') }} </p><router-link to="/manual" class="manual-home-link"> {{ i18n.t('manual.home') }} </router-link></template>
        </article>
        </Transition>
        <SiteFooter class="manual-footer" />
      </div>
      <aside v-if="page" class="manual-outline" :aria-label="i18n.t('manual.outline')"><p> {{ i18n.t('manual.outline') }} </p><a v-for="section in outline" :key="section.id" :href="`#${section.id}`" :class="{ current: activeSection === section.id }" :aria-current="activeSection === section.id ? 'location' : undefined">{{ section.title }}</a><a href="#manual-top" class="manual-top"> {{ i18n.t('manual.top') }} </a></aside>
    </div>
    </div>

    <dialog id="manual-mobile-navigation" ref="menuDialog" class="manual-drawer" aria-labelledby="manual-menu-title" @cancel.prevent="closeMenu" @click="backdrop($event, closeMenu)">
      <div class="manual-dialog-heading"><h2 id="manual-menu-title"> {{ i18n.t('manual.navigation') }} </h2><button type="button" class="manual-icon-button" :aria-label="i18n.t('manual.close_navigation')" @click="closeMenu"><AppIcon name="close" /></button></div>
      <ManualNavigation class="manual-drawer-navigation" :active-slug="slug" @navigate="closeMenu" />
    </dialog>
    <dialog ref="searchDialog" class="manual-search-dialog" :aria-label="i18n.t('manual.search')" @cancel.prevent="closeSearch" @click="backdrop($event, closeSearch)">
      <div class="manual-search-field"><AppIcon name="search" /><input ref="searchInput" v-model="query" type="search" :placeholder="i18n.t('manual.search')" :aria-label="i18n.t('manual.search')" aria-controls="manual-results" /><button type="button" class="manual-icon-button" :aria-label="i18n.t('manual.close_search')" @click="closeSearch"><AppIcon name="close" /></button></div>
      <div id="manual-results" class="manual-results"><p v-if="!query.trim()" class="manual-search-hint"> {{ i18n.t('manual.search_hint') }} </p><template v-else><p class="manual-search-hint" role="status">{{ results.length ? i18n.t('manual.search_count', { count: i18n.n(results.length) }) : i18n.t('manual.search_empty') }}</p><router-link v-for="result in results" :key="result.slug" :to="path(result.slug)" @click="closeSearch"><small>{{ result.group }}</small><strong>{{ result.title }}</strong><span>{{ result.description }}</span></router-link></template></div>
      <footer class="manual-search-footer"><span> {{ i18n.t('manual.search_keyboard') }} </span><span> {{ i18n.t('manual.escape') }} </span></footer>
    </dialog>
    <dialog ref="imageDialog" class="manual-image-dialog" :aria-label="i18n.t('manual.view_screenshot')" @cancel.prevent="closeImage" @click="backdrop($event, closeImage)">
      <div v-if="image" class="manual-image-view"><button type="button" class="manual-icon-button" :aria-label="i18n.t('manual.close_image')" @click="closeImage"><AppIcon name="close" /></button><img :src="image.source" :alt="image.caption" /><p>{{ image.caption }}</p><a :href="image.source" target="_blank" rel="noopener"> {{ i18n.t('manual.original_image') }} </a></div>
    </dialog>
  </div>
</template>

<style scoped>
.manual-shell { --manual-header-height: 72px; background: var(--v0-surface); color: var(--ink); height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
:global(html:has(.manual-shell)) { scrollbar-gutter: auto; overflow: hidden; }
:global(body:has(.manual-shell dialog[open])) { overflow: hidden; }
.manual-header { position: relative; z-index: 30; height: var(--manual-header-height); flex-shrink: 0; display: flex; align-items: center; gap: 32px; padding: 0 32px; background: var(--v0-surface); border-bottom: 1px solid var(--v0-border); transition: background-color .2s, border-color .2s; }
.manual-viewport { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scroll-behavior: smooth; }
.manual-shell:has(dialog[open]) .manual-viewport { overflow: hidden; }
.manual-brand { display: flex; align-items: center; gap: 12px; min-width: 0; width: 220px; flex-shrink: 0; }
.manual-brand > .material-icons { font-size: 26px; color: var(--brand); flex-shrink: 0; }
.manual-brand > span { min-width: 0; }
.manual-brand strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: 'Minecraft', Inter, 'Segoe UI', sans-serif; font-size: 14px; font-weight: 650; }
.manual-brand small { display: block; font-size: 11px; color: var(--v0-muted); margin-top: 2px; }
.manual-search-trigger { display: flex; align-items: center; gap: 10px; width: min(340px, 35vw); padding: 10px 12px; border: 1px solid var(--v0-border); border-radius: 8px; background: var(--v0-surface-2); color: var(--v0-muted); text-align: left; font-size: 13px; }
.manual-search-trigger kbd { margin-left: auto; font-size: 10px; white-space: nowrap; }
.manual-header-actions { display: flex; align-items: center; gap: 20px; margin-left: auto; flex-shrink: 0; }
.manual-back { display: flex; align-items: center; gap: 6px; padding: 0; border: 0; background: transparent; color: inherit; font-size: 13px; }
.manual-back .material-icons { font-size: 18px; }
.manual-icon-button { display: inline-flex; justify-content: center; align-items: center; width: 36px; height: 36px; flex-shrink: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; }
.manual-icon-button:hover { background: var(--v0-surface-2); }
.manual-menu-toggle { display: none; }
.manual-layout { display: grid; grid-template-columns: 252px minmax(0, 820px) minmax(180px, 1fr); max-width: 1440px; margin: auto; min-height: calc(100dvh - var(--manual-header-height)); align-items: start; }
.manual-sidebar { position: sticky; top: 0; height: calc(100dvh - var(--manual-header-height)); overflow-y: auto; overscroll-behavior: contain; background: var(--v0-surface-2); border-right: 1px solid var(--v0-border); scrollbar-width: thin; }
.manual-reading { min-width: 0; }
.manual-article { padding: 48px 56px 32px; min-width: 0; outline: none; }
.manual-heading > p:first-child { margin: 0 0 12px; font-size: 12px; font-weight: 650; color: var(--brand); }
.manual-heading h1, .manual-article > h1 { margin: 0; font-size: 32px; line-height: 1.4; font-weight: 700; letter-spacing: -.5px; overflow-wrap: break-word; }
.manual-description { margin: 16px 0 32px; color: var(--v0-muted); font-size: 15px; line-height: 1.8; }
.manual-section { scroll-margin-top: 24px; }
.manual-section + .manual-section { margin-top: 36px; }
.manual-section h2 { margin: 0 0 20px; padding-top: 28px; border-top: 1px solid var(--v0-border); font-size: 22px; line-height: 1.5; font-weight: 650; }
.manual-section h2 a { display: inline-flex; align-items: baseline; gap: 10px; }
.manual-section h2 span { color: var(--brand); opacity: 0; font-size: 16px; }
.manual-section h2 a:hover span, .manual-section h2 a:focus-visible span { opacity: 1; }
.manual-outline { position: sticky; top: 36px; padding: 0 28px 0 20px; margin: 48px 0; border-left: 1px solid var(--v0-border); max-height: calc(100dvh - var(--manual-header-height) - 72px); overflow-y: auto; font-size: 12px; }
.manual-outline p { font-weight: 650; margin: 0 0 12px; }
.manual-outline a { display: block; color: var(--v0-muted); padding: 6px 0; line-height: 1.65; }
.manual-outline a.current { color: var(--brand); font-weight: 650; }
.manual-outline .manual-top { margin-top: 16px; }
.manual-mobile-outline { display: none; }
.manual-outline-toggle { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; font-size: 13px; font-weight: 600; }
.manual-outline-toggle .material-icons { font-size: 18px; transition: transform .18s; }
.manual-outline-toggle .expanded { transform: rotate(90deg); }
.manual-outline-collapse { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .2s ease, opacity .18s; }
.manual-outline-collapse.expanded { grid-template-rows: 1fr; opacity: 1; }
.manual-outline-collapse > div { overflow: hidden; min-height: 0; }
.manual-shortcuts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px; }
.manual-shortcuts a { display: grid; grid-template-columns: 1fr auto; align-content: start; gap: 12px; padding: 22px; border: 1px solid var(--v0-border); border-radius: 10px; transition: transform .2s, border-color .2s, background-color .2s; }
.manual-shortcuts a:hover { border-color: var(--brand); background: var(--v0-surface-2); transform: translateY(-2px); }
.manual-shortcuts a > .material-icons:first-child { color: var(--brand); grid-column: 1 / -1; font-size: 26px; }
.manual-shortcuts strong { font-size: 16px; }
.manual-shortcuts span { grid-column: 1 / -1; color: var(--v0-muted); font-size: 13px; line-height: 1.8; }
.manual-shortcuts a > .material-icons:last-child { grid-column: 2; grid-row: 2; color: var(--brand); font-size: 20px; }
.manual-pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--v0-border); }
.manual-pager a { padding: 16px; border: 1px solid var(--v0-border); border-radius: 8px; }
.manual-pager a:hover { border-color: var(--brand); }
.manual-pager small { display: block; margin-bottom: 6px; color: var(--v0-muted); font-size: 12px; }
.manual-pager strong { color: var(--brand); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.manual-next { text-align: right; }
.manual-home-link { color: var(--brand); }
.manual-footer { margin: 0 56px; padding: 24px 0 32px; border-top: 1px solid var(--v0-border); font-size: 11px; line-height: 1.7; flex-wrap: wrap; gap: 12px; background: transparent; }
.manual-footer :deep(.footer-credit) { margin-left: 0; }
.manual-shell :is(a, button, input, summary):focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
dialog { color: var(--ink); background: var(--v0-surface); border: 1px solid var(--v0-border); opacity: 0; transform: translateY(10px) scale(.98); transition: opacity .18s ease, transform .18s ease, display .18s allow-discrete, overlay .18s allow-discrete; }
dialog[open] { opacity: 1; transform: translateY(0) scale(1); }
dialog::backdrop { background: #0007; opacity: 0; transition: opacity .18s ease, display .18s allow-discrete, overlay .18s allow-discrete; }
dialog[open]::backdrop { opacity: 1; }
.manual-page-enter-active, .manual-page-leave-active { transition: opacity .16s ease, transform .16s ease; }
.manual-page-enter-from { opacity: 0; transform: translateY(8px); }
.manual-page-leave-to { opacity: 0; transform: translateY(-4px); }
.manual-drawer { position: fixed; inset: 0 auto 0 0; margin: 0; width: min(340px, 90vw); max-width: 90vw; height: 100dvh; max-height: 100dvh; overflow: hidden; background: var(--v0-surface-2); border: 0; }
.manual-drawer-navigation { height: calc(100dvh - 69px); overflow-y: auto; overscroll-behavior: contain; }
.manual-drawer:not([open]) { transform: translateX(-100%); }
.manual-drawer[open] { transform: translateX(0); }
.manual-dialog-heading { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--v0-border); background: var(--v0-surface-2); }
.manual-dialog-heading h2 { font-size: 16px; font-weight: 650; }
.manual-search-dialog { position: fixed; inset: 12vh 0 auto; margin: 0 auto; padding: 0; width: min(640px, calc(100vw - 32px)); max-height: 76dvh; border-radius: 12px; box-shadow: 0 16px 80px #0003; overflow: hidden; }
.manual-search-field { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--v0-border); }
.manual-search-field > .material-icons { color: var(--v0-muted); }
.manual-search-field input { min-width: 0; width: 100%; padding: 8px 0; background: transparent; font-size: 16px; outline: none; }
.manual-results { max-height: 50dvh; overflow-y: auto; padding: 12px; }
.manual-search-hint { padding: 12px 8px; color: var(--v0-muted); font-size: 13px; }
.manual-results a { display: flex; flex-direction: column; gap: 6px; padding: 14px; border-radius: 6px; }
.manual-results a:hover { background: var(--v0-surface-2); }
.manual-results small { color: var(--v0-muted); font-size: 11px; }
.manual-results strong { font-size: 15px; color: var(--brand); }
.manual-results span { font-size: 13px; line-height: 1.7; color: var(--v0-muted); }
.manual-search-footer { display: flex; justify-content: space-between; padding: 12px 20px; border-top: 1px solid var(--v0-border); color: var(--v0-muted); font-size: 11px; }
.manual-image-dialog { position: fixed; inset: 0; padding: 0; margin: auto; width: min(1480px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); border-radius: 10px; }
.manual-image-view { position: relative; padding: 48px 20px 20px; text-align: center; }
.manual-image-view > button { position: absolute; top: 6px; right: 8px; }
.manual-image-view img { display: block; max-width: 100%; max-height: calc(100dvh - 170px); margin: auto; object-fit: contain; }
.manual-image-view p { margin: 12px 0 8px; font-size: 13px; line-height: 1.6; }
.manual-image-view a { color: var(--brand); font-size: 12px; }
@starting-style {
  dialog[open] { opacity: 0; transform: translateY(10px) scale(.98); }
  dialog[open]::backdrop { opacity: 0; }
  .manual-drawer[open] { opacity: 0; transform: translateX(-100%); }
}
@media (min-width: 1441px) { .manual-header { padding-inline: max(32px, calc((100vw - 1376px) / 2)); } }
@media (max-width: 1199px) { .manual-layout { grid-template-columns: 232px minmax(0, 1fr); } .manual-outline { display: none; } .manual-article { padding: 40px; } .manual-footer { margin-inline: 40px; } .manual-brand { width: 200px; } .manual-header { gap: 24px; } .manual-mobile-outline { display: block; border: 1px solid var(--v0-border); border-radius: 8px; padding: 12px 16px; margin-bottom: 28px; font-size: 13px; } .manual-mobile-outline summary { cursor: pointer; font-weight: 600; list-style: revert; } .manual-mobile-outline a { display: block; padding: 8px 0; color: var(--v0-muted); } .manual-mobile-outline a:first-of-type { margin-top: 8px; } }
@media (max-width: 767px) {
  .manual-shell { --manual-header-height: 64px; }
  .manual-header { padding: 0 16px; gap: 10px; }
  .manual-brand { width: auto; flex: 1; gap: 8px; }
  .manual-brand > .material-icons { font-size: 22px; }
  .manual-brand strong { font-size: 12px; }
  .manual-header-actions { gap: 2px; margin: 0; }
  .manual-back { width: 32px; height: 36px; justify-content: center; }
  .manual-back span:not(.material-icons) { display: none; }
  .manual-search-trigger { width: 36px; height: 36px; padding: 0; align-items: center; justify-content: center; border: 0; background: transparent; flex-shrink: 0; }
  .manual-search-trigger span:not(.material-icons), .manual-search-trigger kbd { display: none; }
  .manual-menu-toggle { display: inline-flex; }
  .manual-layout { display: block; }
  .manual-sidebar { display: none; }
  .manual-article { padding: 28px 20px 24px; }
  .manual-heading h1 { font-size: 27px; }
  .manual-description { font-size: 14px; margin-bottom: 24px; }
  .manual-section h2 { font-size: 20px; padding-top: 24px; }
  .manual-shortcuts { grid-template-columns: 1fr; }
  .manual-pager { gap: 10px; }
  .manual-pager a { padding: 12px; }
  .manual-pager strong { font-size: 12px; }
  .manual-footer { margin-inline: 20px; flex-direction: column; align-items: flex-start; text-align: left; }
  .manual-search-dialog { inset-block-start: 16px; max-height: calc(100dvh - 32px); }
  .manual-results { max-height: calc(100dvh - 180px); }
}
@media print { :global(html:has(.manual-shell)) { overflow: visible; } .manual-shell { height: auto; overflow: visible; } .manual-viewport { overflow: visible; } .manual-header, .manual-sidebar, .manual-outline, .manual-pager, .manual-mobile-outline, .manual-footer { display: none; } .manual-layout { display: block; } .manual-article { padding: 0; } }
@media (prefers-reduced-motion: reduce) { .manual-viewport { scroll-behavior: auto; } .manual-shell :deep(*), .manual-shell :deep(*::before), .manual-shell :deep(*::after) { transition-duration: 0s !important; animation-duration: 0s !important; } dialog, dialog::backdrop { transition-duration: 0s !important; } }
</style>
