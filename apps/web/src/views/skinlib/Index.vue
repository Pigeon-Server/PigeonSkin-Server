<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { closetApi, textureApi, type TextureSummary } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import TextureCard from '@/components/TextureCard.vue';
import { skinlibCache } from '@/lib/skinlib-cache';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();

const FILTERS = ['all', 'skin', 'steve', 'alex', 'cape', 'official'] as const;
type Filter = (typeof FILTERS)[number];

const filter = ref<Filter>('all');
const searchInput = ref('');
const appliedKeyword = ref('');
const uploader = ref(0);
const uploaderNickname = ref('');
const mine = ref(false);
const sort = ref<'created' | 'likes'>('created');
const page = ref(1);
const perPage = 24;

const items = ref<TextureSummary[]>([]);
const total = ref(0);
const totalPages = ref(1);
const loading = ref(false);
const error = ref('');
const actionError = ref('');
const closet = ref<Set<number>>(new Set());
const busyId = ref<number | null>(null);

let activeRequestId = 0;
let activeCacheKey = '';

const filterLabel = (f: Filter): string => {
  switch (f) {
    case 'all':
      return i18n.t('common.all');
    case 'official':
      return i18n.t('skinlib.filter.official');
    case 'steve':
    case 'alex':
    case 'skin':
    case 'cape':
      return i18n.t(`skinlib.filter.${f}`);
  }
};

const hasFilters = computed(() => {
  return (
    filter.value !== 'all' ||
    Boolean(appliedKeyword.value) ||
    Boolean(uploader.value) ||
    mine.value ||
    sort.value !== 'created'
  );
});

function parseQuery() {
  const queryFilter = route.query.filter as string;
  filter.value = FILTERS.includes(queryFilter as Filter) ? (queryFilter as Filter) : 'all';

  const queryKeyword = typeof route.query.keyword === 'string' ? route.query.keyword.trim() : '';
  searchInput.value = queryKeyword;
  appliedKeyword.value = queryKeyword;

  const queryUploader = Number(route.query.uploader);
  const parsedUploader = Number.isInteger(queryUploader) && queryUploader > 0 ? queryUploader : 0;
  if (parsedUploader !== uploader.value) {
    uploaderNickname.value = '';
  }
  uploader.value = parsedUploader;

  mine.value = route.query.mine === 'true';
  sort.value = route.query.sort === 'likes' ? 'likes' : 'created';

  const queryPage = Number(route.query.page);
  page.value = Number.isInteger(queryPage) && queryPage > 0 ? queryPage : 1;
}

function updateQuery(resetPage = false) {
  const newPage = resetPage ? 1 : page.value;
  const newQuery: Record<string, string> = {};

  if (filter.value !== 'all') newQuery.filter = filter.value;
  if (appliedKeyword.value) newQuery.keyword = appliedKeyword.value;
  if (uploader.value > 0) newQuery.uploader = String(uploader.value);
  if (mine.value) newQuery.mine = 'true';
  if (sort.value !== 'created') newQuery.sort = sort.value;
  if (newPage > 1) newQuery.page = String(newPage);

  void router.push({ query: newQuery });
}

function buildCacheKey(): string {
  const parameters = {
    filter: filter.value,
    keyword: appliedKeyword.value,
    uploader: uploader.value,
    mine: mine.value,
    sort: sort.value,
    page: page.value,
    uid: session.user.value?.id ?? 0,
    role: session.user.value?.role ?? 'guest',
  };
  return JSON.stringify(parameters);
}

async function loadData() {
  if (!session.loaded.value) {
    await session.fetchSession();
  }

  const requestId = ++activeRequestId;
  const cacheKey = buildCacheKey();
  activeCacheKey = cacheKey;

  // 检查内存缓存（2 分钟内有效）
  const cached = skinlibCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 120_000) {
    items.value = cached.items;
    total.value = cached.total;
    totalPages.value = cached.totalPages;
    page.value = cached.page;
    loading.value = false;
    error.value = '';
    await nextTick();
    if (cached.scrollY > 0) {
      window.scrollTo({ top: cached.scrollY, behavior: 'instant' });
    }
    return;
  }

  loading.value = true;
  error.value = '';

  const queryParams = {
    kind:
      filter.value === 'all' || filter.value === 'official'
        ? undefined
        : filter.value === 'cape'
          ? ('cape' as const)
          : ('skin' as const),
    model:
      filter.value === 'alex'
        ? ('slim' as const)
        : filter.value === 'steve'
          ? ('default' as const)
          : undefined,
    official: filter.value === 'official' ? true : undefined,
    uploader: uploader.value > 0 ? uploader.value : undefined,
    keyword: appliedKeyword.value || undefined,
    mine: mine.value || undefined,
    sort: sort.value,
    page: page.value,
    perPage,
  };

  try {
    const result = await textureApi.list(queryParams);
    if (requestId !== activeRequestId) return;

    items.value = result.items;
    total.value = result.total;
    totalPages.value = Math.max(1, result.totalPages);
    page.value = result.page;

    // 如果指定了上传者且暂未拿到其昵称，尝试从列表中匹配
    if (uploader.value > 0 && !uploaderNickname.value) {
      const match = result.items.find((item) => item.uploaderId === uploader.value);
      if (match?.uploaderName) {
        uploaderNickname.value = match.uploaderName;
      }
    }

    // 保存缓存
    skinlibCache.set(cacheKey, {
      items: result.items,
      total: result.total,
      totalPages: result.totalPages,
      page: result.page,
      savedAt: Date.now(),
      scrollY: window.scrollY,
    });
    while (skinlibCache.size > 16) {
      skinlibCache.delete(skinlibCache.keys().next().value!);
    }
  } catch (err) {
    if (requestId !== activeRequestId) return;
    error.value = apiErrorMessage(err);
  } finally {
    if (requestId === activeRequestId) {
      loading.value = false;
    }
  }
}

async function loadCloset() {
  if (!session.user.value) {
    closet.value = new Set();
    return;
  }
  try {
    const res = await closetApi.list({ perPage: 1000 });
    closet.value = new Set(res.items.map((x) => x.textureId));
  } catch {
    // 忽略非关键衣柜拉取错误
  }
}

async function toggleCollect(item: TextureSummary) {
  if (!session.user.value) {
    void router.push({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  if (busyId.value !== null) return;

  busyId.value = item.id;
  actionError.value = '';
  const isCollected = closet.value.has(item.id);

  // 乐观更新
  if (isCollected) {
    closet.value.delete(item.id);
    item.likes = Math.max(0, item.likes - 1);
  } else {
    closet.value.add(item.id);
    item.likes += 1;
  }

  try {
    if (isCollected) {
      await closetApi.remove(item.id);
    } else {
      await closetApi.add(item.id);
    }
    await session.fetchSession();
  } catch (e) {
    // 回滚状态
    if (isCollected) {
      closet.value.add(item.id);
      item.likes += 1;
    } else {
      closet.value.delete(item.id);
      item.likes = Math.max(0, item.likes - 1);
    }
    actionError.value = apiErrorMessage(e);
  } finally {
    busyId.value = null;
  }
}

function handleSearchSubmit() {
  appliedKeyword.value = searchInput.value.trim();
  updateQuery(true);
}

function handleSearchClear() {
  searchInput.value = '';
  if (appliedKeyword.value) {
    appliedKeyword.value = '';
    updateQuery(true);
  }
}

function handleFilterChange(newFilter: Filter) {
  if (filter.value === newFilter) return;
  filter.value = newFilter;
  updateQuery(true);
}

function handleSortChange(newSort: 'created' | 'likes') {
  if (sort.value === newSort) return;
  sort.value = newSort;
  updateQuery(true);
}

function handleToggleMine() {
  mine.value = !mine.value;
  if (mine.value) {
    uploader.value = 0;
    uploaderNickname.value = '';
  }
  updateQuery(true);
}

function handleUploaderClick(uid: number, nickname?: string) {
  if (!uid) return;
  uploader.value = uid;
  uploaderNickname.value = nickname ?? '';
  mine.value = false;
  updateQuery(true);
}

function handleClearUploader() {
  uploader.value = 0;
  uploaderNickname.value = '';
  updateQuery(true);
}

function resetFilters() {
  filter.value = 'all';
  searchInput.value = '';
  appliedKeyword.value = '';
  uploader.value = 0;
  uploaderNickname.value = '';
  mine.value = false;
  sort.value = 'created';
  updateQuery(true);
}

function handlePageChange(newPage: number) {
  if (newPage === page.value) return;
  page.value = newPage;
  updateQuery(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function saveScrollPosition() {
  if (!activeCacheKey) return;
  const existing = skinlibCache.get(activeCacheKey);
  if (existing) {
    existing.scrollY = window.scrollY;
  }
}

watch(
  () => route.query,
  () => {
    parseQuery();
    void loadData();
  },
);

watch(
  () => [session.user.value?.id, session.user.value?.role],
  () => {
    skinlibCache.clear();
    parseQuery();
    void loadData();
    void loadCloset();
  },
);

parseQuery();

onMounted(() => {
  void loadData();
  void loadCloset();
});

onBeforeUnmount(() => {
  saveScrollPosition();
});
</script>

<template>
  <div class="resource-page">
    <!-- 头部与操作区 -->
    <header class="resource-heading">
      <div class="flex items-baseline gap-3">
        <h1>{{ i18n.t('general.skinlib') }}</h1>
        <span v-if="total > 0" class="resource-count">
          {{ i18n.t('common.count', { count: i18n.n(total) }, total) }}
        </span>
      </div>
      <div v-if="session.user.value" class="flex flex-wrap items-center gap-2">
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

    <!-- 综合控制工具栏 -->
    <div class="resource-toolbar flex-col items-stretch gap-3 !py-3">
      <!-- 第一行：搜索 + 排序 + 快捷按钮 -->
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <!-- 搜索表单 -->
        <form
          class="flex min-w-[240px] flex-1 items-center gap-1.5 sm:max-w-md"
          @submit.prevent="handleSearchSubmit"
        >
          <div class="relative flex-1">
            <AppInput
              v-model="searchInput"
              class="w-full !pr-7"
              :aria-label="i18n.t('general.search')"
              :placeholder="i18n.t('general.search')"
            />
            <button
              v-if="searchInput"
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
              :title="i18n.t('general.close')"
              @click="handleSearchClear"
            >
              <AppIcon name="close" class="!text-sm" />
            </button>
          </div>
          <AppButton
            type="submit"
            class="btn-primary shrink-0"
            :aria-label="i18n.t('general.search')"
          >
            <AppIcon name="search" />
          </AppButton>
        </form>

        <!-- 排序方式与快捷动作组 -->
        <div class="flex flex-wrap items-center gap-2">
          <!-- 排序切换 -->
          <div class="filter-tabs" role="group" :aria-label="i18n.t('skinlib.sort.title')">
            <AppButton
              :class="{ selected: sort === 'created' }"
              :aria-pressed="sort === 'created'"
              @click="handleSortChange('created')"
            >
              {{ i18n.t('skinlib.sort.time') }}
            </AppButton>
            <AppButton
              :class="{ selected: sort === 'likes' }"
              :aria-pressed="sort === 'likes'"
              @click="handleSortChange('likes')"
            >
              {{ i18n.t('skinlib.sort.likes') }}
            </AppButton>
          </div>

          <!-- 只看我上传的 -->
          <AppButton
            v-if="session.user.value"
            :class="{ 'btn-primary': mine }"
            :aria-pressed="mine"
            @click="handleToggleMine"
          >
            <AppIcon name="person" class="!text-base" />
            <span>{{ i18n.t('skinlib.seeMyUpload') }}</span>
          </AppButton>

          <!-- 清除全部筛选 -->
          <AppButton
            v-if="hasFilters"
            class="btn-icon !h-8 !w-8"
            :title="i18n.t('skinlib.reset')"
            :aria-label="i18n.t('skinlib.reset')"
            @click="resetFilters"
          >
            <AppIcon name="filter_alt_off" />
          </AppButton>
        </div>
      </div>

      <!-- 第二行：材质分类胶囊选项卡 -->
      <div class="flex items-center overflow-x-auto pb-0.5 pt-0.5">
        <div
          class="filter-tabs flex-nowrap shrink-0"
          role="group"
          :aria-label="i18n.t('skinlib.texture_type')"
        >
          <AppButton
            v-for="f in FILTERS"
            :key="f"
            :class="{ selected: filter === f }"
            :aria-pressed="filter === f"
            @click="handleFilterChange(f)"
          >
            {{ filterLabel(f) }}
          </AppButton>
        </div>
      </div>

      <!-- 指定上传者提示横幅 -->
      <div
        v-if="uploader > 0"
        class="flex items-center justify-between rounded-md border border-line bg-surface-2 px-3 py-1.5 text-xs text-muted"
      >
        <div class="flex items-center gap-1.5">
          <AppIcon name="account_circle" class="!text-base text-brand-600" />
          <span>
            {{
              uploaderNickname
                ? `${uploaderNickname} (UID: ${uploader})`
                : i18n.t('skinlib.filter.uploader', { uid: uploader })
            }}
          </span>
        </div>
        <AppButton class="btn-sm !h-6 !px-2 !text-xs" @click="handleClearUploader">
          <span>{{ i18n.t('skinlib.filter.allUsers') }}</span>
          <AppIcon name="close" class="!text-xs" />
        </AppButton>
      </div>
    </div>

    <!-- 材质画廊展示区 -->
    <section
      class="resource-gallery"
      :class="{ 'resource-gallery-refreshing': loading && items.length > 0 }"
      :aria-label="i18n.t('general.skinlib')"
      :aria-busy="loading"
    >
      <!-- 操作轻量报错提示 -->
      <p v-if="actionError" class="mb-3 text-sm text-danger" role="alert">
        {{ actionError }}
      </p>

      <!-- 首次或换页加载骨架屏 -->
      <div v-if="loading && !items.length" class="texture-grid" aria-hidden="true">
        <div
          v-for="n in 12"
          :key="n"
          class="texture-card animate-pulse"
        >
          <div class="h-[210px] w-full bg-surface-2" />
          <div class="meta space-y-2 !p-3">
            <div class="h-4 w-3/4 rounded bg-surface-2" />
            <div class="h-3 w-1/2 rounded bg-surface-2" />
            <div class="mt-2 flex items-center justify-between pt-1">
              <div class="h-3 w-1/3 rounded bg-surface-2" />
              <div class="h-5 w-12 rounded bg-surface-2" />
            </div>
          </div>
        </div>
      </div>

      <!-- 错误状态与重试 -->
      <div v-else-if="error && !items.length" class="resource-error" role="alert">
        <AppIcon name="cloud_off" />
        <span>{{ error }}</span>
        <AppButton class="btn-sm" @click="loadData">{{ i18n.t('common.retry') }}</AppButton>
      </div>

      <!-- 材质列表网格 -->
      <div v-else-if="items.length > 0" class="texture-grid">
        <TextureCard
          v-for="item in items"
          :key="item.id"
          :texture="item"
          :collected="closet.has(item.id)"
          :busy="busyId === item.id"
          @collect="toggleCollect(item)"
          @uploader="handleUploaderClick"
        />
      </div>

      <!-- 空状态 -->
      <EmptyState v-else :title="i18n.t('general.noResult')" icon="search_off">
        <AppButton v-if="hasFilters" @click="resetFilters">
          {{ i18n.t('skinlib.reset') }}
        </AppButton>
      </EmptyState>

      <!-- 经典响应式分页器 -->
      <div v-if="totalPages > 1" class="mt-8 flex justify-center pb-6">
        <AppPagination
          v-model="page"
          :total-pages="totalPages"
          :show-pages="true"
          :busy="loading"
          @update:model-value="handlePageChange"
        />
      </div>
    </section>
  </div>
</template>
