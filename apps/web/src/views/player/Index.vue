<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  playerApi,
  closetApi,
  textureApi,
  textureUrl,
  type PlayerSummary,
  type ClosetEntry,
} from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import { useSessionStore } from '@/stores/session';
import { confirmAction, promptValue } from '@/stores/dialog';
import TexturePreviewer from '@/components/TexturePreviewer.vue';
import SkinPreview from '@/components/SkinPreview.vue';
import { apiErrorMessage } from '@/lib/api-error';

const i18n = useI18n();
const site = useSiteSettings();
const session = useSessionStore();
const players = ref<PlayerSummary[]>([]);
const textures = ref<ClosetEntry[]>([]);
const currentId = ref<number | null>(null);
const newName = ref('');
const createOpen = ref(false);
const assignFor = ref<'skin' | 'cape'>('skin');
const loading = ref(true);
const busy = ref(false);
const loadError = ref('');
const actionError = ref('');
const notice = ref('');
const search = ref('');
const current = computed(() => players.value.find((p) => p.id === currentId.value) ?? null);
const pendingSkin = ref<number | null | undefined>(undefined);
const pendingCape = ref<number | null | undefined>(undefined);
const hasPending = computed(() => pendingSkin.value !== undefined || pendingCape.value !== undefined);
const previewSkinHash = computed(() => pendingSkin.value === undefined ? current.value?.skinHash ?? null : textures.value.find(t => t.textureId === pendingSkin.value)?.hash ?? null);
const previewCapeHash = computed(() => pendingCape.value === undefined ? current.value?.capeHash ?? null : textures.value.find(t => t.textureId === pendingCape.value)?.hash ?? null);
const choices = computed(() =>
  textures.value.filter(
    (t) =>
      t.kind === assignFor.value &&
      (t.itemName || t.textureName).toLowerCase().includes(search.value.toLowerCase()),
  ),
);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [p, closet, catalog] = await Promise.all([playerApi.list(), closetApi.list(), textureApi.list({ perPage: 100 })]);
    players.value = p.items;
    const owned = new Map(closet.items.map(item => [item.textureId, item]));
    textures.value = catalog.items
      .filter(item => item.official || owned.has(item.id))
      .map(item => owned.get(item.id) || ({ textureId: item.id, itemName: null, createdAt: item.createdAt, hash: item.hash, kind: item.kind, model: item.model, textureName: item.name, visibility: item.visibility }));
    if (!players.value.some((p) => p.id === currentId.value))
      currentId.value = players.value[0]?.id ?? null;
    pendingSkin.value = pendingCape.value = undefined;
  } catch (e) {
    loadError.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  actionError.value = '';
  notice.value = '';
  try {
    await action();
    notice.value = i18n.t('general.op-success');
    await load();
    await session.fetchSession();
  } catch (e) {
    actionError.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function create() {
  await run(async () => {
    const p = await playerApi.create(newName.value.trim());
    currentId.value = p.id;
    createOpen.value = false;
    newName.value = '';
  });
}
async function rename(p: PlayerSummary) {
  const name = await promptValue(i18n.t('user.player.edit-pname'), p.name);
  if (name && name !== p.name) await run(() => playerApi.rename(p.id, name));
}
async function remove(p: PlayerSummary) {
  if (await confirmAction(i18n.t('player.delete_confirm', { name: p.name })))
    await run(() => playerApi.remove(p.id));
}
async function assign(id: number | null) {
  if (!current.value) return;
  if (assignFor.value === 'skin') pendingSkin.value = id;
  else pendingCape.value = id;
}
async function saveTextures() {
  if (!current.value || !hasPending.value) return;
  const body: { skin?: number | null; cape?: number | null } = {};
  if (pendingSkin.value !== undefined) body.skin = pendingSkin.value;
  if (pendingCape.value !== undefined) body.cape = pendingCape.value;
  await run(() => playerApi.setTextures(current.value!.id, body));
}
onMounted(() => {
  void site.fetch();
  void load();
});
</script>

<template>
  <PageHeader :title="i18n.t('general.player-manage')">
    <AppButton class="btn-primary" @click="createOpen = true">
      <AppIcon name="add" />
      {{ i18n.t('player.create') }}
    </AppButton>
  </PageHeader>
  <p v-if="loadError" class="alert alert-danger" role="alert">
    {{ loadError }}
    <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
  </p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <AppSkeleton v-if="loading" :count="3" />
  <EmptyState
    v-else-if="!players.length && !loadError"
    :title="i18n.t('player.empty')"
    icon="sports_esports"
  >
    <AppButton class="btn-primary" @click="createOpen = true">
      {{ i18n.t('player.create') }}
    </AppButton>
  </EmptyState>
  <div v-else-if="current" class="grid gap-6 xl:grid-cols-[240px_1fr]">
    <div class="panel !p-3 self-start">
      <label class="mb-2 block text-xs text-muted" for="player-selector">{{ i18n.t('player.select') }}</label>
      <AppSelect id="player-selector" v-model="currentId" class="mb-3" :options="players.map(p => ({ value: p.id, label: p.name }))" />
    </div>
    <div class="grid gap-6 lg:grid-cols-[minmax(240px,1fr)_minmax(260px,1fr)]">
      <section class="panel !p-0 overflow-hidden">
        <div class="p-4 flex items-center justify-between gap-2">
          <h2 class="text-lg font-semibold">{{ current.name }}</h2>
          <div class="flex gap-1">
            <AppButton
              class="btn-icon"
              :disabled="busy"
              :aria-label="i18n.t('common.rename')"
              @click="rename(current)"
            >
              <AppIcon name="edit" />
            </AppButton>
            <AppButton
              class="btn-icon text-danger"
              :disabled="busy"
              :aria-label="i18n.t('common.delete')"
              @click="remove(current)"
            >
              <AppIcon name="delete_outline" />
            </AppButton>
          </div>
        </div>
        <div class="bg-surface-2">
          <TexturePreviewer
            :skin-url="previewSkinHash ? textureUrl(previewSkinHash) : null"
            :cape-url="previewCapeHash ? textureUrl(previewCapeHash) : null"
            :slim="current.skinModel === 'slim'"
            :name="current.name"
          />
        </div>
      </section>
      <section class="panel">
        <div class="flex items-center justify-between gap-2 mb-5">
          <div class="filter-tabs">
            <AppButton
              v-for="kind in ['skin', 'cape'] as const"
              :key="kind"
              :class="{ selected: assignFor === kind }"
              @click="assignFor = kind"
            >
              {{ i18n.t(`general.${kind}`) }}
            </AppButton>
          </div>
          <div class="flex items-center gap-2">
            <AppButton v-if="hasPending" class="btn-sm btn-primary" :loading="busy" @click="saveTextures">
              {{ i18n.t('common.save') }}
            </AppButton>
            <AppButton class="btn-sm" :loading="busy" @click="assign(null)">
              {{ i18n.t(assignFor === 'skin' ? 'player.clear_skin' : 'player.clear_cape') }}
            </AppButton>
          </div>
        </div>
        <AppInput
          v-model="search"
          class="mb-4"
          :aria-label="i18n.t('general.search')"
          :placeholder="i18n.t('general.search')"
        />
        <div class="grid grid-cols-3 gap-2 max-h-[380px] overflow-y-auto">
          <AppButton
            v-for="t in choices"
            :key="t.textureId"
            class="!flex-col !p-2 min-w-0"
            :disabled="busy"
            :class="(assignFor === 'skin' ? (pendingSkin === undefined ? current.skinTextureId : pendingSkin) : (pendingCape === undefined ? current.capeTextureId : pendingCape)) === t.textureId ? '!border-brand-400 !bg-brand-50 dark:!bg-brand-900' : ''"
            @click="assign(t.textureId)"
          >
            <SkinPreview
              :skin-url="textureUrl(t.hash)"
              :slim="t.model === 'slim'"
              :cape="t.kind === 'cape'"
              :alt="t.textureName"
              class="h-20 w-full object-contain"
            />
            <span class="truncate w-full text-[10px]">{{ t.itemName || t.textureName }}</span>
          </AppButton>
        </div>
        <EmptyState v-if="!choices.length" :title="i18n.t('user.no_textures_ext')" icon="checkroom">
          <router-link to="/skinlib" class="btn">{{ i18n.t('home.cta_browse') }}</router-link>
        </EmptyState>
      </section>
    </div>
  </div>
  <AppDialog v-model="createOpen" :title="i18n.t('player.new')" :busy="busy" dialog-class="player-create-dialog">
    <AppForm class="space-y-4" @submit.prevent="create">
      <label class="block" for="new-player-name">{{ i18n.t('general.player-name') }}</label>
      <AppInput
        id="new-player-name"
        v-model="newName"
        required
        :minlength="Number(site.get('player_name_length_min')) || 3"
        :maxlength="Number(site.get('player_name_length_max')) || 16"
      />
      <p class="text-xs text-muted">
        {{ i18n.t('player.cost', { score: i18n.n(Number(site.get('score_per_player')) || 0) }) }}
      </p>
      <p v-if="actionError" class="alert alert-danger">{{ actionError }}</p>
      <div class="flex justify-end">
        <AppButton type="submit" class="btn-primary" :loading="busy">
          {{ i18n.t('player.create') }}
        </AppButton>
      </div>
    </AppForm>
  </AppDialog>
</template>
