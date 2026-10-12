<script setup lang="ts">
import { promptValue, confirmAction } from '@/stores/dialog';
import { computed, onMounted, ref } from 'vue';
import { adminApi, avatarUrl, previewUrl, type AdminTextureRow } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';
import TextureHoverCard from '@/components/texture/TextureHoverCard.vue';

type KindFilter = 'all' | 'skin' | 'cape';
type VisibilityFilter = 'all' | 'public' | 'private';

const KIND_FILTERS: KindFilter[] = ['all', 'skin', 'cape'];
const VISIBILITY_FILTERS: VisibilityFilter[] = ['all', 'public', 'private'];
/** undefined = 不限来源；true = 只看官方材质（后台要区分官方与用户上传） */
const OFFICIAL_FILTERS: Array<boolean | undefined> = [undefined, true];

const i18n = useI18n();
const items = ref<AdminTextureRow[]>([]);
const page = ref(1);
const totalPages = ref(1);
const total = ref(0);
const keyword = ref('');
const kind = ref<KindFilter>('all');
const visibility = ref<VisibilityFilter>('all');
const official = ref<boolean | undefined>(undefined);
const errMsg = ref('');
const loading = ref(true);
const notice = ref('');
const busyId = ref(0);
const batchBusy = ref(false);
/**
 * 选择集按"当前可见的行"维护：翻页或改筛选后丢弃看不见的 id。
 * 否则批量操作会打到管理员已经看不到的行上，勾选数也对不上账。
 */
const selected = ref<Set<number>>(new Set());

const busy = computed(() => busyId.value !== 0 || batchBusy.value);
const selectedIds = computed(() => items.value.filter(t => selected.value.has(t.id)).map(t => t.id));
const allSelected = computed(() => items.value.length > 0 && selected.value.size === items.value.length);

/**
 * 列表缩略图：皮肤沿用头像（旧版行为，一眼能认出是哪张脸），披风没有头像
 * 端点（`/avatar/{hash}` 对披风返回 422），只能退到整张预览图。
 */
function thumbnailUrl(texture: AdminTextureRow): string {
  return texture.kind === 'cape' ? previewUrl(texture.hash, texture) : avatarUrl(texture.hash, { size: 64 });
}

function kindLabel(value: KindFilter): string {
  if (value === 'all') return i18n.t('common.all');
  return i18n.t(value === 'cape' ? 'general.cape' : 'general.skin');
}

function visibilityLabel(value: VisibilityFilter): string {
  if (value === 'all') return i18n.t('common.all');
  return i18n.t(value === 'private' ? 'general.private' : 'general.public');
}

async function load() {
  loading.value = true;
  errMsg.value = '';
  try {
    const data = await adminApi.textures({
      keyword: keyword.value || undefined,
      kind: kind.value === 'all' ? undefined : kind.value,
      visibility: visibility.value === 'all' ? undefined : visibility.value,
      official: official.value,
      page: page.value,
    });
    items.value = data.items;
    totalPages.value = data.totalPages;
    total.value = data.total;
    const visible = new Set(data.items.map(t => t.id));
    selected.value = new Set([...selected.value].filter(id => visible.has(id)));
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally { loading.value = false; }
}

function search() {
  page.value = 1;
  selected.value = new Set();
  void load();
}

function setKindFilter(next: KindFilter) {
  if (kind.value === next) return;
  kind.value = next;
  search();
}

function setVisibilityFilter(next: VisibilityFilter) {
  if (visibility.value === next) return;
  visibility.value = next;
  search();
}

function setOfficialFilter(next: boolean | undefined) {
  if (official.value === next) return;
  official.value = next;
  search();
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(items.value.map(t => t.id));
}

function toggleRow(id: number) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

/** 批量动作完成后重新取列表；删除最后一页的最后几行时回退一页，避免停在空页 */
async function runBatch(input: { action: 'delete' | 'visibility'; ids: number[]; visibility?: 'public' | 'private' }) {
  errMsg.value = '';
  notice.value = '';
  batchBusy.value = true;
  try {
    const result = await adminApi.batchTextures(input);
    notice.value = i18n.t('admin.texture_batch_done', { count: i18n.n(result.affected) });
    selected.value = new Set();
    await load();
    if (!items.value.length && page.value > 1) { page.value -= 1; await load(); }
  } catch (e) {
    notice.value = '';
    errMsg.value = apiErrorMessage(e);
  } finally { batchBusy.value = false; }
}

async function removeSelected() {
  const ids = selectedIds.value;
  if (!ids.length) return;
  if (!await confirmAction(i18n.t('admin.texture_batch_delete_confirm', { count: i18n.n(ids.length) }))) return;
  await runBatch({ action: 'delete', ids });
}

async function setSelectedVisibility(next: 'public' | 'private') {
  const ids = selectedIds.value;
  if (!ids.length) return;
  await runBatch({ action: 'visibility', ids, visibility: next });
}

async function removeTexture(t: AdminTextureRow) {
  if (!await confirmAction(i18n.t('admin.texture_delete_confirm'))) return;
  errMsg.value = '';
  notice.value = '';
  busyId.value = t.id;
  try {
    await adminApi.deleteTexture(t.id);
    notice.value = i18n.t('admin.texture_deleted');
    await load();
    if (!items.value.length && page.value > 1) { page.value -= 1; await load(); }
  } catch (e) {
    notice.value = '';
    errMsg.value = apiErrorMessage(e);
  } finally {
    busyId.value = 0;
  }
}

async function setVisibility(t: AdminTextureRow, visibility: 'public' | 'private') {
  if (t.visibility === visibility) return;
  errMsg.value = '';
  notice.value = '';
  busyId.value = t.id;
  try {
    await adminApi.patchTexture(t.id, { visibility });
    notice.value = i18n.t('admin.visibility_changed');
    await load();
  } catch (e) {
    notice.value = '';
    errMsg.value = apiErrorMessage(e);
  } finally {
    busyId.value = 0;
  }
}

async function rename(t: AdminTextureRow) {
  const name = await promptValue(i18n.t('skinlib.setNewTextureName'), t.name);
  if (!name || name === t.name || busy.value) return;
  busyId.value = t.id; errMsg.value = ''; notice.value = '';
  try { await adminApi.patchTexture(t.id, { name }); notice.value = i18n.t('general.op-success'); await load(); }
  catch(e) { errMsg.value = apiErrorMessage(e); }
  finally { busyId.value = 0; }
}
onMounted(load);
</script>

<template>
  <div class="page page--dense">
    <PageHeader :title="i18n.t('general.skinlib')">
      <template #meta>
        <span v-if="total > 0" class="resource-count">{{ i18n.t('common.count', { count: i18n.n(total) }, total) }}</span>
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-center gap-3">
      <SearchExpressionField
        v-model="keyword"
        schema-key="adminTextures"
        class="max-w-sm"
        :placeholder="i18n.t('admin.search_name')"
        @submit="search"
      />
      <div class="filter-tabs" role="group" :aria-label="i18n.t('search.field.kind')">
        <AppButton
          v-for="value in KIND_FILTERS"
          :key="value"
          class="btn-sm"
          :class="{ selected: kind === value }"
          :aria-pressed="kind === value"
          @click="setKindFilter(value)"
        >
          {{ kindLabel(value) }}
        </AppButton>
      </div>
      <div class="filter-tabs" role="group" :aria-label="i18n.t('search.field.visibility')">
        <AppButton
          v-for="value in VISIBILITY_FILTERS"
          :key="value"
          class="btn-sm"
          :class="{ selected: visibility === value }"
          :aria-pressed="visibility === value"
          @click="setVisibilityFilter(value)"
        >
          {{ visibilityLabel(value) }}
        </AppButton>
      </div>
      <div class="filter-tabs" role="group" :aria-label="i18n.t('search.field.official')">
        <AppButton
          v-for="value in OFFICIAL_FILTERS"
          :key="String(value)"
          class="btn-sm"
          :class="{ selected: official === value }"
          :aria-pressed="official === value"
          @click="setOfficialFilter(value)"
        >
          {{ value === undefined ? i18n.t('common.all') : i18n.t('skinlib.official_resource') }}
        </AppButton>
      </div>
    </div>

    <p v-if="notice" class="alert alert-success">{{ notice }}</p>
    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>

    <div
      v-if="selectedIds.length"
      class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2"
      role="group"
      :aria-label="i18n.t('admin.texture_selected', { count: i18n.n(selectedIds.length) })"
    >
      <span class="text-sm">{{ i18n.t('admin.texture_selected', { count: i18n.n(selectedIds.length) }) }}</span>
      <AppButton class="btn-sm" :disabled="busy" @click="setSelectedVisibility('public')">{{ i18n.t('admin.texture_batch_public') }}</AppButton>
      <AppButton class="btn-sm" :disabled="busy" @click="setSelectedVisibility('private')">{{ i18n.t('admin.texture_batch_private') }}</AppButton>
      <AppButton class="btn btn-danger btn-sm" :disabled="busy" @click="removeSelected">{{ i18n.t('common.delete') }}</AppButton>
    </div>

    <AppSkeleton v-if="loading && !items.length" variant="table" :count="8" /><div v-else class="overflow-x-auto rounded-xl border border-line bg-surface aria-busy:opacity-60 aria-busy:cursor-progress" :aria-busy="loading">
      <table class="table">
        <thead>
          <tr>
            <th class="w-10">
              <AppCheckbox
                :model-value="allSelected"
                :disabled="!items.length || busy"
                :aria-label="i18n.t('admin.texture_select_page')"
                @update:model-value="toggleAll"
              />
            </th>
            <th>{{ i18n.t('common.id') }}</th>
            <th>{{ i18n.t('skinlib.show.name') }}</th>
            <th>{{ i18n.t('skinlib.upload.texture-type') }}</th>
            <th>{{ i18n.t('general.private') }}</th>
            <th>{{ i18n.t('skinlib.show.uploader') }}</th>
            <th>{{ i18n.t('skinlib.show.likes') }}</th>
            <th class="text-right">{{ i18n.t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in items" :key="t.id">
            <td>
              <AppCheckbox
                :model-value="selected.has(t.id)"
                :disabled="busy"
                :aria-label="i18n.t('admin.texture_select_row', { name: t.name })"
                @update:model-value="toggleRow(t.id)"
              />
            </td>
            <td class="text-muted">#{{ t.id }}</td>
            <td>
              <router-link :to="`/skinlib/${t.id}`" class="flex items-center gap-2 hover:underline">
                <TextureHoverCard :texture="t">
                  <img
                    :src="thumbnailUrl(t)"
                    class="h-10 w-10 shrink-0 rounded object-contain"
                    :alt="t.name"
                    loading="lazy"
                  />
                  <span class="font-medium">{{ t.name }}</span>
                </TextureHoverCard>
              </router-link>
            </td>
            <td>{{ t.kind === 'cape' ? i18n.t('general.cape') : i18n.t('general.skin') }}</td>
            <td>
              <span class="badge" :class="t.visibility === 'public' ? 'badge-success' : 'badge-default'">
                {{ t.visibility === 'public' ? i18n.t('general.public') : i18n.t('general.private') }}
              </span>
            </td>
            <td class="text-muted">{{ t.official ? i18n.t('skinlib.official_resource') : t.uploaderName ?? i18n.t('admin.anonymous') }}</td>
            <td>{{ i18n.n(t.likes) }}</td>
            <td class="whitespace-nowrap text-right"><AppButton class="btn-sm mr-1" :disabled="busy" @click="rename(t)">{{ i18n.t('common.rename') }}</AppButton>
              <AppButton
                class="btn btn-sm"
                :disabled="busy"
                @click="setVisibility(t, t.visibility === 'public' ? 'private' : 'public')"
              >
                {{ t.visibility === 'public' ? i18n.t('general.private') : i18n.t('general.public') }}
              </AppButton>
              <AppButton
                class="btn btn-danger btn-sm ml-1"
                :disabled="busy"
                @click="removeTexture(t)"
              >
                {{ i18n.t('common.delete') }}
              </AppButton>
            </td>
          </tr><tr v-if="!items.length"><td colspan="8" class="text-center text-muted py-6">{{ i18n.t('general.noResult') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <AppButton class="btn btn-sm" :disabled="page <= 1" @click="page--; load()">{{ i18n.t('common.prev') }}</AppButton>
      <span class="px-2 py-1 text-sm text-muted">{{ page }} / {{ totalPages }}</span>
      <AppButton class="btn btn-sm" :disabled="page >= totalPages" @click="page++; load()">{{ i18n.t('common.next') }}</AppButton>
    </div>
  </div>
</template>
