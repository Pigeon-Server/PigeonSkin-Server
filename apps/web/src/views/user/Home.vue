// 创作者主页：公开展示用户的签名与公开材质列表。
// 未登录可访问（guest-shell 自动隐藏侧栏）；材质可见性由 API 在 SQL 内强制。
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, closetApi, textureApi, type TextureSummary, type UserProfile } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import TextureCard from '@/components/TextureCard.vue';
import { apiErrorMessage } from '@/lib/api-error';
import { withSkinlibChallenge } from '@/stores/skinlib-challenge';

const route = useRoute();
const session = useSessionStore();
const i18n = useI18n();

const profile = ref<UserProfile | null>(null);
const items = ref<TextureSummary[]>([]);
const closet = ref<Set<number>>(new Set());
const loading = ref(true);
const profileError = ref('');
const actionError = ref('');
const busyId = ref<number | null>(null);

const page = ref(1);
const totalPages = ref(1);
const perPage = 24;

async function loadProfile() {
  const uid = Number(route.params.uid);
  profile.value = await api.userProfile(uid);
}

async function loadTextures() {
  const uid = Number(route.params.uid);
  const res = await withSkinlibChallenge((headers) => textureApi.list({ uploader: uid, sort: 'created', page: page.value, perPage, locale: i18n.locale.value }, headers));
  items.value = res.items;
  totalPages.value = res.totalPages;
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

async function load() {
  loading.value = true;
  profileError.value = '';
  try {
    await Promise.all([loadProfile(), loadTextures(), loadCloset()]);
  } catch (e) {
    profileError.value = apiErrorMessage(e);
    profile.value = null;
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function toggleCollect(item: TextureSummary) {
  if (!session.user.value) return;
  if (busyId.value !== null) return;

  busyId.value = item.id;
  actionError.value = '';
  const isCollected = closet.value.has(item.id);

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

watch(page, () => { void load(); });

watch(() => route.params.uid, () => {
  if (route.path.startsWith('/user/') && /^\d+$/.test(String(route.params.uid))) {
    page.value = 1;
    void load();
  }
});

onMounted(load);
</script>

<template>
  <!-- 创作者主页：头像与昵称构成身份头，因此不使用 PageHeader。 -->
  <div class="page">
    <nav class="page-breadcrumb" :aria-label="i18n.t('general.skinlib')">
      <router-link to="/skinlib" class="page-back">
        <AppIcon name="arrow_back" class="!text-sm" />
        <span>{{ i18n.t('general.skinlib') }}</span>
      </router-link>
    </nav>

    <!-- 用户信息头 -->
    <div v-if="profile" class="panel flex flex-wrap items-center gap-4">
      <img
        :src="`/avatar/user/${profile.id}?mode=2d&size=100`"
        :alt="profile.nickname"
        class="h-16 w-16 rounded-full bg-surface-2 object-cover"
        loading="lazy"
      />
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-xl font-semibold">{{ profile.nickname || i18n.t('admin.anonymous') }}</h1>
        <p v-if="profile.signature" class="mt-0.5 text-sm text-muted">{{ profile.signature }}</p>
        <p class="mt-1 text-xs text-muted">
          {{ i18n.t('user.profile_joined') }} {{ i18n.d(profile.createdAt) }}
          · {{ i18n.t('user.profile_skins', { count: profile.counts.skins }) }}
          · {{ i18n.t('user.profile_capes', { count: profile.counts.capes }) }}
        </p>
      </div>
    </div>

    <div v-if="loading" class="texture-grid" aria-hidden="true">
      <div v-for="n in 8" :key="n" class="texture-card animate-pulse">
        <div class="h-[210px] w-full bg-surface-2" />
        <div class="meta space-y-2 !p-3">
          <div class="h-4 w-3/4 rounded bg-surface-2" />
          <div class="h-3 w-1/2 rounded bg-surface-2" />
        </div>
      </div>
    </div>

    <div v-else-if="profileError" class="py-12 text-center text-sm text-red-600" role="alert">{{ profileError }}</div>

    <template v-else-if="profile">
      <div v-if="items.length > 0" class="texture-grid">
        <TextureCard
          v-for="item in items"
          :key="item.id"
          :texture="item"
          :collected="closet.has(item.id)"
          :busy="busyId === item.id"
          @collect="toggleCollect(item)"
        />
      </div>
      <div v-else class="py-12 text-center text-sm text-muted">{{ i18n.t('user.profile_empty') }}</div>

      <AppPagination v-if="totalPages > 1" v-model="page" :total-pages="totalPages" :busy="loading" />

      <p v-if="actionError" class="text-sm text-red-600">{{ actionError }}</p>
    </template>
  </div>
</template>
