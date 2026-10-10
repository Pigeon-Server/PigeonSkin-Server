<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { textureApi, textureUrl, type TextureSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useSiteSettings } from '@/stores/site';
import SkinPreview from '@/components/SkinPreview.vue';
import SkinViewer from '@/components/SkinViewer.vue';
import { defaultSkinUrl } from '@/lib/default-skin';

const i18n = useI18n();
const session = useSessionStore();
const site = useSiteSettings();
const featured = ref<TextureSummary[]>([]);
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
const activeHeadline = ref(headlines.value[0]!);
const visibleHeadline = ref('');
const reducedMotion = ref(false);
let headlineTimer = 0;
let headlineCharacters: string[] = [];
let headlinePosition = 0;
let headlineSelected = false;
function clearHeadlineTimer() {
  window.clearTimeout(headlineTimer);
}
function chooseHeadline() {
  clearHeadlineTimer();
  const options = headlines.value;
  const choices = options.map((_, index) => index).filter(index => !headlineSelected || options[index] !== activeHeadline.value);
  activeHeadline.value = options[choices[Math.floor(Math.random() * choices.length)] ?? 0]!;
  headlineSelected = true;
  headlineCharacters = Array.from(activeHeadline.value);
  headlinePosition = 0;
  visibleHeadline.value = '';
  if (!reducedMotion.value) typeHeadline();
  else visibleHeadline.value = activeHeadline.value;
}
function typeHeadline() {
  if (headlinePosition < headlineCharacters.length) {
    const character = headlineCharacters[headlinePosition++]!;
    visibleHeadline.value += character;
    headlineTimer = window.setTimeout(typeHeadline, character === '\n' ? 420 : 145);
  } else headlineTimer = window.setTimeout(eraseHeadline, 3000);
}
function eraseHeadline() {
  if (headlinePosition > 0) {
    headlinePosition--;
    visibleHeadline.value = headlineCharacters.slice(0, headlinePosition).join('');
    headlineTimer = window.setTimeout(eraseHeadline, 48);
  } else headlineTimer = window.setTimeout(chooseHeadline, 500);
}
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
function updateMotion(event: MediaQueryList | MediaQueryListEvent = motionQuery) {
  reducedMotion.value = event.matches;
  if (reducedMotion.value) {
    clearHeadlineTimer();
    if (!headlineSelected) chooseHeadline();
    else visibleHeadline.value = activeHeadline.value;
  } else chooseHeadline();
}
const features = [
  { icon: 'texture', title: 'home.f_upload_title', body: 'home.f_upload_body' },
  { icon: 'sports_esports', title: 'home.f_player_title', body: 'home.f_player_body' },
  { icon: 'hub', title: 'home.f_api_title', body: 'home.f_api_body' },
];
onMounted(async () => {
  motionQuery.addEventListener('change', updateMotion);
  updateMotion();
  try {
    const pool = (await textureApi.list({ perPage: 18, kind: 'skin', sort: 'created' })).items;
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const item = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = item;
    }
    featured.value = pool.slice(0, 3);
  }
  catch { featured.value = []; }
});
watch(i18n.locale, chooseHeadline);
onBeforeUnmount(() => {
  clearHeadlineTimer();
  motionQuery.removeEventListener('change', updateMotion);
});
</script>

<template>
  <section class="home-hero" :class="{ 'home-hero-fixed': site.get('home_fixed_background') === 'true' }">
    <picture v-if="hasBackground" class="home-hero-background" aria-hidden="true">
      <source v-if="backgrounds.mobile || backgrounds.tablet" media="(max-width: 767px)" :srcset="backgrounds.mobile || backgrounds.tablet || backgrounds.desktop" />
      <source v-if="backgrounds.tablet" media="(min-width: 768px) and (max-width: 1024px)" :srcset="backgrounds.tablet" />
      <img :src="backgrounds.desktop || backgrounds.tablet || backgrounds.mobile" alt="" />
    </picture>
    <div class="hero-copy">
      <h1 class="hero-headline" :aria-label="activeHeadline">
        <span aria-hidden="true">{{ visibleHeadline }}</span><span class="hero-headline-caret" aria-hidden="true" />
      </h1>
      <p class="hero-description">{{ site.get('site_description') || i18n.t('home.hero_description') }}</p>
      <div class="mt-8 flex flex-wrap gap-3">
        <router-link to="/skinlib" class="btn btn-primary !px-6 !py-3">{{ i18n.t('home.cta_browse') }}<AppIcon name="arrow_forward" /></router-link>
        <router-link v-if="session.user.value" to="/user" class="btn !px-6 !py-3">{{ i18n.t('general.user-center') }}</router-link>
        <router-link v-else-if="site.get('registration_enabled') !== 'false'" to="/register" class="btn !px-6 !py-3">{{ i18n.t('home.cta_register') }}</router-link>
      </div>
    </div>
    <div class="hero-gallery" :data-count="featured.length">
      <div class="hero-grid" aria-hidden="true" />
      <router-link v-for="(item, index) in featured" :key="item.id" :to="`/skinlib/${item.id}`" class="hero-skin" :class="`hero-skin-${index}`">
        <SkinViewer v-if="featured.length === 1" :skin-url="textureUrl(item.hash)" :slim="item.model === 'slim'" :height="260" :animated="false" :controls="false" />
        <SkinPreview v-else :skin-url="textureUrl(item.hash)" :slim="item.model === 'slim'" :alt="item.name" />
        <span>{{ item.name }}</span>
      </router-link>
      <div v-if="!featured.length" class="hero-placeholder" aria-hidden="true">
        <SkinViewer :skin-url="defaultSkinUrl" :height="320" :animated="false" :controls="false" class="min-w-0" />
      </div>
    </div>
  </section>
  <section v-if="site.get('home_show_intro') !== 'false'" class="home-features">
    <article v-for="feature in features" :key="feature.title"><div class="feature-icon"><AppIcon :name="feature.icon" /></div><h2>{{ i18n.t(feature.title) }}</h2><p>{{ i18n.t(feature.body) }}</p></article>
  </section>
</template>

<style scoped>
.home-hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:center; gap:clamp(32px,5vw,100px); padding:clamp(48px,7vh,100px) var(--public-inset); min-height:560px; flex:1; position:relative; isolation:isolate; overflow:hidden; }
.home-hero-background { position:absolute; inset:0; z-index:-1; pointer-events:none; }
.home-hero-background::after { content:''; position:absolute; inset:0; background:linear-gradient(90deg, color-mix(in srgb, var(--canvas) 96%, transparent), color-mix(in srgb, var(--canvas) 44%, transparent) 58%, transparent); }
.home-hero-background img { width:100%; height:100%; object-fit:cover; }
.home-hero-fixed .home-hero-background { position:fixed; height:100vh; }
.hero-copy { min-width:0; }
.hero-copy h1 { font-size:clamp(40px,4.4vw,80px); line-height:1.12; letter-spacing:-2.5px; font-weight:700; max-width:650px; white-space:pre-line; }
.hero-headline { min-height:2.24em; }
.hero-headline-caret { display:inline-block; width:2px; height:.9em; margin-left:.08em; vertical-align:-.05em; background:currentColor; animation:hero-caret-blink 1.2s steps(2,start) infinite; }
@keyframes hero-caret-blink { to { visibility:hidden; } }
.hero-description { color:var(--v0-muted); font-size:16px; max-width:410px; margin-top:24px; line-height:1.8; }
.hero-caption { margin-top:36px; font-size:11px; color:var(--v0-muted); display:flex; align-items:center; gap:8px; }
.pixel-dot { flex-shrink:0; width:7px; height:7px; background:var(--brand-base); }
.hero-gallery { min-height:clamp(360px,32vw,520px); position:relative; overflow:visible; isolation:isolate; background:radial-gradient(ellipse,var(--brand-soft) 0%,transparent 66%); }
.hero-grid { position:absolute; inset:0; background-image:linear-gradient(#68717d0b 1px,transparent 1px),linear-gradient(90deg,#68717d0b 1px,transparent 1px); background-size:36px 36px; mask-image:radial-gradient(ellipse,black,transparent 70%); }
.hero-skin { position:absolute; width:34%; height:auto; aspect-ratio:0.72; bottom:12%; border:1px solid color-mix(in srgb,var(--v0-border) 72%,transparent); border-radius:12px; background:color-mix(in srgb,var(--v0-surface) 88%,transparent); backdrop-filter:blur(8px); box-shadow:0 14px 28px #26313f24; padding:16px; transform:rotate(-7deg); overflow:hidden; }
.hero-skin img { height:90%; width:100%; object-fit:contain; image-rendering:pixelated; }
.hero-skin span { display:block; font-size:12px; text-align:center; color:var(--v0-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hero-skin-0 { left:1%; transform:rotate(-8deg); bottom:14%; }
.hero-skin-1 { left:33%; z-index:2; width:36%; bottom:5%; transform:rotate(2deg); background:color-mix(in srgb,var(--v0-surface) 96%,transparent); box-shadow:0 18px 34px #26313f32; }
.hero-skin-2 { left:66%; transform:rotate(8deg); bottom:16%; }
:global(.dark) .hero-skin { background:#e7ebf0; border-color:#fff; backdrop-filter:none; box-shadow:0 14px 28px #10182055; }
:global(.dark) .hero-skin-1 { background:#f2f4f6; box-shadow:0 18px 34px #10182066; }
:global(.dark) .hero-skin span { color:#526070; }
.hero-gallery[data-count='1'] .hero-skin { left:50%; top:50%; width:min(72%,320px); height:320px; bottom:auto; transform:translate(-50%,-50%); }
.hero-gallery[data-count='2'] .hero-skin { width:44%; height:320px; bottom:50px; transform:none; }
.hero-gallery[data-count='2'] .hero-skin-0 { left:4%; }
.hero-gallery[data-count='2'] .hero-skin-1 { left:52%; }
.hero-note { position:absolute; bottom:0; right:5%; font-size:10px; text-transform:uppercase; letter-spacing:2px; color:var(--v0-muted); }
.home-features { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); padding:40px var(--public-inset) 48px; gap:clamp(28px,4vw,64px); border-top:1px solid var(--v0-border); }
.home-features h2 { font-size:17px; font-weight:650; margin:16px 0 9px; }
.home-features p { color:var(--v0-muted); font-size:13px; max-width:320px; }
.feature-icon { border:1px solid var(--v0-border); background:var(--v0-surface); display:inline-flex; padding:12px; border-radius:8px; color:var(--brand); }
.hero-placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding-bottom:24px; }
.hero-placeholder :deep(canvas) { width:100% !important; }
@media(min-width:768px) and (max-width:1100px) {
  .hero-copy h1 { font-size:clamp(36px,4.6vw,50px); letter-spacing:-1.5px; }
  .hero-skin { aspect-ratio:0.72; padding:10px; }
  .hero-skin-1 { aspect-ratio:0.72; }
}
@media(max-width:767px) {
  .home-hero { padding:40px var(--public-gutter) 32px; min-height:0; grid-template-columns:minmax(0,1fr); gap:24px; }
  .home-hero-background::after { background:linear-gradient(180deg, color-mix(in srgb, var(--canvas) 82%, transparent), color-mix(in srgb, var(--canvas) 70%, transparent)); }
  .hero-copy h1 { font-size:clamp(32px,8vw,48px); letter-spacing:-1.5px; }
  .hero-gallery { min-height:350px; }
  .hero-skin { aspect-ratio:0.72; padding:12px; }
  .hero-skin-1 { aspect-ratio:0.72; }
  .home-features { grid-template-columns:1fr; padding:32px var(--public-gutter); gap:28px; }
}
@media(prefers-reduced-motion:reduce) {
  .hero-headline-caret { animation:none; visibility:hidden; }
}
</style>
