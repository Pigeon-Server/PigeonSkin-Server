<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  playerApi,
  closetApi,
  textureApi,
  textureUrl,
  type PlayerSummary,
  type ClosetEntry,
  type TextureSummary,
} from '@/api';
import type { PlayerNameRule } from '@pigeon-skin/shared';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import TexturePreviewer from '@/components/TexturePreviewer.vue';
import SkinPreview from '@/components/SkinPreview.vue';
import AvatarPreview from '@/components/AvatarPreview.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
import AppForm from '@/components/ui/AppForm.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';
import { useSearchExpression } from '@/lib/search-expression';
import { matchSearch, searchSchema } from '@pigeon-skin/shared/search';
import { apiErrorMessage } from '@/lib/api-error';
import { withSkinlibChallenge } from '@/stores/skinlib-challenge';

interface SelectableTexture {
  id: number;
  name: string;
  hash: string;
  kind: 'skin' | 'cape';
  model: 'default' | 'slim' | null;
  isOfficial: boolean;
  isInCloset: boolean;
}

const i18n = useI18n();
const site = useSiteSettings();
const session = useSessionStore();

// 玩家与材质数据
const players = ref<PlayerSummary[]>([]);
const closetEntries = ref<ClosetEntry[]>([]);
const officialEntries = ref<TextureSummary[]>([]);
const currentId = ref<number | null>(null);

// 界面状态
const loading = ref(true);
const busy = ref(false);
const loadError = ref('');
const actionError = ref('');
const notice = ref('');
const copiedNotice = ref(false);

// 材质筛选
const assignFor = ref<'skin' | 'cape'>('skin');
const search = ref('');
const sourceFilter = ref<'all' | 'closet' | 'official'>('all');

// 试穿与装扮状态（先更新预览，再由用户明确保存）
const pendingSkin = ref<number | null | undefined>(undefined);
const pendingCape = ref<number | null | undefined>(undefined);

// 模态对话框
const createOpen = ref(false);
const newName = ref('');
const renameOpen = ref(false);
const renameValue = ref('');

// 计算属性
const current = computed(() => players.value.find((p) => p.id === currentId.value) ?? null);

const hasPending = computed(
  () => pendingSkin.value !== undefined || pendingCape.value !== undefined,
);

// 汇总全量可用材质池
const texturesPool = computed<SelectableTexture[]>(() => {
  const map = new Map<number, SelectableTexture>();

  for (const item of closetEntries.value) {
    map.set(item.textureId, {
      id: item.textureId,
      name: item.itemName || item.textureName,
      hash: item.hash,
      kind: item.kind,
      model: item.model,
      isOfficial: false,
      isInCloset: true,
    });
  }

  for (const item of officialEntries.value) {
    const existing = map.get(item.id);
    if (existing) {
      existing.isOfficial = true;
    } else {
      map.set(item.id, {
        id: item.id,
        name: item.name,
        hash: item.hash,
        kind: item.kind,
        model: item.model,
        isOfficial: true,
        isInCloset: false,
      });
    }
  }

  // 若当前角色身上已有材质但不在衣柜中，也补充进来以便识别
  if (current.value?.skinTextureId && !map.has(current.value.skinTextureId) && current.value.skinHash) {
    map.set(current.value.skinTextureId, {
      id: current.value.skinTextureId,
      name: current.value.name,
      hash: current.value.skinHash,
      kind: 'skin',
      model: current.value.skinModel,
      isOfficial: false,
      isInCloset: false,
    });
  }

  if (current.value?.capeTextureId && !map.has(current.value.capeTextureId) && current.value.capeHash) {
    map.set(current.value.capeTextureId, {
      id: current.value.capeTextureId,
      name: current.value.name,
      hash: current.value.capeHash,
      kind: 'cape',
      model: null,
      isOfficial: false,
      isInCloset: false,
    });
  }

  return Array.from(map.values());
});

const texturesMap = computed(() => new Map(texturesPool.value.map((t) => [t.id, t])));

// 实时 3D 预览哈希计算
const previewSkinHash = computed(() => {
  if (pendingSkin.value === null) return null;
  if (pendingSkin.value !== undefined) {
    return texturesMap.value.get(pendingSkin.value)?.hash ?? null;
  }
  return current.value?.skinHash ?? null;
});

const previewCapeHash = computed(() => {
  if (pendingCape.value === null) return null;
  if (pendingCape.value !== undefined) {
    return texturesMap.value.get(pendingCape.value)?.hash ?? null;
  }
  return current.value?.capeHash ?? null;
});

const previewSkinModel = computed(() => {
  if (pendingSkin.value === null) return 'default';
  if (pendingSkin.value !== undefined) {
    return texturesMap.value.get(pendingSkin.value)?.model ?? 'default';
  }
  return current.value?.skinModel ?? 'default';
});

// 当前角色已保存的材质名
const currentSkinName = computed(() => {
  if (!current.value?.skinTextureId) return null;
  return texturesMap.value.get(current.value.skinTextureId)?.name ?? null;
});

const currentCapeName = computed(() => {
  if (!current.value?.capeTextureId) return null;
  return texturesMap.value.get(current.value.capeTextureId)?.name ?? null;
});

// 筛选后的材质列表（搜索走与站内一致的表达式语法）
const searchState = useSearchExpression(search, 'playerTextures');
const materialSchema = searchSchema('playerTextures');
const choices = computed(() => {
  const ast = searchState.value;
  return texturesPool.value.filter((t) => {
    if (t.kind !== assignFor.value) return false;
    if (sourceFilter.value === 'closet' && !t.isInCloset) return false;
    if (sourceFilter.value === 'official' && !t.isOfficial) return false;
    if (!matchSearch(ast, materialSchema, {
      name: t.name, kind: t.kind, model: t.model ?? '', official: t.isOfficial, closet: t.isInCloset,
    })) return false;
    return true;
  });
});

// 站点规则与配置
const nameRule = computed(
  () => (site.get('player_name_rule') as PlayerNameRule) || 'official',
);
const nameMinLength = computed(() => Number(site.get('player_name_length_min')) || 3);
const nameMaxLength = computed(() => Number(site.get('player_name_length_max')) || 16);
const scoreCost = computed(() => Number(site.get('score_per_player')) || 0);

// 加载全部衣柜项目
async function fetchAllCloset(): Promise<ClosetEntry[]> {
  const items: ClosetEntry[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 10) {
    const res = await closetApi.list({ page, perPage: 100 });
    items.push(...res.items);
    hasMore = res.hasMore;
    page++;
  }
  return items;
}

// 统一数据加载
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [playersRes, closetRes, officialRes] = await Promise.all([
      playerApi.list(),
      fetchAllCloset(),
      withSkinlibChallenge((headers) => textureApi.list({ official: true, perPage: 100 }, headers)),
    ]);

    players.value = playersRes.items;
    closetEntries.value = closetRes;
    officialEntries.value = officialRes.items;

    if (!players.value.some((p) => p.id === currentId.value)) {
      currentId.value = players.value[0]?.id ?? null;
    }
    pendingSkin.value = undefined;
    pendingCape.value = undefined;
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

// 切换角色
function onPlayerChange(id: string | number | null) {
  if (id === null) return;
  currentId.value = Number(id);
  pendingSkin.value = undefined;
  pendingCape.value = undefined;
}

// 选择材质更新预览（先更新预览，再由用户明确保存）
function assign(id: number | null) {
  if (!current.value) return;
  if (assignFor.value === 'skin') {
    pendingSkin.value = id;
  } else {
    pendingCape.value = id;
  }
}

// 还原未保存的预览
function resetPreview() {
  pendingSkin.value = undefined;
  pendingCape.value = undefined;
}

// 保存装扮到角色
async function saveTextures() {
  if (!current.value || !hasPending.value) return;
  const body: { skin?: number | null; cape?: number | null } = {};
  if (pendingSkin.value !== undefined) body.skin = pendingSkin.value;
  if (pendingCape.value !== undefined) body.cape = pendingCape.value;
  await run(async () => {
    await playerApi.setTextures(current.value!.id, body);
    pendingSkin.value = undefined;
    pendingCape.value = undefined;
  });
}

// 判断材质当前状态
function isTextureWearing(t: SelectableTexture) {
  if (!current.value) return false;
  if (t.kind === 'skin') {
    return pendingSkin.value === undefined && current.value.skinTextureId === t.id;
  }
  return pendingCape.value === undefined && current.value.capeTextureId === t.id;
}

function isTexturePreviewing(t: SelectableTexture) {
  if (t.kind === 'skin') {
    return pendingSkin.value === t.id;
  }
  return pendingCape.value === t.id;
}

// 创建角色
function openCreate() {
  newName.value = '';
  createOpen.value = true;
}

async function handleCreate() {
  const name = newName.value.trim();
  if (!name) return;
  await run(async () => {
    const res = await playerApi.create(name);
    createOpen.value = false;
    newName.value = '';
    currentId.value = res.id;
  });
}

// 重命名角色
function openRename() {
  if (!current.value) return;
  renameValue.value = current.value.name;
  renameOpen.value = true;
}

async function handleRename() {
  if (!current.value) return;
  const name = renameValue.value.trim();
  if (!name || name === current.value.name) {
    renameOpen.value = false;
    return;
  }
  await run(async () => {
    await playerApi.rename(current.value!.id, name);
    renameOpen.value = false;
  });
}

// 删除角色
async function handleRemove() {
  if (!current.value) return;
  const target = current.value;
  if (await confirmAction(i18n.t('player.delete_confirm', { name: target.name }))) {
    await run(async () => {
      await playerApi.remove(target.id);
    });
  }
}

// 复制角色名
async function copyPlayerName() {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(current.value.name);
    copiedNotice.value = true;
    setTimeout(() => {
      copiedNotice.value = false;
    }, 2000);
  } catch {
    // 降级支持
  }
}

// 监听当前选中的角色变化时重置未保存的试穿状态
watch(currentId, () => {
  pendingSkin.value = undefined;
  pendingCape.value = undefined;
});

// ── 材质网格虚拟滚动 ─────────────────────────────────────────────────────────
// 列表可达数百项（衣柜 + 官方目录），每张卡片含 SkinPreview（canvas 渲染），
// 全量渲染会把面板撑到数千像素且拖慢滚动。方案：面板定高 + 按行窗口化，
// 只渲染可见行及其上下各一行的卡片。卡片结构定高，行高恒定。

const LIST_HEIGHT_PX = 580;

/** 卡片总高：标签行 26 + 预览 144(h-36) + 名称区 ~54 + 边框 2 ≈ 226，gap 12 */
const CARD_EST_HEIGHT = 226;
const GRID_GAP_PX = 12;

const listViewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportWidth = ref(0);

/** 响应式列数：与模板的 grid-cols-2 sm:3 2xl:4 对齐（列表区约 612px 宽时 4 列起效由容器宽决定） */
const columnCount = computed(() => {
  const w = viewportWidth.value;
  if (w >= 780) return 4;
  if (w >= 480) return 3;
  return 2;
});

const rowHeight = computed(() => CARD_EST_HEIGHT + GRID_GAP_PX);

const totalRows = computed(() => Math.ceil(choices.value.length / columnCount.value));

const visibleRange = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - 1);
  const count = Math.ceil(LIST_HEIGHT_PX / rowHeight.value) + 2;
  const last = Math.min(totalRows.value, first + count);
  return { first, last };
});

const visibleItems = computed(() => {
  const { first, last } = visibleRange.value;
  const start = first * columnCount.value;
  const end = last * columnCount.value;
  return { start, items: choices.value.slice(start, end) };
});

let widthObserver: ResizeObserver | null = null;

function onListScroll(event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

// 列表容器由 v-if 控制渲染（数据加载完成才出现），观察它的挂载时机而非组件 onMounted
watch(listViewport, (el, old) => {
  widthObserver?.disconnect();
  if (old) old.removeEventListener('scroll', onListScroll);
  if (!el) return;
  el.addEventListener('scroll', onListScroll, { passive: true });
  if (!('ResizeObserver' in window)) return;
  widthObserver = new ResizeObserver(entries => {
    for (const entry of entries) viewportWidth.value = entry.contentRect.width;
  });
  widthObserver.observe(el);
  viewportWidth.value = el.clientWidth;
});

onBeforeUnmount(() => widthObserver?.disconnect());

// 数据或列数变化后把滚动位置钳回有效范围（如搜索过滤后列表变短）
watch([choices, columnCount], () => {
  const el = listViewport.value;
  if (!el) return;
  const max = Math.max(0, totalRows.value * rowHeight.value - LIST_HEIGHT_PX);
  if (el.scrollTop > max) {
    el.scrollTop = max;
    scrollTop.value = max;
  }
});

onMounted(() => {
  void site.fetch();
  void load();
});
</script>

<template>
  <PageHeader :title="i18n.t('general.player-manage')">
    <AppButton class="btn-primary" @click="openCreate">
      <AppIcon name="add" />
      {{ i18n.t('player.create') }}
    </AppButton>
  </PageHeader>

  <p v-if="loadError" class="alert alert-danger" role="alert">
    {{ loadError }}
    <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
  </p>

  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <p v-if="actionError" class="alert alert-danger" role="alert">{{ actionError }}</p>

  <!-- 加载状态 -->
  <AppSkeleton v-if="loading" variant="list" :count="3" />

  <!-- 空角色状态 -->
  <EmptyState
    v-else-if="!players.length && !loadError"
    :title="i18n.t('player.empty')"
    icon="sports_esports"
  >
    <AppButton class="btn-primary" @click="openCreate">
      {{ i18n.t('player.create') }}
    </AppButton>
  </EmptyState>

  <!-- 主体工作区 -->
  <div v-else-if="current" class="grid gap-5 lg:grid-cols-12">
    <!-- 左侧：角色切换、当前角色概览与实时 3D 预览 -->
    <div class="space-y-4 lg:col-span-5">
      <!-- 角色选择卡片 -->
      <section class="panel !p-4">
        <label class="mb-2 block text-xs font-medium text-muted" for="player-selector">
          {{ i18n.t('player.select') }}
        </label>
        <AppSelect
          id="player-selector"
          :model-value="currentId"
          class="w-full"
          :options="players.map((p) => ({ value: p.id, label: p.name }))"
          @change="onPlayerChange"
        />

        <!-- 当前角色详细信息与操作 -->
        <div class="mt-4 flex items-center justify-between border-t border-line pt-4">
          <div class="flex items-center gap-3 min-w-0">
            <AvatarPreview
              :hash="previewSkinHash"
              :name="current.name"
              class="h-10 w-10 shrink-0 rounded border border-line bg-surface-2 object-contain"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <h2 class="truncate text-base font-bold leading-tight">{{ current.name }}</h2>
                <AppButton
                  class="btn-icon !h-6 !w-6 text-muted hover:text-foreground"
                  :aria-label="i18n.t('player.copy_name')"
                  @click="copyPlayerName"
                >
                  <AppIcon name="content_copy" class="!text-sm" />
                </AppButton>
                <span
                  v-if="copiedNotice"
                  class="text-[11px] font-medium text-brand-600 dark:text-brand-400"
                >
                  {{ i18n.t('player.name_copied') }}
                </span>
              </div>
              <p class="truncate text-xs text-muted">
                #{{ current.id }}
                <span class="mx-1">·</span>
                <span v-if="previewSkinHash">
                  {{ previewSkinModel === 'slim' ? i18n.t('skinlib.filter.alex') : i18n.t('skinlib.filter.steve') }}
                </span>
                <span v-else>{{ i18n.t('player.texture_empty') }}</span>
              </p>
            </div>
          </div>

          <!-- 快捷操作按钮 -->
          <div class="flex shrink-0 items-center gap-1">
            <AppButton
              class="btn-icon"
              :disabled="busy"
              :aria-label="i18n.t('common.rename')"
              @click="openRename"
            >
              <AppIcon name="edit" />
            </AppButton>
            <AppButton
              class="btn-icon text-danger hover:bg-danger/10"
              :disabled="busy"
              :aria-label="i18n.t('common.delete')"
              @click="handleRemove"
            >
              <AppIcon name="delete_outline" />
            </AppButton>
          </div>
        </div>

        <!-- 当前生效装备状态标签 -->
        <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div class="rounded border border-line bg-surface-2/40 p-2">
            <span class="text-muted block text-[11px]">{{ i18n.t('general.skin') }}</span>
            <span class="font-medium truncate block mt-0.5" :title="currentSkinName || i18n.t('common.none')">
              {{ currentSkinName || i18n.t('common.none') }}
            </span>
          </div>
          <div class="rounded border border-line bg-surface-2/40 p-2">
            <span class="text-muted block text-[11px]">{{ i18n.t('general.cape') }}</span>
            <span class="font-medium truncate block mt-0.5" :title="currentCapeName || i18n.t('common.none')">
              {{ currentCapeName || i18n.t('common.none') }}
            </span>
          </div>
        </div>
      </section>

      <!-- 实时 3D 预览区 -->
      <section class="panel !p-0 overflow-hidden relative">
        <!-- 未保存试穿操作提示条 -->
        <div
          v-if="hasPending"
          class="flex items-center justify-between gap-2 border-b border-brand-500/30 bg-brand-50/90 dark:bg-brand-950/40 px-3 py-2 text-xs backdrop-blur"
        >
          <div class="flex items-center gap-1.5 font-medium text-brand-700 dark:text-brand-300">
            <span class="relative flex h-2 w-2">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-brand-500"></span>
            </span>
            <span>{{ i18n.t('player.previewing_unsaved') }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <AppButton
              class="btn-sm"
              :disabled="busy"
              @click="resetPreview"
            >
              <AppIcon name="undo" class="!text-sm" />
              {{ i18n.t('player.reset_preview') }}
            </AppButton>
            <AppButton
              class="btn-sm btn-primary"
              :loading="busy"
              @click="saveTextures"
            >
              <AppIcon name="check" class="!text-sm" />
              {{ i18n.t('player.save_textures') }}
            </AppButton>
          </div>
        </div>

        <div class="bg-surface-2">
          <TexturePreviewer
            :skin-url="previewSkinHash ? textureUrl(previewSkinHash) : null"
            :cape-url="previewCapeHash ? textureUrl(previewCapeHash) : null"
            :slim="previewSkinModel === 'slim'"
            :name="current.name"
            :height="360"
          />
        </div>
      </section>

      <!-- 登录提示与规则说明 -->
      <section class="panel !p-4 text-xs text-muted space-y-2">
        <div class="flex items-start gap-2">
          <AppIcon name="info" class="text-brand-500 shrink-0 !text-base mt-0.5" />
          <p class="leading-relaxed">{{ i18n.t('player.login_notice') }}</p>
        </div>
        <div class="pt-2 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1">
          <span>
            {{ i18n.t('admin.setting.player_name_rule') }}:
            <strong class="text-foreground font-medium">
              {{ i18n.t(`admin.option.${nameRule}`) }}
            </strong>
          </span>
          <span>
            {{ nameMinLength }} ~ {{ nameMaxLength }}
          </span>
          <span v-if="scoreCost > 0">
            {{ i18n.t('player.cost', { score: i18n.n(scoreCost) }) }}
          </span>
        </div>
      </section>
    </div>

    <!-- 右侧：材质装扮选择区（衣柜收藏 + 官方材质） -->
    <div class="lg:col-span-7">
      <section class="panel !p-4 flex flex-col h-full">
        <!-- 材质类型切换与快捷清除 -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div class="filter-tabs">
            <AppButton
              v-for="kind in (['skin', 'cape'] as const)"
              :key="kind"
              :class="{ selected: assignFor === kind }"
              @click="assignFor = kind"
            >
              {{ i18n.t(`general.${kind}`) }}
            </AppButton>
          </div>

          <div class="flex items-center gap-2">
            <!-- 清除当前槽位材质（先更新预览，再由用户明确保存） -->
            <AppButton
              class="btn-sm"
              :disabled="busy"
              @click="assign(null)"
            >
              <AppIcon name="clear" class="!text-sm" />
              {{ i18n.t(assignFor === 'skin' ? 'player.clear_skin' : 'player.clear_cape') }}
            </AppButton>
          </div>
        </div>

        <!-- 筛选与搜索工具栏 -->
        <div class="my-3 flex flex-wrap items-center gap-2">
          <SearchExpressionField
            v-model="search"
            schema-key="playerTextures"
            class="flex-1 min-w-[160px]"
            :aria-label="i18n.t('general.search')"
            :placeholder="i18n.t('general.search')"
          />

          <AppSelect
            v-model="sourceFilter"
            class="!w-auto min-w-[120px]"
            :options="[
              { value: 'all', label: i18n.t('player.source_all') },
              { value: 'closet', label: i18n.t('player.source_closet') },
              { value: 'official', label: i18n.t('player.source_official') },
            ]"
          />
        </div>

        <!-- 材质网格列表：定高滚动区（与左列 3D 预览面板大致等高），按行虚拟滚动——
             只渲染可见窗口内的卡片。列高链路（面板 h-full）依赖左列高度，内容加载前
             后会跳动，因此列表用固定高度而非跟随面板。
             上方 spacer 撑出被跳过的行高，窗口卡片按自然 grid 流排列（行间不跳号，
             显式 grid-row 跳号会让被跳过的行塌缩、滚动定位失准），下方 spacer 补尾高 -->
        <div
          v-if="choices.length"
          ref="listViewport"
          class="grid gap-3 content-start overflow-y-auto pr-1"
          :style="{ height: `${LIST_HEIGHT_PX}px`, gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }"
        >
            <div :style="{ gridColumn: `1 / -1`, height: `${visibleRange.first * rowHeight}px` }" aria-hidden="true"></div>
            <button
              v-for="t in visibleItems.items"
              :key="t.id"
              type="button"
              class="group relative flex flex-col rounded-lg border text-left transition text-foreground bg-surface hover:border-brand-400 hover:shadow-sm overflow-hidden"
              :style="{ height: `${CARD_EST_HEIGHT}px` }"
              :class="[
                isTexturePreviewing(t)
                  ? '!border-brand-500 !bg-brand-50/50 dark:!bg-brand-950/30 ring-2 ring-brand-500'
                  : isTextureWearing(t)
                    ? 'border-line bg-surface-2/30'
                    : 'border-line',
              ]"
              @click="assign(t.id)"
            >
              <!-- 顶部状态与标签栏（独立一行，绝不遮挡人物） -->
              <div class="flex items-center justify-between gap-1 w-full px-2 pt-2 pb-1.5 min-h-[26px]">
                <div class="flex items-center gap-1 min-w-0">
                  <span
                    v-if="t.isOfficial"
                    class="rounded bg-sky-600/90 px-1 py-0.5 text-[9px] font-semibold text-white leading-none shrink-0"
                  >
                    {{ i18n.t('skinlib.filter.official') }}
                  </span>
                  <span
                    v-if="t.kind === 'skin' && t.model"
                    class="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-medium text-muted leading-none border border-line shrink-0"
                  >
                    {{ t.model === 'slim' ? i18n.t('skinlib.filter.alex') : i18n.t('skinlib.filter.steve') }}
                  </span>
                </div>

                <div class="shrink-0">
                  <span
                    v-if="isTexturePreviewing(t)"
                    class="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white leading-none shadow-xs"
                  >
                    {{ i18n.t('player.previewing') }}
                  </span>
                  <span
                    v-else-if="isTextureWearing(t)"
                    class="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white leading-none shadow-xs"
                  >
                    {{ i18n.t('player.wearing') }}
                  </span>
                </div>
              </div>

              <!-- 材质立绘预览区域（经典棋盘格背景，高宽比舒适完整） -->
              <div class="relative w-full h-36 flex items-center justify-center overflow-hidden texture-preview-box px-2 py-1">
                <SkinPreview
                  :skin-url="textureUrl(t.hash)"
                  :slim="t.model === 'slim'"
                  :cape="t.kind === 'cape'"
                  :alt="t.name"
                  class="max-h-full max-w-full object-contain transition-transform group-hover:scale-105"
                />
              </div>

              <!-- 材质名称与模型说明 -->
              <div class="p-2 w-full border-t border-line/60 bg-surface">
                <span class="block truncate text-xs font-semibold text-center" :title="t.name">
                  {{ t.name }}
                </span>
                <span v-if="t.kind === 'skin' && t.model" class="block truncate text-[11px] text-muted text-center mt-0.5">
                  {{ t.model === 'slim' ? i18n.t('skinlib.filter.alex') : i18n.t('skinlib.filter.steve') }}
                </span>
              </div>
            </button>
            <div
              :style="{ gridColumn: '1 / -1', height: `${Math.max(0, (totalRows - visibleRange.last) * rowHeight)}px` }"
              aria-hidden="true"
            ></div>
          </div>

          <!-- 空结果状态 -->
          <EmptyState
            v-if="!choices.length"
            :title="i18n.t('user.no_textures_ext')"
            icon="checkroom"
          >
            <router-link to="/skinlib" class="btn btn-sm">
              <AppIcon name="add" />
              {{ i18n.t('home.cta_browse') }}
            </router-link>
          </EmptyState>
      </section>
    </div>
  </div>

  <!-- 创建角色对话框 -->
  <AppDialog
    v-model="createOpen"
    :title="i18n.t('player.new')"
    :busy="busy"
    dialog-class="player-create-dialog max-w-md"
  >
    <AppForm class="space-y-4" @submit.prevent="handleCreate">
      <div>
        <label class="mb-1.5 block text-sm font-medium" for="new-player-name">
          {{ i18n.t('general.player-name') }}
        </label>
        <AppInput
          id="new-player-name"
          v-model="newName"
          required
          :minlength="nameMinLength"
          :maxlength="nameMaxLength"
          :placeholder="`${nameMinLength} ~ ${nameMaxLength}`"
        />
        <div class="mt-2 text-xs text-muted space-y-1">
          <p>
            {{ i18n.t('admin.setting.player_name_rule') }}:
            {{ i18n.t(`admin.option.${nameRule}`) }}
          </p>
          <p v-if="scoreCost > 0">
            {{ i18n.t('player.cost', { score: i18n.n(scoreCost) }) }}
          </p>
        </div>
      </div>

      <p v-if="actionError" class="alert alert-danger">{{ actionError }}</p>

      <div class="flex justify-end gap-2 pt-2">
        <AppButton :disabled="busy" @click="createOpen = false">
          {{ i18n.t('common.cancel') }}
        </AppButton>
        <AppButton type="submit" class="btn-primary" :loading="busy">
          {{ i18n.t('player.create') }}
        </AppButton>
      </div>
    </AppForm>
  </AppDialog>

  <!-- 重命名角色对话框 -->
  <AppDialog
    v-model="renameOpen"
    :title="i18n.t('player.rename')"
    :busy="busy"
    dialog-class="player-rename-dialog max-w-md"
  >
    <AppForm class="space-y-4" @submit.prevent="handleRename">
      <div>
        <label class="mb-1.5 block text-sm font-medium" for="rename-player-name">
          {{ i18n.t('general.player-name') }}
        </label>
        <AppInput
          id="rename-player-name"
          v-model="renameValue"
          required
          :minlength="nameMinLength"
          :maxlength="nameMaxLength"
        />
        <p class="mt-2 text-xs text-muted">
          {{ i18n.t('admin.setting.player_name_rule') }}:
          {{ i18n.t(`admin.option.${nameRule}`) }}
        </p>
      </div>

      <p v-if="actionError" class="alert alert-danger">{{ actionError }}</p>

      <div class="flex justify-end gap-2 pt-2">
        <AppButton :disabled="busy" @click="renameOpen = false">
          {{ i18n.t('common.cancel') }}
        </AppButton>
        <AppButton type="submit" class="btn-primary" :loading="busy">
          {{ i18n.t('common.save') }}
        </AppButton>
      </div>
    </AppForm>
  </AppDialog>
</template>

<style scoped>
.texture-preview-box {
  background-color: var(--v0-surface-2);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--v0-border) 45%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--v0-border) 45%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 45%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 45%, transparent) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
