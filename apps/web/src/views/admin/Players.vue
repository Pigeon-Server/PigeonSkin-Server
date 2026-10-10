<script setup lang="ts">
import { confirmAction } from '@/stores/dialog';
import { onMounted, ref } from 'vue';
import { adminApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';

const i18n = useI18n();
interface Row {
  id: number;
  name: string;
  ownerId: number;
  ownerName: string | null;
  skinTextureId: number | null;
  capeTextureId: number | null;
  updatedAt: number;
}
const items = ref<Row[]>([]);
const page = ref(1);
const totalPages = ref(1);
const keyword = ref('');
const errMsg = ref('');
const loading = ref(true);
const editOpen = ref(false);
const editing = ref<Row | null>(null);
const editName = ref('');
const editOwner = ref(0);
const editSkin = ref<number | null>(null);
const editCape = ref<number | null>(null);
const busy = ref(false);

async function load() {
  loading.value = true;
  errMsg.value = '';
  try {
    const data = await adminApi.players({ keyword: keyword.value || undefined, page: page.value });
    items.value = data.items;
    totalPages.value = data.totalPages;
  } catch {
    errMsg.value = i18n.t('common.internal_error');
  } finally { loading.value = false; }
}

function rename(row: Row) {
  editing.value = row;
  editName.value = row.name;
  editOwner.value = row.ownerId;
  editSkin.value = row.skinTextureId;
  editCape.value = row.capeTextureId;
  editOpen.value = true;
}
async function save() {
  if (!editing.value) return;
  busy.value = true;
  errMsg.value = '';
  try {
    await adminApi.patchPlayer(editing.value.id, {
      name: editName.value,
      ownerId: editOwner.value,
      skin: editSkin.value || null,
      cape: editCape.value || null,
    });
    editOpen.value = false;
    await load();
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function remove(row: Row) {
  if (!(await confirmAction(i18n.t('common.confirm')))) return;
  try {
    await adminApi.deletePlayer(row.id);
    await load();
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  }
}

onMounted(load);
</script>

<template>
  <div class="page page--dense">
    <PageHeader :title="i18n.t('general.player-manage')" />
    <SearchExpressionField
      v-model="keyword"
      schema-key="adminPlayers"
      class="max-w-sm"
      :placeholder="i18n.t('admin.search_name')"
      @submit="page = 1; load()"
    />
    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>

    <AppSkeleton v-if="loading" :count="3" /><div v-else class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="table">
        <thead>
          <tr>
            <th>{{ i18n.t('common.id') }}</th>
            <th>{{ i18n.t('auth.player-name') }}</th>
            <th>{{ i18n.t('admin.owner') }}</th>
            <th>{{ i18n.t('admin.skin_id') }}</th>
            <th>{{ i18n.t('admin.cape_id') }}</th>
            <th class="text-right">{{ i18n.t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in items" :key="p.id">
            <td class="text-muted">#{{ p.id }}</td>
            <td class="font-medium">{{ p.name }}</td>
            <td class="text-muted">
              {{ p.ownerName ?? i18n.t('admin.anonymous') }} (#{{ p.ownerId }})
            </td>
            <td>{{ p.skinTextureId || i18n.t('common.none') }}</td>
            <td>{{ p.capeTextureId || i18n.t('common.none') }}</td>
            <td class="text-right">
              <AppButton class="btn btn-sm" @click="rename(p)">
                {{ i18n.t('common.edit') }}
              </AppButton>
              <AppButton class="btn btn-sm btn-danger ml-1" @click="remove(p)">
                <AppIcon name="delete_outline" />
              </AppButton>
            </td>
          </tr><tr v-if="!items.length"><td colspan="6" class="text-center text-muted py-6">{{ i18n.t('general.noResult') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <AppButton class="btn btn-sm" :disabled="page <= 1" @click="page--; load()">
        {{ i18n.t('common.prev') }}
      </AppButton>
      <span class="px-2 py-1 text-sm text-muted">{{ page }} / {{ totalPages }}</span>
      <AppButton class="btn btn-sm" :disabled="page >= totalPages" @click="page++; load()">
        {{ i18n.t('common.next') }}
      </AppButton>
    </div>
  </div>
  <AppDialog v-model="editOpen" :title="i18n.t('admin.player_edit')" :busy="busy">
    <AppForm class="space-y-4" @submit.prevent="save">
      <label for="edit-player-name">{{ i18n.t('general.player-name') }}</label>
              <AppInput id="edit-player-name" v-model="editName" required />
      <label for="edit-player-owner">{{ i18n.t('admin.owner') }}</label>
      <AppNumberField id="edit-player-owner" v-model="editOwner" :min="1" required />
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="edit-player-skin">{{ i18n.t('admin.skin_id') }}</label>
          <AppNumberField id="edit-player-skin" v-model="editSkin" :min="0" />
        </div>
        <div>
          <label for="edit-player-cape">{{ i18n.t('admin.cape_id') }}</label>
          <AppNumberField id="edit-player-cape" v-model="editCape" :min="0" />
        </div>
      </div>
      <p v-if="errMsg" class="alert alert-danger">{{ errMsg }}</p>
      <AppButton type="submit" class="btn-primary" :loading="busy">
        {{ i18n.t('common.save') }}
      </AppButton>
    </AppForm>
  </AppDialog>
</template>
