<script setup lang="ts">
import { promptValue, confirmAction } from '@/stores/dialog';
import { onMounted, ref } from 'vue';
import { adminApi, avatarUrl, type AdminTextureRow } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';

const i18n = useI18n();
const items = ref<AdminTextureRow[]>([]);
const page = ref(1);
const totalPages = ref(1);
const keyword = ref('');
const errMsg = ref('');
const loading = ref(true);
const notice = ref('');
const busyId = ref(0);

async function load() {
  loading.value = true;
  errMsg.value = '';
  try {
    const data = await adminApi.textures({ keyword: keyword.value || undefined, page: page.value });
    items.value = data.items;
    totalPages.value = data.totalPages;
  } catch {
    errMsg.value = i18n.t('common.internal_error');
  } finally { loading.value = false; }
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
  if (!name || name === t.name || busyId.value) return;
  busyId.value = t.id; errMsg.value = ''; notice.value = '';
  try { await adminApi.patchTexture(t.id, { name }); notice.value = i18n.t('general.op-success'); await load(); }
  catch(e) { errMsg.value = apiErrorMessage(e); }
  finally { busyId.value = 0; }
}
onMounted(load);
</script>

<template>
  <div class="page page--dense"><PageHeader :title="i18n.t('general.skinlib')" />
    <SearchExpressionField
      v-model="keyword"
      schema-key="adminTextures"
      class="max-w-sm"
      :placeholder="i18n.t('admin.search_name')"
      @submit="page = 1; load()"
    />
    <p v-if="notice" class="alert alert-success">{{ notice }}</p>
    <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>

    <AppSkeleton v-if="loading" :count="3" /><div v-else class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="table">
        <thead>
          <tr>
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
            <td class="text-muted">#{{ t.id }}</td>
            <td>
              <router-link :to="`/skinlib/${t.id}`" class="flex items-center gap-2 hover:underline">
                <img :src="avatarUrl(t.hash, { size: 64 })" class="h-8 w-8 rounded object-contain" :alt="t.name" loading="lazy" />
                <span class="font-medium">{{ t.name }}</span>
              </router-link>
            </td>
            <td>{{ t.kind === 'cape' ? i18n.t('general.cape') : i18n.t('general.skin') }}</td>
            <td>
              <span class="badge" :class="t.visibility === 'public' ? 'badge-success' : 'badge-default'">
                {{ t.visibility === 'public' ? i18n.t('general.public') : i18n.t('general.private') }}
              </span>
            </td>
            <td class="text-muted">{{ t.uploaderName ?? i18n.t('admin.anonymous') }}</td>
            <td>{{ i18n.n(t.likes) }}</td>
            <td class="whitespace-nowrap text-right"><AppButton class="btn-sm mr-1" :disabled="busyId !== 0" @click="rename(t)">{{ i18n.t('common.rename') }}</AppButton>
              <AppButton
                class="btn btn-sm"
                :disabled="busyId === t.id"
                @click="setVisibility(t, t.visibility === 'public' ? 'private' : 'public')"
              >
                {{ t.visibility === 'public' ? i18n.t('general.private') : i18n.t('general.public') }}
              </AppButton>
              <AppButton
                class="btn btn-danger btn-sm ml-1"
                :disabled="busyId === t.id"
                @click="removeTexture(t)"
              >
                {{ i18n.t('common.delete') }}
              </AppButton>
            </td>
          </tr><tr v-if="!items.length"><td colspan="7" class="text-center text-muted py-6">{{ i18n.t('general.noResult') }}</td></tr>
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
