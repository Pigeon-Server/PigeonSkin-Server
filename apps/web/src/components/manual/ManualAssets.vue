<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { MANUAL_ASSET_ACCEPT, MANUAL_ASSET_MAX_BYTES, manualBuiltinAssets, type ManualAsset } from '@pigeon-skin/shared/manual';
import { ApiError, manualApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useManualStore } from '@/stores/manual';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';
const open = defineModel<boolean>({ default: false });
const props = defineProps<{ draft: string }>();
const emit = defineEmits<{ insert: [asset: ManualAsset]; busy: [value: boolean]; error: [message: string] }>();
const i18n = useI18n();
const manual = useManualStore();
const dialog = ref<HTMLDialogElement>();
const picker = ref<HTMLInputElement>();
const assets = ref<ManualAsset[]>([]);
const page = ref(1), total = ref(0);
const loading = ref(false), uploading = ref(false);
const error = ref('');
const kind = ref('');
const items = computed(() => [...(page.value === 1 ? manualBuiltinAssets : []), ...assets.value].filter(asset => !kind.value || asset.kind === kind.value));
function message(e: unknown) { return apiErrorMessage(e); }
async function fetchAssets() {
  loading.value = true; error.value = '';
  try { const result = await manualApi.assets(page.value); assets.value = result.items; total.value = result.total; }
  catch (e) { error.value = message(e); }
  finally { loading.value = false; }
}
function usedBy(asset: ManualAsset) {
  return [...new Set([...(asset.usedBy || []), ...manual.pages.value.filter(page => manual.rawContent(page.slug).includes(asset.url)).map(page => page.title)])];
}
async function upload(files: File[]) {
  if (uploading.value || !files.length) return;
  uploading.value = true; error.value = ''; emit('busy', true);
  try {
    for (const file of files) {
      if (file.size > MANUAL_ASSET_MAX_BYTES) throw new ApiError(422, { error: 'manual.asset_too_large' });
      const asset = await manualApi.upload(file);
      emit('insert', asset);
    }
    page.value = 1; open.value = false; await nextTick();
    await fetchAssets();
  } catch (e) { error.value = message(e); emit('error', error.value); }
  finally { uploading.value = false; emit('busy', false); if (picker.value) picker.value.value = ''; }
}
function pick() { if (!uploading.value) picker.value?.click(); }
function select(event: Event) { void upload(Array.from((event.target as HTMLInputElement).files || [])); }
function insert(asset: ManualAsset) { emit('insert', asset); open.value = false; }
async function remove(asset: ManualAsset) {
  if (asset.builtin || usedBy(asset).length || props.draft.includes(asset.url)) return;
  open.value = false; await nextTick();
  if (await confirmAction(i18n.t('manual.asset_delete_confirm'))) {
    try { await manualApi.deleteAsset(asset.id); await fetchAssets(); }
    catch (e) { error.value = message(e); }
  }
  open.value = true;
}
async function changePage(value: number) { page.value = value; await fetchAssets(); }
watch(open, async value => {
  await nextTick();
  if (value) { dialog.value?.showModal(); await fetchAssets(); }
  else dialog.value?.close();
});
defineExpose({ upload, pick });
</script>
<template>
  <input ref="picker" type="file" hidden multiple :accept="MANUAL_ASSET_ACCEPT" @change="select" />
  <dialog ref="dialog" class="manual-assets-dialog" :aria-label="i18n.t('manual.assets')" @cancel.prevent="!uploading && (open = false)" @click="($event.target === $event.currentTarget && !uploading) && (open = false)">
    <header><h2>{{ i18n.t('manual.assets') }}</h2><AppButton class="btn-icon" :disabled="uploading" :aria-label="i18n.t('common.close')" @click="open = false"><AppIcon name="close" /></AppButton></header>
    <div class="manual-assets-body">
      <div class="flex flex-wrap justify-between gap-3 mb-3"><AppSelect v-model="kind" class="!w-auto" :options="[{ value: '', label: i18n.t('manual.all_assets') }, ...(['image', 'audio', 'video'] as const).map(value => ({ value, label: i18n.t('manual.' + value) }))]" :aria-label="i18n.t('manual.asset_type')" /><AppButton class="btn-primary" :loading="uploading" @click="pick"><AppIcon name="upload" />{{ i18n.t('manual.upload_insert') }}</AppButton></div>
      <p class="text-xs text-muted mb-4">{{ i18n.t('manual.asset_hint') }}</p>
      <p v-if="error" role="alert" class="alert alert-danger">{{ error }}</p>
      <AppSkeleton v-if="loading" :count="3" />
      <div v-else class="manual-assets-grid"><article v-for="asset in items" :key="asset.id" class="manual-asset">
        <div class="manual-asset-preview"><img v-if="asset.kind === 'image'" :src="asset.url" :alt="asset.name" loading="lazy" /><AppIcon v-else :name="asset.kind === 'audio' ? 'audiotrack' : 'movie'" /></div>
        <h3 :title="asset.name">{{ asset.name }}</h3><p class="text-xs text-muted">{{ asset.builtin ? i18n.t('manual.builtin') : `${(asset.size / 1024 / 1024).toFixed(2)} MB` }} · {{ i18n.t(`manual.${asset.kind}`) }}</p>
        <p class="manual-asset-usage">{{ usedBy(asset).length ? i18n.t('manual.asset_used', { pages: usedBy(asset).join('、') }) : draft.includes(asset.url) ? i18n.t('manual.asset_draft') : i18n.t('manual.asset_unused') }}</p>
        <div class="flex justify-between gap-2 mt-3"><AppButton class="btn-sm btn-primary" :disabled="uploading" @click="insert(asset)">{{ i18n.t('manual.insert') }}</AppButton><AppButton v-if="!asset.builtin" class="btn-sm" :disabled="uploading || !!usedBy(asset).length || draft.includes(asset.url)" @click="remove(asset)">{{ i18n.t('common.delete') }}</AppButton></div>
      </article></div>
      <p v-if="!loading && !items.length" class="text-muted text-sm py-6">{{ i18n.t('manual.asset_empty') }}</p>
    </div>
    <footer v-if="total > 50"><AppButton class="btn-sm" :disabled="page <= 1 || uploading" @click="changePage(page - 1)">{{ i18n.t('common.prev') }}</AppButton><span>{{ page }} / {{ Math.ceil(total / 50) }}</span><AppButton class="btn-sm" :disabled="page * 50 >= total || uploading" @click="changePage(page + 1)">{{ i18n.t('common.next') }}</AppButton></footer>
  </dialog>
</template>
<style scoped>
.manual-assets-dialog { position: fixed; inset: 0; margin: auto; padding: 0; width: min(940px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); background: var(--v0-surface); color: var(--ink); border: 1px solid var(--v0-border); border-radius: 10px; opacity: 0; transform: translateY(8px) scale(.98); transition: opacity .18s, transform .18s, display .18s allow-discrete, overlay .18s allow-discrete; }
.manual-assets-dialog[open] { display: flex; flex-direction: column; opacity: 1; transform: none; }
.manual-assets-dialog::backdrop { background: #0007; opacity: 0; transition: opacity .18s, display .18s allow-discrete, overlay .18s allow-discrete; }
.manual-assets-dialog[open]::backdrop { opacity: 1; }
.manual-assets-dialog header, .manual-assets-dialog footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 20px; flex-shrink: 0; }
.manual-assets-dialog header { border-bottom: 1px solid var(--v0-border); }
.manual-assets-dialog header h2 { font-size: 18px; font-weight: 650; }
.manual-assets-dialog footer { border-top: 1px solid var(--v0-border); }
.manual-assets-body { padding: 20px; overflow-y: auto; min-height: 0; }
.manual-assets-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; }
.manual-asset { padding: 12px; border: 1px solid var(--v0-border); border-radius: 8px; min-width: 0; }
.manual-asset-preview { height: 120px; display: flex; align-items: center; justify-content: center; background: var(--v0-surface-2); border-radius: 4px; overflow: hidden; margin-bottom: 12px; }
.manual-asset-preview img { max-height: 100%; max-width: 100%; object-fit: contain; }
.manual-asset-preview .material-icons { font-size: 40px; color: var(--v0-muted); }
.manual-asset h3 { font-size: 13px; font-weight: 650; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.manual-asset-usage { margin-top: 8px; font-size: 11px; line-height: 1.6; color: var(--v0-muted); overflow-wrap: anywhere; }
:global(body:has(.manual-assets-dialog[open])) { overflow: hidden; }
@starting-style { .manual-assets-dialog[open] { opacity: 0; transform: translateY(8px) scale(.98); } .manual-assets-dialog[open]::backdrop { opacity: 0; } }
@media (max-width: 767px) { .manual-assets-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } .manual-assets-body { padding: 12px; } }
@media (max-width: 359px) { .manual-assets-grid { grid-template-columns: minmax(0,1fr); } }
@media (prefers-reduced-motion: reduce) { .manual-assets-dialog, .manual-assets-dialog::backdrop { transition: none; } }
</style>
