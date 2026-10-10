<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue';
import { closetApi, meApi, textureUrl, type ClosetEntry } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import SkinPreview from '@/components/SkinPreview.vue';
import ApplyTextureDialog from '@/components/ApplyTextureDialog.vue';
import TexturePreviewer from '@/components/TexturePreviewer.vue';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';
const i18n = useI18n();
const items = ref<ClosetEntry[]>([]);
const keyword = ref('');
const kind = ref<'' | 'skin' | 'cape'>('');
const error = ref('');
const notice = ref('');
const loading = ref(true);
const busy = ref<number | null>(null);
const page = ref(1);
const hasMore = ref(false);
const loadingMore = ref(false);
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let searchTimer = 0;
const applyTextures = ref<{ skin?: number; cape?: number } | null>(null);
const selectedSkin = ref<ClosetEntry | null>(null);
const selectedCape = ref<ClosetEntry | null>(null);
const hasSelection = computed(() => !!selectedSkin.value || !!selectedCape.value);
const applyOpen = ref(false);
const visible = computed(() => items.value);
function select(entry: ClosetEntry) {
  notice.value = '';
  const selection = entry.kind === 'skin' ? selectedSkin : selectedCape;
  selection.value = selection.value?.textureId === entry.textureId ? null : entry;
}
function isSelected(entry: ClosetEntry) { return (entry.kind === 'skin' ? selectedSkin.value : selectedCape.value)?.textureId === entry.textureId; }
function applySelection(entry?: ClosetEntry) {
  const assignment: { skin?: number; cape?: number } = {};
  if (entry) assignment[entry.kind] = entry.textureId;
  else {
    if (selectedSkin.value) assignment.skin = selectedSkin.value.textureId;
    if (selectedCape.value) assignment.cape = selectedCape.value.textureId;
  }
  applyTextures.value = assignment;
  applyOpen.value = true;
}
async function load(reset = true) {
  if (loadingMore.value) return;
  if (reset) { loading.value = true; page.value = 1; items.value = []; }
  else loadingMore.value = true;
  error.value = '';
  try {
    const result = await closetApi.list({
        keyword: keyword.value || undefined,
        category: kind.value || undefined,
        page: page.value,
        perPage: 24,
      });
    items.value = reset ? result.items : [...items.value, ...result.items];
    hasMore.value = result.hasMore;
    await nextTick();
    if (sentinel.value) observer?.observe(sentinel.value);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false; loadingMore.value = false;
  }
}
async function act(e: ClosetEntry, action: 'remove' | 'avatar') {
  if (action === 'remove' && !(await confirmAction(i18n.t('user.removeItem')))) return;
  busy.value = e.textureId;
  error.value = '';
  notice.value = '';
  try {
    if (action === 'remove') await closetApi.remove(e.textureId);
    else await meApi.setAvatar(e.textureId);
    if (action === 'remove') {
      if (selectedSkin.value?.textureId === e.textureId) selectedSkin.value = null;
      if (selectedCape.value?.textureId === e.textureId) selectedCape.value = null;
    }
    notice.value = i18n.t('general.op-success');
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = null;
  }
}
watch([keyword, kind], () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void load(), 280); });
onMounted(() => {
  observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && hasMore.value && !loading.value && !loadingMore.value) { page.value++; void load(false); } }, { rootMargin: '400px' });
  void load();
});
onBeforeUnmount(() => { observer?.disconnect(); window.clearTimeout(searchTimer); });
</script>
<template>
  <div class="page page--dense">
    <PageHeader dense :title="i18n.t('general.my-closet')">
      <template #meta>
        <span class="resource-count">
          {{ i18n.t('common.count', { count: i18n.n(items.length) }, items.length) }}
        </span>
      </template>
      <router-link to="/skinlib" class="btn">
        <AppIcon name="add" />
        {{ i18n.t('home.cta_browse') }}
      </router-link>
    </PageHeader>
    <div class="resource-toolbar">
      <SearchExpressionField
        v-model="keyword"
        schema-key="closet"
        :aria-label="i18n.t('general.search')"
        :placeholder="i18n.t('user.typeToSearch')"
        @submit="load()"
      />
      <AppSelect v-model="kind" class="!w-auto" :options="[{ value: '', label: i18n.t('common.all') }, { value: 'skin', label: i18n.t('general.skin') }, { value: 'cape', label: i18n.t('general.cape') }]" :aria-label="i18n.t('skinlib.texture_type')" @change="load" />
    </div>
    <p v-if="error" class="alert alert-danger" role="alert">
      {{ error }}
      <AppButton class="ml-2 btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </p>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <AppSkeleton v-if="loading" />
    <div v-else-if="items.length || hasSelection" class="grid items-start gap-4" :class="hasSelection ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''">
      <div v-if="items.length" class="texture-grid">
        <article v-for="e in visible" :key="e.textureId" class="texture-card" :class="isSelected(e) ? '!border-brand-500 ring-1 ring-brand-500' : ''">
          <AppButton class="preview !w-full !rounded-none !border-0 !p-0" :aria-pressed="isSelected(e)" :aria-label="i18n.t('skinlib.preview_named', { name: e.itemName || e.textureName })" @click="select(e)">
            <SkinPreview
              :skin-url="textureUrl(e.hash)"
              :slim="e.model === 'slim'"
              :cape="e.kind === 'cape'"
              :alt="e.textureName"
            />
          </AppButton>
          <div class="meta">
            <router-link :to="`/skinlib/${e.textureId}`"><h2>{{ e.itemName || e.textureName }}</h2></router-link>
            <p v-if="e.itemName && e.itemName !== e.textureName" class="text-xs text-muted mt-1 truncate">{{ e.textureName }}</p>
            <div class="mt-3">
              <AppButton class="btn-sm btn-primary w-full" @click="applySelection(e)">
                {{ i18n.t('skinlib.apply') }}
              </AppButton>
              <div class="mt-1 flex justify-end gap-1">
                <AppButton
                  v-if="e.kind === 'skin'"
                  class="btn-icon btn-sm"
                  :aria-label="i18n.t('user.setAsAvatar')"
                  :disabled="busy === e.textureId"
                  @click="act(e, 'avatar')"
                >
                  <AppIcon name="account_circle" class="!text-base" />
                </AppButton>
                <AppButton
                  class="btn-icon btn-sm text-danger"
                  :aria-label="i18n.t('user.removeItem')"
                  :disabled="busy === e.textureId"
                  @click="act(e, 'remove')"
                >
                  <AppIcon name="delete_outline" class="!text-base" />
                </AppButton>
              </div>
            </div>
          </div>
        </article>
      </div>
      <EmptyState v-else :title="i18n.t('general.noResult')" icon="checkroom" />
      <section v-if="hasSelection" class="panel !p-0 min-w-0 overflow-hidden lg:sticky lg:top-4">
        <TexturePreviewer :skin-url="selectedSkin ? textureUrl(selectedSkin.hash) : null" :cape-url="selectedCape ? textureUrl(selectedCape.hash) : null" :slim="selectedSkin?.model === 'slim'" :height="300" />
        <div class="space-y-2 border-t border-line p-3">
          <div v-for="(entry, type) in { skin: selectedSkin, cape: selectedCape }" :key="type" class="flex items-center justify-between gap-2 text-sm">
            <span class="text-muted">{{ i18n.t('general.' + type) }}</span>
            <span class="min-w-0 truncate" :title="entry?.itemName || entry?.textureName">{{ entry?.itemName || entry?.textureName || i18n.t('player.texture_empty') }}</span>
          </div>
          <div class="flex flex-wrap gap-2 pt-1">
            <AppButton class="btn-sm btn-primary flex-1" @click="applySelection()">{{ i18n.t('skinlib.apply') }}</AppButton>
            <AppButton class="btn-sm" @click="selectedSkin = null; selectedCape = null; notice = ''">{{ i18n.t('user.resetSelected') }}</AppButton>
          </div>
        </div>
      </section>
    </div>
    <EmptyState v-else-if="!error" :title="i18n.t('user.emptyClosetMsg')" icon="checkroom">
      <router-link to="/skinlib" class="btn btn-primary">{{ i18n.t('home.cta_browse') }}</router-link>
    </EmptyState>
    <div ref="sentinel" class="h-8" aria-hidden="true" />
    <ApplyTextureDialog
      v-if="applyTextures"
      v-model="applyOpen"
      :textures="applyTextures"
      @applied="notice = i18n.t('player.applied')"
    />
  </div>
</template>
