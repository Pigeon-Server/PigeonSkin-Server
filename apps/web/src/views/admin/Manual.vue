<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { manualPages, renderManualContent, validManualSlug, manualAssetMarkdown, type ManualAsset } from '@pigeon-skin/shared/manual';
import { manualContent } from '@/content/manual';
import { useManualStore } from '@/stores/manual';
import { useSiteSettings } from '@/stores/site';
import { useI18n, prepareLocale } from '@/stores/i18n';
import { LOCALE_OPTIONS, normalizeLocale, type Locale } from '@pigeon-skin/shared/locales';
import { manualApi } from '@/api';
import { confirmAction } from '@/stores/dialog';
import ManualMarkdown from '@/components/manual/ManualMarkdown.vue';
import ManualAssets from '@/components/manual/ManualAssets.vue';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const manual = useManualStore();
const site = useSiteSettings();
const i18n = useI18n();
const editingLocale = ref<Locale>(normalizeLocale(i18n.locale.value));
const editorPages = computed(() => manual.pagesFor(editingLocale.value, true));
const editorGroups = computed(() => manual.groupsFor(editingLocale.value, true));
let pendingLocale: Locale | undefined;
const requested = String(route.query.document || '');
const slug = ref(requested);
const newPage = ref(false);
const draftSlug = ref('');
const group = ref('');
const title = ref('');
const description = ref('');
const content = ref('');
const revision = ref(0);
const baseline = ref('');
const busy = ref(false);
const ready = ref(false);
const error = ref('');
const notice = ref('');
const mode = ref<'edit' | 'preview' | 'split'>('split');
const assetsOpen = ref(false), uploading = ref(false), dragging = ref(false);
const sourceInput = ref<HTMLTextAreaElement>();
const assetLibrary = ref<InstanceType<typeof ManualAssets>>();
async function insertAsset(asset: ManualAsset) {
  const start = sourceInput.value?.selectionStart ?? content.value.length;
  const end = sourceInput.value?.selectionEnd ?? start;
  const markdown = '\n\n' + manualAssetMarkdown(asset) + '\n\n';
  if (content.value.length - (end - start) + markdown.length > 200000) { error.value = i18n.t('manual.content_too_long'); return; }
  content.value = content.value.slice(0, start) + markdown + content.value.slice(end);
  await nextTick(); sourceInput.value?.setSelectionRange(start + markdown.length, start + markdown.length);
  if (!uploading.value) sourceInput.value?.focus();
}
function resourceBusy(value: boolean) { uploading.value = value; if (!value) { void nextTick(() => sourceInput.value?.focus()); if (pendingLocale) finish(); } }
function paste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
  if (files.length) { event.preventDefault(); void assetLibrary.value?.upload(files); }
}
function drop(event: DragEvent) {
  dragging.value = false;
  if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); void assetLibrary.value?.upload(Array.from(event.dataTransfer.files)); }
}
function dragover(event: DragEvent) { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragging.value = true; } }
const dirty = computed(() => ready.value && baseline.value !== JSON.stringify([title.value, description.value, content.value, group.value, draftSlug.value]));
const customized = computed(() => manual.overridesFor(editingLocale.value).some(item => item.slug === slug.value));
const builtin = computed(() => !newPage.value && manualPages.some(page => page.slug === slug.value));
const slugValid = computed(() => !newPage.value || (!!draftSlug.value && validManualSlug(draftSlug.value) && !editorPages.value.some(page => page.slug === draftSlug.value)));
const preview = computed(() => renderManualContent(content.value, manual.siteUrl.value, site.get('site_name')));
function load() {
  const original = editorPages.value.find(page => page.slug === slug.value);
  if (!original) { slug.value = ''; load(); return; }
  const document = manual.documentsFor(editingLocale.value).find(item => item.slug === slug.value);
  title.value = document?.title ?? (manualPages.some(page => page.slug === slug.value) ? original.title : '');
  description.value = document?.description ?? (manualPages.some(page => page.slug === slug.value) ? original.description : '');
  content.value = document?.content ?? manualContent(slug.value, editingLocale.value);
  revision.value = manual.overridesFor(editingLocale.value).find(item => item.slug === slug.value)?.updatedAt ?? 0;
  group.value = document?.group ?? original.group;
  draftSlug.value = slug.value;
  newPage.value = false;
  baseline.value = JSON.stringify([title.value, description.value, content.value, group.value, draftSlug.value]);
  ready.value = true;
}
async function create() {
  if (uploading.value) return;
  if (dirty.value && !await confirmAction(i18n.t('manual.discard'))) return;
  newPage.value = true; slug.value = ''; draftSlug.value = ''; title.value = ''; description.value = ''; content.value = ''; revision.value = 0;
  group.value = group.value || i18n.t('manual.groups.start'); ready.value = true; error.value = ''; notice.value = '';
  baseline.value = JSON.stringify([title.value, description.value, content.value, group.value, draftSlug.value]);
}
function message(e: unknown) { return apiErrorMessage(e); }
async function refresh() {
  if (uploading.value) return;
  if (dirty.value && !await confirmAction(i18n.t('manual.discard'))) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await prepareLocale(editingLocale.value);
    await manual.fetch(true, editingLocale.value);
    if (manual.errorFor(editingLocale.value)) error.value = i18n.t(manual.errorFor(editingLocale.value));
    else load();
  } catch (e) { error.value = message(e); }
  finally { finish(); }
}
async function select(selected: string | number | null) {
  const value = String(selected ?? '');
  if (uploading.value) return;
  if (dirty.value && !await confirmAction(i18n.t('manual.discard'))) return;
  slug.value = value; error.value = ''; notice.value = ''; load();
}
async function save() {
  if (busy.value || uploading.value || !ready.value || !slugValid.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const document = await manualApi.save(newPage.value ? draftSlug.value : slug.value, { title: title.value, description: description.value, content: content.value, group: group.value, revision: revision.value }, editingLocale.value);
    slug.value = document.slug; manual.update(document); await manual.fetch(true, editingLocale.value); load(); notice.value = i18n.t('manual.saved');
  } catch (e) { error.value = message(e); }
  finally { finish(); }
}
async function reset() {
  if (busy.value || uploading.value || !await confirmAction(i18n.t(builtin.value ? 'manual.reset_confirm' : 'manual.delete_confirm'))) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { const restore = builtin.value; await manualApi.reset(slug.value, revision.value, editingLocale.value); manual.remove(slug.value, editingLocale.value); await manual.fetch(true, editingLocale.value); if (!restore) slug.value = ''; load(); notice.value = i18n.t(restore ? 'manual.restored' : 'manual.deleted'); }
  catch (e) { error.value = message(e); }
  finally { finish(); }
}

function finish() {
  busy.value = false;
  const next = pendingLocale;
  pendingLocale = undefined;
  if (next && next !== editingLocale.value) void changeLanguage(next);
}
async function changeLanguage(next: Locale) {
  if (next === editingLocale.value) return;
  if (busy.value || uploading.value) { pendingLocale = next; return; }
  if (dirty.value && !await confirmAction(i18n.t('manual.discard'))) return;
  editingLocale.value = next;
  ready.value = false; baseline.value = ''; error.value = ''; notice.value = '';
  await refresh();
}
async function selectLanguage(value: string | number | null) {
  const next = normalizeLocale(String(value ?? ''));
  await changeLanguage(next);
}
watch(i18n.locale, value => { void changeLanguage(normalizeLocale(value)); });

onBeforeRouteLeave(async () => !uploading.value && (!dirty.value || await confirmAction(i18n.t('manual.discard'))));
onMounted(() => { void refresh(); });
</script>
<template>
  <PageHeader :title="i18n.t('manual.manage')">
    <AppSelect id="manual-language" :model-value="editingLocale" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" class="!w-auto" :aria-label="i18n.t('admin.localized')" :disabled="busy || uploading" @change="selectLanguage" />
    <AppButton class="btn-primary" :disabled="busy || !ready" @click="create"><AppIcon name="add" />{{ i18n.t('manual.add') }}</AppButton>
    <router-link v-if="!newPage" :to="{ path: `/manual${slug ? `/${slug}` : ''}`, query: { lang: editingLocale } }" class="btn"><AppIcon name="open_in_new" />{{ i18n.t('manual.read') }}</router-link>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}<AppButton class="btn-sm ml-2" :disabled="busy" @click="refresh">{{ i18n.t('common.retry') }}</AppButton></p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <section class="panel space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0 w-full sm:w-80"><label for="manual-document" class="block text-sm font-medium mb-1">{{ i18n.t('manual.document') }}</label><AppSelect id="manual-document" :model-value="newPage ? '__new__' : slug" :disabled="busy" :options="[{ value: '__new__', label: i18n.t('manual.new_page'), disabled: true }, ...editorGroups.flatMap(group => group.pages.map(page => ({ value: page.slug, label: `${group.title} · ${page.title}` })))]" @change="select" /></div>
      <span class="text-xs text-muted">{{ i18n.t(dirty ? 'manual.unsaved' : newPage ? 'manual.new_page' : customized ? 'manual.customized' : 'manual.builtin') }}</span>
    </div>
    <AppSkeleton v-if="busy && !ready" :count="3" />
    <template v-else-if="ready">
      <div class="grid gap-4 md:grid-cols-2"><div><label for="manual-title" class="block text-sm font-medium mb-1">{{ i18n.t('manual.document_title') }}</label><AppInput id="manual-title" v-model="title" maxlength="120" :disabled="busy" /></div><div><label for="manual-description" class="block text-sm font-medium mb-1">{{ i18n.t('manual.description') }}</label><AppInput id="manual-description" v-model="description" maxlength="500" :disabled="busy" /></div></div>
      <div class="grid gap-4 md:grid-cols-2"><div><label for="manual-group" class="block text-sm font-medium mb-1">{{ i18n.t('manual.group') }}</label><AppInput id="manual-group" v-model="group" maxlength="80" :disabled="busy" /></div><div v-if="newPage"><label for="manual-slug" class="block text-sm font-medium mb-1">{{ i18n.t('manual.slug') }}</label><AppInput id="manual-slug" v-model="draftSlug" maxlength="80" :disabled="busy" :aria-invalid="!!draftSlug && !slugValid" /><p class="text-xs mt-1" :class="slugValid ? 'text-muted' : 'text-danger'">{{ i18n.t('manual.slug_hint') }}</p></div><p v-else class="text-xs text-muted self-center break-all">/manual{{ slug ? `/${slug}` : '' }}</p></div>
      <div class="flex flex-wrap items-center justify-between gap-3"><label for="manual-content" class="text-sm font-medium">{{ i18n.t('manual.content') }}</label><div class="flex flex-wrap gap-2"><AppButton class="btn-sm" :disabled="busy || uploading" @click="assetsOpen = true"><AppIcon name="perm_media" />{{ i18n.t('manual.assets') }}</AppButton><AppButton class="btn-sm" :loading="uploading" :disabled="busy" @click="assetLibrary?.pick()"><AppIcon name="upload" />{{ i18n.t('manual.upload_insert') }}</AppButton><div class="filter-tabs"><AppButton v-for="tab in (['edit', 'preview', 'split'] as const)" :key="tab" class="btn-sm" :aria-pressed="mode === tab" :class="{ selected: mode === tab }" @click="mode = tab">{{ i18n.t(`manual.${tab}`) }}</AppButton></div></div></div>
      <p class="text-xs text-muted">{{ i18n.t('manual.drop_hint') }}</p>
      <div class="manual-editor-grid" :class="{ split: mode === 'split', dragging }" @dragover="dragover" @dragleave="dragging = false" @drop="drop">
        <textarea v-if="mode !== 'preview'" id="manual-content" ref="sourceInput" v-model="content" class="input manual-source" :class="{ dragging }" :aria-label="i18n.t('manual.content')" :disabled="busy || uploading" maxlength="200000" spellcheck="false" @paste="paste" @dragover="dragover" @dragleave="dragging = false" @drop="drop" />
        <section v-if="mode !== 'edit'" class="manual-preview" :aria-label="i18n.t('manual.preview')"><h1>{{ title }}</h1><p class="text-muted text-sm mb-6">{{ description }}</p><ManualMarkdown :content="preview" :interactive-images="false" /></section>
      </div>
      <p class="text-xs text-muted leading-6">{{ i18n.t('manual.variables') }} <code v-text="'{{site_url}}'" /> → {{ manual.siteUrl.value }} · <code v-text="'{{site_name}}'" /> → {{ site.get('site_name') }}。{{ i18n.t('manual.origin_alias') }}</p>
      <div class="flex flex-wrap justify-between items-center gap-3 border-t border-line pt-4"><AppButton v-if="!newPage" :disabled="busy || uploading || (!customized && !dirty)" @click="reset">{{ i18n.t(builtin ? 'manual.reset' : 'manual.delete') }}</AppButton><span v-else /><AppButton class="btn-primary" :loading="busy" :disabled="uploading || !dirty || !title.trim() || !group.trim() || !slugValid" @click="save"><AppIcon name="save" />{{ i18n.t('manual.save') }}</AppButton></div>
    </template>
  </section>
  <ManualAssets ref="assetLibrary" v-model="assetsOpen" :draft="content" @insert="insertAsset" @busy="resourceBusy" @error="error = $event" />
</template>
<style scoped>
.manual-editor-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.manual-source { min-height: 560px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; line-height: 1.8; tab-size: 2; }
.manual-source.dragging { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand); }
.manual-preview { min-width: 0; min-height: 560px; padding: 24px; border: 1px solid var(--v0-border); border-radius: 8px; overflow-wrap: anywhere; }
.manual-preview h1 { font-size: 26px; font-weight: 650; line-height: 1.5; margin-bottom: 12px; }
@media (min-width: 1100px) { .manual-editor-grid.split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
@media (max-width: 767px) { .manual-source, .manual-preview { min-height: 360px; } .manual-preview { padding: 16px; } }
</style>
