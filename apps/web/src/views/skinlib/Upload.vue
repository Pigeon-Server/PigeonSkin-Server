<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, textureApi } from '@/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import { useSessionStore } from '@/stores/session';
import TexturePreviewer from '@/components/TexturePreviewer.vue';
import MarkdownEditor from '@/components/ui/MarkdownEditor.vue';

const router = useRouter();
const route = useRoute();
const i18n = useI18n();
const site = useSiteSettings();
const session = useSessionStore();
const file = ref<File | null>(null);
const objectUrl = ref<string | null>(null);
const name = ref('');
const description = ref('');
const descriptionLimit = computed(() => Number(site.get('textures_description_limit')) || 0);
const kind = ref<'skin' | 'cape'>('skin');
const model = ref<'default' | 'slim'>('default');
const visibility = ref<'public' | 'private'>('public');
const origin = ref<'original' | 'repost'>('original');
const error = ref('');
const duplicateTextureId = ref<number | null>(null);
const busy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const sourceResourceId = ref<number | null>(null);
const canSubmit = computed(() => !!file.value && !!name.value.trim() && !busy.value);
const cost = computed(
  () =>
    Math.ceil((file.value?.size || 0) / 1024) *
    Number(
      site.get(visibility.value === 'public' ? 'score_per_kb_public' : 'score_per_kb_private') || 0,
    ),
);
async function acceptFile(selected: File) {
  if (busy.value) return;
  error.value = '';
  duplicateTextureId.value = null;
  const max = Number(site.get('max_upload_size_kb')) || 1024;
  if (selected.size > max * 1024) {
    error.value = i18n.t('texture.file_too_large');
    return;
  }
  const bytes = new Uint8Array(await selected.slice(0, 8).arrayBuffer());
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v)) {
    error.value = i18n.t('texture.not_png');
    return;
  }
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  file.value = selected;
  objectUrl.value = URL.createObjectURL(selected);
  if (!name.value) name.value = selected.name.replace(/\.png$/i, '');
}
function pickFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (selected) void acceptFile(selected);
}
function drop(event: DragEvent) {
  dragging.value = false;
  const selected = event.dataTransfer?.files[0];
  if (selected) void acceptFile(selected);
}
async function submit() {
  if (!file.value || !canSubmit.value) return;
  busy.value = true;
  error.value = '';
  duplicateTextureId.value = null;
  try {
    const result = await textureApi.upload({
      file: file.value,
      name: name.value.trim(),
      kind: kind.value,
      model: kind.value === 'skin' ? model.value : undefined,
      visibility: visibility.value,
      origin: origin.value,
      description: description.value,
      sourceResourceId: sourceResourceId.value,
    });
    await session.fetchSession();
    await router.push(`/skinlib/${result.id}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
    if (e instanceof ApiError) {
      const existingId = Number(e.fields.existingId);
      duplicateTextureId.value = e.code === 'texture.duplicate' && Number.isSafeInteger(existingId) && existingId > 0 ? existingId : null;
    } else {
      duplicateTextureId.value = null;
    }
  } finally {
    busy.value = false;
  }
}
async function openEditor() {
  if (!file.value || busy.value) return;
  busy.value = true;
  error.value = '';
  duplicateTextureId.value = null;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file.value!);
    });
    sessionStorage.setItem('editor-draft', JSON.stringify({ dataUrl, kind: kind.value, model: model.value, name: name.value, description: description.value, visibility: visibility.value, origin: origin.value, sourceResourceId: sourceResourceId.value }));
    await router.push(`/editor/${kind.value}?draft=1&model=${model.value}`);
  } catch {
    error.value = i18n.t('common.internal_error');
  } finally {
    busy.value = false;
  }
}
function restoreDraft(result: { dataUrl?: string; kind?: 'skin' | 'cape'; model?: 'default' | 'slim'; name?: string; description?: string; visibility?: 'public' | 'private'; origin?: 'original' | 'repost'; sourceResourceId?: number | null }) {
  if (!result.dataUrl) return;
  kind.value = result.kind === 'cape' ? 'cape' : 'skin';
  model.value = result.model === 'slim' ? 'slim' : 'default';
  name.value = result.name || '';
  description.value = result.description || '';
  visibility.value = result.visibility === 'private' ? 'private' : 'public';
  origin.value = result.origin === 'repost' ? 'repost' : 'original';
  sourceResourceId.value = result.sourceResourceId ?? null;
  const [meta, encoded] = result.dataUrl.split(',');
  const bytes = Uint8Array.from(atob(encoded || ''), char => char.charCodeAt(0));
  void acceptFile(new File([bytes], `${name.value || kind.value}.png`, { type: meta?.match(/:(.*?);/)?.[1] || 'image/png' })).then(() => { name.value = result.name || name.value; });
}
onMounted(() => {
  void site.fetch();
  if (route.query.editor === '1' || route.query.restore === '1') {
    try {
      const storageKey = route.query.editor === '1' ? 'editor-result' : 'editor-draft';
      let result = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as ({ dataUrl?: string; kind?: 'skin' | 'cape'; model?: 'default' | 'slim'; name?: string; description?: string; visibility?: 'public' | 'private'; origin?: 'original' | 'repost'; sourceResourceId?: number | null; form?: { description?: string; visibility?: 'public' | 'private'; origin?: 'original' | 'repost'; sourceResourceId?: number | null } } | null);
      if (route.query.editor === '1') {
        sessionStorage.removeItem('editor-result');
        sessionStorage.removeItem('editor-draft');
      }
      if (result?.form) result = {
        ...result,
        ...(result.form.description !== undefined ? { description: result.form.description } : {}),
        ...(result.form.visibility !== undefined ? { visibility: result.form.visibility } : {}),
        ...(result.form.origin !== undefined ? { origin: result.form.origin } : {}),
        ...(result.form.sourceResourceId !== undefined ? { sourceResourceId: result.form.sourceResourceId } : {}),
      };
      if (result) restoreDraft(result);
    } catch { sessionStorage.removeItem('editor-result'); }
  }
});
onBeforeUnmount(() => {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});
</script>

<template>
  <PageHeader :title="i18n.t('skinlib.upload.title')">
    <router-link to="/skinlib" class="btn">
      <AppIcon name="arrow_back" />
      {{ i18n.t('general.back') }}
    </router-link>
  </PageHeader>
  <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
    <section class="space-y-5">
      <div class="panel !p-0 overflow-hidden">
        <div class="bg-surface-2 p-4">
          <TexturePreviewer
            v-if="objectUrl"
            :skin-url="kind === 'skin' ? objectUrl : null"
            :cape-url="kind === 'cape' ? objectUrl : null"
            :slim="model === 'slim'"
            :height="380"
            :name="name"
          />
          <div v-else class="h-[160px] lg:h-[260px] flex items-center justify-center text-muted">
            <AppIcon name="texture" class="!text-6xl opacity-40" />
          </div>
        </div>
        <AppButton
          class="!w-full !rounded-none !border-0 !border-t !border-dashed !flex-col !py-8"
          :class="dragging ? '!bg-brand-50' : ''"
          :disabled="busy"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="drop"
        >
          <AppIcon name="upload_file" class="!text-3xl text-brand-600" />
          <span>{{ file?.name || i18n.t('skinlib.upload.select-file') }}</span>
          <span class="text-xs font-normal text-muted">
            {{ i18n.t('skinlib.upload_limits', { size: i18n.n(Number(site.get('max_upload_size_kb')) || 1024), width: i18n.n(Number(site.get('max_texture_width')) || 8192) }) }}
          </span>
        </AppButton>
        <input
          ref="fileInput"
          type="file"
          accept="image/png"
          class="hidden"
          :disabled="busy"
          @change="pickFile"
        />
        <AppButton v-if="file" class="w-full" :disabled="busy" @click="openEditor">
          <AppIcon name="brush" />
          {{ i18n.t('skinlib.upload.edit-in-editor') }}
        </AppButton>
      </div>
      <section v-if="site.get('content_policy')" class="panel">
        <h2 class="font-semibold mb-3">{{ i18n.t('skinlib.content_policy') }}</h2>
        <MarkdownContent :content="site.get('content_policy')" />
      </section>
    </section>
    <AppForm class="panel self-start" @submit.prevent="submit">
      <fieldset :disabled="busy" class="min-w-0 space-y-5">
        <div>
          <label class="block mb-2 font-medium" for="upload-name">
            {{ i18n.t('skinlib.upload.texture-name') }}
          </label>
          <AppInput id="upload-name" v-model="name" required maxlength="50" />
        </div>
        <div>
          <label class="block mb-2 font-medium" for="upload-kind">
            {{ i18n.t('skinlib.texture_type') }}
          </label>
          <AppSelect id="upload-kind" v-model="kind" :options="[{ value: 'skin', label: i18n.t('general.skin') }, { value: 'cape', label: i18n.t('general.cape') }]" />
        </div>
        <div v-if="kind === 'skin'">
          <label class="block mb-2 font-medium" for="upload-model">
            {{ i18n.t('skinlib.show.model') }}
          </label>
          <AppSelect id="upload-model" v-model="model" :options="[{ value: 'default', label: i18n.t('skinlib.model_classic') }, { value: 'slim', label: i18n.t('skinlib.model_slim') }]" />
        </div>
        <div>
          <label class="block mb-2 font-medium" for="upload-visibility">
            {{ i18n.t('common.visibility') }}
          </label>
          <AppSelect id="upload-visibility" v-model="visibility" :options="[{ value: 'public', label: i18n.t('general.public') }, { value: 'private', label: i18n.t('general.private') }]" />
          <p v-if="visibility === 'private'" class="mt-2 text-xs text-muted">
            {{ i18n.t('skinlib.private_hint') }}
          </p>
        </div>
        <div>
          <label class="block mb-2 font-medium" for="upload-origin">{{ i18n.t('skinlib.origin') }}</label>
          <AppSelect id="upload-origin" v-model="origin" :options="[{ value: 'original', label: i18n.t('skinlib.origin_original') }, { value: 'repost', label: i18n.t('skinlib.origin_repost') }]" />
        </div>
        <MarkdownEditor
          v-model="description"
          :label="i18n.t('skinlib.description')"
          :limit="descriptionLimit"
          :disabled="busy"
        />
        <p class="text-sm text-muted border-t border-line pt-4">
          {{ i18n.t('skinlib.upload_cost', { score: i18n.n(cost) }) }}
        </p>
        <p v-if="error" class="alert alert-danger" role="alert">
          {{ error }}
          <router-link
            v-if="duplicateTextureId"
            :to="`/skinlib/${duplicateTextureId}`"
            class="ml-1 font-medium underline underline-offset-2"
          >{{ i18n.t('user.viewInSkinlib') }}</router-link>
        </p>
        <AppButton class="btn-primary w-full" type="submit" :disabled="!canSubmit" :loading="busy">
          <AppIcon name="cloud_upload" />
          {{ i18n.t('skinlib.upload.button') }}
        </AppButton>
      </fieldset>
    </AppForm>
  </div>
</template>
