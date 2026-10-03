<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { closetApi, textureApi, type TextureSummary } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import TextureCard from '@/components/TextureCard.vue';
import { createResourceFeed } from '@/lib/resource-feed';
import { skinlibCache } from '@/lib/skinlib-cache';
import { apiErrorMessage } from '@/lib/api-error';
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();
const filters = ['all', 'official', 'skin', 'steve', 'alex', 'cape'] as const;
type Filter = (typeof filters)[number];
const filter = ref<Filter>('all');
const name = ref('');
const keyword = ref('');
const uploader = ref(0);
const mine = ref(false);
const sort = ref<'created' | 'likes'>('created');
const feed = createResourceFeed<TextureSummary>();
const { page, totalPages, total, items, loading, loadingMore } = feed;
const closet = ref<number[]>([]);
const actionError = ref('');
const error = computed(() => feed.error.value ? apiErrorMessage(feed.error.value) : '');
const sentinel = ref<HTMLElement | null>(null);
const busyId = ref<number | null>(null);
let activeKey = '';
let observer: IntersectionObserver | null = null;
let requestedPage = 1;
let keywordTimer = 0;
const label = (f: Filter) =>
  i18n.t(
    f === 'all'
      ? 'common.all'
      : f === 'official'
        ? 'skinlib.filter.official'
      : f === 'steve' || f === 'alex'
        ? `skinlib.filter.${f}`
        : `general.${f}`,
  );
const hasFilters = computed(
  () =>
    filter.value !== 'all' ||
    !!keyword.value ||
    !!uploader.value ||
    mine.value ||
    sort.value !== 'created',
);
function parseQuery() {
  filter.value = filters.includes(route.query.filter as Filter)
    ? (route.query.filter as Filter)
    : 'all';
  name.value = keyword.value = String(route.query.keyword || '');
  uploader.value = Number(route.query.uploader) || 0;
  mine.value = route.query.mine === 'true';
  sort.value = route.query.sort === 'likes' ? 'likes' : 'created';
  const requested = Number(route.query.page);
  requestedPage = Number.isInteger(requested) ? Math.max(1, requested) : 1;
}
function updateQuery(resetPage = true) {
  void router.push({
    query: {
      filter: filter.value,
      ...(keyword.value ? { keyword: keyword.value } : {}),
      ...(mine.value ? { mine: 'true' } : {}),
      ...(uploader.value ? { uploader: uploader.value } : {}),
      sort: sort.value,
      page: resetPage ? 1 : page.value,
    },
  });
}
async function load() {
  if (!session.loaded.value) await session.fetchSession();
  const parameters = {
      kind: filter.value === 'all' || filter.value === 'official' ? undefined : filter.value === 'cape' ? 'cape' : 'skin',
      model: filter.value === 'alex' ? 'slim' : filter.value === 'steve' ? 'default' : undefined,
      official: filter.value === 'official',
      uploader: uploader.value || undefined,
      keyword: keyword.value || undefined,
      mine: mine.value,
      sort: sort.value,
      perPage: 24,
  } as const;
  const key = JSON.stringify([session.user.value?.id ?? 0, session.user.value?.role, parameters]);
  if (key === activeKey && requestedPage === page.value && items.value.length) return;
  activeKey = key;
  const loader = (next: number) => textureApi.list({ ...parameters, page: next });
  const cached = skinlibCache.get(key);
  if (cached && cached.page === requestedPage && Date.now() - cached.savedAt < 120_000) {
    feed.restore(cached, loader);
    await nextTick(); window.scrollTo({ top: cached.scrollY });
  } else await feed.reset(loader, requestedPage, true);
  if (activeKey !== key) return;
  await nextTick();
  if (sentinel.value) observer?.observe(sentinel.value);
  saveCache();
}
function saveCache() {
  if (!activeKey || !items.value.length || feed.error.value) return;
  skinlibCache.set(activeKey, { ...feed.snapshot(), scrollY: window.scrollY });
  while (skinlibCache.size > 8) skinlibCache.delete(skinlibCache.keys().next().value!);
}
async function loadMore() {
  await feed.more();
  saveCache();
  if (!feed.error.value && page.value) await router.replace({ query: { ...route.query, page: page.value } });
}
async function loadCloset() {
  if (!session.user.value) { closet.value = []; return; }
  try {
    closet.value = (await closetApi.list()).items.map((x) => x.textureId);
  } catch (e) {
    actionError.value = apiErrorMessage(e);
  }
}
async function toggleCollect(item: TextureSummary) {
  if (!session.user.value) {
    void router.push({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  if (busyId.value !== null) return;
  busyId.value = item.id;
  try {
    if (closet.value.includes(item.id)) {
      await closetApi.remove(item.id);
      closet.value = closet.value.filter((id) => id !== item.id);
      items.value = items.value.map(texture => texture.id === item.id ? { ...texture, likes: Math.max(0, texture.likes - 1) } : texture);
    } else {
      await closetApi.add(item.id);
      closet.value.push(item.id);
      items.value = items.value.map(texture => texture.id === item.id ? { ...texture, likes: texture.likes + 1 } : texture);
    }
    await session.fetchSession();
  } catch (e) {
    actionError.value = apiErrorMessage(e);
  } finally {
    busyId.value = null;
  }
}
function reset() {
  filter.value = 'all';
  name.value = keyword.value = '';
  uploader.value = 0;
  mine.value = false;
  sort.value = 'created';
  updateQuery();
}
watch(keyword, () => {
  window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(() => {
    updateQuery();
  }, 280);
});
watch(
  () => route.query,
  (query, previous) => {
    if (items.value.length && Number(query.page) === page.value && Object.keys({ ...query, ...previous }).every(key => key === 'page' || query[key] === previous?.[key])) return;
    parseQuery();
    void load();
  },
);
watch(() => [session.user.value?.id, session.user.value?.role], () => {
  skinlibCache.clear(); feed.cancel(); items.value = []; activeKey = '';
  parseQuery(); void load(); void loadCloset();
});
onMounted(() => {
  if ('IntersectionObserver' in window) observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && !loading.value && !loadingMore.value && !feed.error.value && page.value < totalPages.value) void loadMore();
  }, { rootMargin: '480px' });
  parseQuery();
  void load();
  void loadCloset();
});
onBeforeUnmount(() => { saveCache(); feed.cancel(); observer?.disconnect(); window.clearTimeout(keywordTimer); });
</script>
<template>
  <div class="resource-page">
    <header class="resource-heading">
      <h1>
        {{ i18n.t('general.skinlib') }}
        <span class="resource-count">{{ i18n.t('common.count', { count: i18n.n(total) }, total) }}</span>
      </h1>
      <div v-if="session.user.value" class="flex flex-wrap gap-2">
        <router-link to="/skinlib/upload" class="btn">
          <AppIcon name="upload" />
          {{ i18n.t('skinlib.upload.title') }}
        </router-link>
        <router-link to="/skinlib/create" class="btn btn-primary">
          <AppIcon name="brush" />
          {{ i18n.t('skinlib.create.title') }}
        </router-link>
      </div>
    </header>
    <div class="resource-toolbar">
      <div class="flex w-56 gap-1">
        <AppInput
          v-model="keyword"
          :aria-label="i18n.t('general.search')"
          :placeholder="i18n.t('general.search')"
        />
      </div>
      <div
        class="filter-tabs hidden sm:inline-flex"
        role="group"
        :aria-label="i18n.t('skinlib.texture_type')"
      >
        <AppButton
          v-for="f in filters"
          :key="f"
          :class="{ selected: filter === f }"
          :aria-pressed="filter === f"
          @click="filter = f; updateQuery()"
        >
          {{ label(f) }}
        </AppButton>
      </div>
      <AppSelect v-model="filter" class="!w-auto sm:hidden" :options="filters.map(f => ({ value: f, label: label(f) }))" :aria-label="i18n.t('skinlib.texture_type')" @change="updateQuery()" />
      <AppSelect v-model="sort" class="!w-auto ml-auto" :options="[{ value: 'created', label: i18n.t('skinlib.sort.time') }, { value: 'likes', label: i18n.t('skinlib.sort.likes') }]" :aria-label="i18n.t('skinlib.sort.time')" @change="updateQuery()" />
      <AppButton
        v-if="session.user.value"
        :class="{ 'btn-primary': mine }"
        :aria-pressed="mine"
        @click="mine = !mine; uploader = 0; updateQuery()"
      >
        {{ i18n.t('skinlib.seeMyUpload') }}
      </AppButton>
      <AppButton
        v-if="hasFilters"
        class="btn-icon !h-8 !w-8"
        :aria-label="i18n.t('skinlib.reset')"
        @click="reset"
      >
        <AppIcon name="filter_alt_off" />
      </AppButton>
    </div>
    <div v-if="uploader" class="py-2">
      <AppButton class="btn-sm" @click="uploader = 0; updateQuery()">
        {{ i18n.t('skinlib.filter.uploader', { uid: uploader }) }}
        <AppIcon name="close" class="!text-sm" />
      </AppButton>
    </div>
    <section class="resource-gallery" :class="{ 'resource-gallery-refreshing': loading && items.length }" :aria-label="i18n.t('general.skinlib')" :aria-busy="loading">
      <p v-if="actionError" class="mb-3 text-sm text-danger" role="alert">{{ actionError }}</p>
      <AppSkeleton v-if="loading && !items.length" :count="14" />
      <div v-if="loading && items.length" class="resource-refresh-status" role="status">
        <AppIcon name="sync" class="animate-spin !text-sm" />
        <span>{{ i18n.t('common.loading') }}</span>
      </div>
      <div v-else-if="error && !items.length" class="resource-error" role="alert">
        <AppIcon name="cloud_off" />
        <span>{{ error }}</span>
        <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton>
      </div>
      <div v-else-if="items.length" class="texture-grid">
        <TextureCard
          v-for="item in items"
          :key="item.id"
          :texture="item"
          :collected="closet.includes(item.id)"
          :busy="busyId === item.id"
          @collect="toggleCollect(item)"
          @uploader="uploader = $event; mine = false; updateQuery()"
        />
      </div>
      <EmptyState v-else :title="i18n.t('general.noResult')" icon="search_off">
        <AppButton v-if="hasFilters" @click="reset">{{ i18n.t('skinlib.reset') }}</AppButton>
      </EmptyState>
      <div v-if="items.length" ref="sentinel" class="flex min-h-14 items-center justify-center gap-2 py-4" aria-live="polite">
        <template v-if="loadingMore"><AppIcon name="sync" class="animate-spin !text-base" /><span class="text-sm text-muted">{{ i18n.t('skinlib.loading_more') }}</span></template>
        <template v-else-if="error"><span class="text-sm text-danger" role="alert">{{ error }}</span><AppButton class="btn-sm" @click="loadMore">{{ i18n.t('common.retry') }}</AppButton></template>
        <AppButton v-else-if="page < totalPages" class="btn-sm" @click="loadMore">{{ i18n.t('skinlib.load_more') }}</AppButton>
        <span v-else class="text-xs text-muted">{{ i18n.t('skinlib.loaded_all') }}</span>
      </div>
    </section>
  </div>
</template>
