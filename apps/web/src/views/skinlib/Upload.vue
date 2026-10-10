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

const canSubmit = computed(() => Boolean(file.value && name.value.trim() && !busy.value));
const cost = computed(() => {
  const sizeKb = Math.ceil((file.value?.size || 0) / 1024);
  const rateKey = visibility.value === 'public' ? 'score_per_kb_public' : 'score_per_kb_private';
  return sizeKb * (Number(site.get(rateKey)) || 0);
});

async function acceptFile(selected: File) {
  if (busy.value) return;
  error.value = '';
  duplicateTextureId.value = null;

  const maxKb = Number(site.get('max_upload_size_kb')) || 1024;
  if (selected.size > maxKb * 1024) {
    error.value = i18n.t('texture.file_too_large');
    return;
  }

  const bytes = new Uint8Array(await selected.slice(0, 8).arrayBuffer());
  const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (!isPng) {
    error.value = i18n.t('texture.not_png');
    return;
  }

  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  file.value = selected;
  objectUrl.value = URL.createObjectURL(selected);
  if (!name.value.trim()) {
    name.value = selected.name.replace(/\.png$/i, '');
  }
}

function handleFileInputChange(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (selected) void acceptFile(selected);
}

function handleDrop(event: DragEvent) {
  dragging.value = false;
  const selected = event.dataTransfer?.files[0];
  if (selected) void acceptFile(selected);
}

function handleClearFile() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  file.value = null;
  objectUrl.value = null;
  error.value = '';
  duplicateTextureId.value = null;
}

async function submit() {
  if (!file.value || !canSubmit.value || busy.value) return;
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
      duplicateTextureId.value =
        e.code === 'texture.duplicate' && Number.isSafeInteger(existingId) && existingId > 0
          ? existingId
          : null;
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

    sessionStorage.setItem(
      'editor-draft',
      JSON.stringify({
        dataUrl,
        kind: kind.value,
        model: model.value,
        name: name.value,
        description: description.value,
        visibility: visibility.value,
        origin: origin.value,
        sourceResourceId: sourceResourceId.value,
      }),
    );
    await router.push(`/editor/${kind.value}?draft=1&model=${model.value}`);
  } catch {
    error.value = i18n.t('common.internal_error');
  } finally {
    busy.value = false;
  }
}

function restoreDraft(result: {
  dataUrl?: string;
  kind?: 'skin' | 'cape';
  model?: 'default' | 'slim';
  name?: string;
  description?: string;
  visibility?: 'public' | 'private';
  origin?: 'original' | 'repost';
  sourceResourceId?: number | null;
}) {
  if (!result.dataUrl) return;
  kind.value = result.kind === 'cape' ? 'cape' : 'skin';
  model.value = result.model === 'slim' ? 'slim' : 'default';
  name.value = result.name || '';
  description.value = result.description || '';
  visibility.value = result.visibility === 'private' ? 'private' : 'public';
  origin.value = result.origin === 'repost' ? 'repost' : 'original';
  sourceResourceId.value = result.sourceResourceId ?? null;

  const [meta, encoded] = result.dataUrl.split(',');
  const bytes = Uint8Array.from(atob(encoded || ''), (char) => char.charCodeAt(0));
  void acceptFile(
    new File([bytes], `${name.value || kind.value}.png`, {
      type: meta?.match(/:(.*?);/)?.[1] || 'image/png',
    }),
  ).then(() => {
    name.value = result.name || name.value;
  });
}

onMounted(() => {
  void site.fetch();
  if (route.query.editor === '1' || route.query.restore === '1') {
    try {
      const storageKey = route.query.editor === '1' ? 'editor-result' : 'editor-draft';
      let result = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as
        | ({
            dataUrl?: string;
            kind?: 'skin' | 'cape';
            model?: 'default' | 'slim';
            name?: string;
            description?: string;
            visibility?: 'public' | 'private';
            origin?: 'original' | 'repost';
            sourceResourceId?: number | null;
            form?: {
              description?: string;
              visibility?: 'public' | 'private';
              origin?: 'original' | 'repost';
              sourceResourceId?: number | null;
            };
          } | null);

      if (route.query.editor === '1') {
        sessionStorage.removeItem('editor-result');
        sessionStorage.removeItem('editor-draft');
      }

      if (result?.form) {
        result = {
          ...result,
          ...(result.form.description !== undefined ? { description: result.form.description } : {}),
          ...(result.form.visibility !== undefined ? { visibility: result.form.visibility } : {}),
          ...(result.form.origin !== undefined ? { origin: result.form.origin } : {}),
          ...(result.form.sourceResourceId !== undefined
            ? { sourceResourceId: result.form.sourceResourceId }
            : {}),
        };
      }
      if (result) restoreDraft(result);
    } catch {
      sessionStorage.removeItem('editor-result');
    }
  }
});

onBeforeUnmount(() => {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});
</script>

<template>
  <div class="page">
    <PageHeader :title="i18n.t('skinlib.upload.title')">
      <template #breadcrumb>
        <nav class="page-breadcrumb">
          <router-link to="/skinlib" class="page-back">
            <AppIcon name="arrow_back" class="!text-sm" />
            <span>{{ i18n.t('general.skinlib') }}</span>
          </router-link>
        </nav>
      </template>
    </PageHeader>

    <!-- 主展示网格 -->
    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,1fr)]">
      <!-- 左侧：贴图选择与实时 3D 检验 -->
      <section class="space-y-5 min-w-0">
        <!-- 未选择文件时的拖放选择框 -->
        <div
          v-if="!file"
          class="rounded-xl border-2 border-dashed border-line bg-surface p-8 text-center transition-colors cursor-pointer hover:border-brand-500"
          :class="dragging ? 'border-brand-500 bg-brand-500/5' : ''"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="handleDrop"
        >
          <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 mb-4">
            <AppIcon name="cloud_upload" class="!text-3xl" />
          </div>
          <h2 class="text-base font-semibold text-ink">
            {{ i18n.t('skinlib.upload.select-file') }}
          </h2>
          <p class="mt-1 text-xs text-muted">
            {{ i18n.t('skinlib.upload_limits', { size: i18n.n(Number(site.get('max_upload_size_kb')) || 1024), width: i18n.n(Number(site.get('max_texture_width')) || 8192) }) }}
          </p>
          <p class="mt-3 text-xs text-muted/70">
            {{ i18n.t('skinlib.upload.name-rule') }}
          </p>
        </div>

        <!-- 已选择文件时的文件信息卡片 -->
        <div
          v-else
          class="flex items-center justify-between rounded-xl border border-line bg-surface p-4 shadow-sm"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600">
              <AppIcon name="image" class="!text-xl" />
            </div>
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-ink" :title="file.name">
                {{ file.name }}
              </p>
              <p class="text-xs text-muted">
                {{ i18n.t('common.size_kb', { size: i18n.n(Math.round((file.size / 1024) * 10) / 10) }) }} · PNG
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <AppButton class="btn-sm" :disabled="busy" @click="fileInput?.click()">
              <AppIcon name="cached" class="!text-xs" />
              <span>{{ i18n.t('common.retry') }}</span>
            </AppButton>
            <AppButton class="btn-icon !h-8 !w-8 text-muted hover:text-danger" :disabled="busy" @click="handleClearFile">
              <AppIcon name="close" class="!text-sm" />
            </AppButton>
          </div>
        </div>

        <!-- 隐藏的真实文件输入框 -->
        <input
          ref="fileInput"
          type="file"
          accept="image/png"
          class="hidden"
          :disabled="busy"
          @change="handleFileInputChange"
        />

        <!-- 材质 3D / 2D 预览与校验卡片 -->
        <div class="panel !p-0 overflow-hidden shadow-sm">
          <div class="bg-surface-2">
            <TexturePreviewer
              v-if="objectUrl"
              :skin-url="kind === 'skin' ? objectUrl : null"
              :cape-url="kind === 'cape' ? objectUrl : null"
              :slim="model === 'slim'"
              :height="440"
              :name="name"
            />
            <div
              v-else
              class="h-[360px] flex flex-col items-center justify-center text-muted"
            >
              <AppIcon name="texture" class="!text-6xl opacity-30 mb-2" />
              <p class="text-xs text-muted">{{ i18n.t('skinlib.upload.select-file') }}</p>
            </div>
          </div>

          <!-- 贴图就绪时的快捷辅助工具栏 -->
          <div
            v-if="file"
            class="flex items-center justify-between border-t border-line/60 bg-surface px-4 py-3"
          >
            <span class="text-xs text-muted">{{ i18n.t('general.previews') }}</span>
            <AppButton class="btn-sm" :disabled="busy" @click="openEditor">
              <AppIcon name="brush" class="!text-sm text-brand-600" />
              <span>{{ i18n.t('skinlib.upload.edit-in-editor') }}</span>
            </AppButton>
          </div>
        </div>

        <!-- 站点内容规范 -->
        <section v-if="site.get('content_policy')" class="rounded-xl border border-line bg-surface p-5 shadow-sm">
          <div class="flex items-center gap-2 mb-3 pb-2 border-b border-line/60">
            <AppIcon name="policy" class="text-brand-600" />
            <h2 class="font-semibold text-sm">{{ i18n.t('skinlib.content_policy') }}</h2>
          </div>
          <MarkdownContent :content="site.get('content_policy')" class="prose max-w-none text-xs" />
        </section>
      </section>

      <!-- 右侧：材质发布表单 -->
      <AppForm class="rounded-xl border border-line bg-surface p-6 shadow-sm self-start" @submit.prevent="submit">
        <fieldset :disabled="busy" class="min-w-0 space-y-4">
          <!-- 材质名称 -->
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-ink" for="upload-name">
              {{ i18n.t('skinlib.upload.texture-name') }}
              <span class="text-danger">*</span>
            </label>
            <AppInput
              id="upload-name"
              v-model="name"
              required
              maxlength="50"
              :placeholder="i18n.t('skinlib.upload.texture-name')"
              class="w-full"
            />
          </div>

          <!-- 材质类型 -->
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-ink">
              {{ i18n.t('skinlib.texture_type') }}
            </label>
            <div class="grid grid-cols-2 gap-2">
              <AppButton
                type="button"
                class="btn justify-center !py-2.5 !text-xs font-medium"
                :class="kind === 'skin' ? '!border-brand-500 !bg-brand-500/10 !text-brand-600' : ''"
                @click="kind = 'skin'"
              >
                <AppIcon name="accessibility_new" class="!text-base" />
                <span>{{ i18n.t('general.skin') }}</span>
              </AppButton>
              <AppButton
                type="button"
                class="btn justify-center !py-2.5 !text-xs font-medium"
                :class="kind === 'cape' ? '!border-brand-500 !bg-brand-500/10 !text-brand-600' : ''"
                @click="kind = 'cape'"
              >
                <AppIcon name="dry_cleaning" class="!text-base" />
                <span>{{ i18n.t('general.cape') }}</span>
              </AppButton>
            </div>
          </div>

          <!-- 适用模型（仅皮肤时露出） -->
          <div v-if="kind === 'skin'">
            <label class="mb-1.5 block text-xs font-semibold text-ink">
              {{ i18n.t('skinlib.show.model') }}
            </label>
            <div class="grid grid-cols-2 gap-2">
              <AppButton
                type="button"
                class="btn justify-center !py-2.5 !text-xs font-medium"
                :class="model === 'default' ? '!border-brand-500 !bg-brand-500/10 !text-brand-600' : ''"
                @click="model = 'default'"
              >
                <span>{{ i18n.t('skinlib.model_classic') }} (4px)</span>
              </AppButton>
              <AppButton
                type="button"
                class="btn justify-center !py-2.5 !text-xs font-medium"
                :class="model === 'slim' ? '!border-brand-500 !bg-brand-500/10 !text-brand-600' : ''"
                @click="model = 'slim'"
              >
                <span>{{ i18n.t('skinlib.model_slim') }} (3px)</span>
              </AppButton>
            </div>
          </div>

          <!-- 公开范围与私密说明 -->
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-ink" for="upload-visibility">
              {{ i18n.t('common.visibility') }}
            </label>
            <AppSelect
              id="upload-visibility"
              v-model="visibility"
              :options="[
                { value: 'public', label: i18n.t('general.public') },
                { value: 'private', label: i18n.t('general.private') },
              ]"
            />
            <p v-if="visibility === 'private'" class="mt-1.5 text-xs text-muted">
              {{ i18n.t('skinlib.upload.privacy-notice') }}
            </p>
          </div>

          <!-- 材质来源 -->
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-ink" for="upload-origin">
              {{ i18n.t('skinlib.origin') }}
            </label>
            <AppSelect
              id="upload-origin"
              v-model="origin"
              :options="[
                { value: 'original', label: i18n.t('skinlib.origin_original') },
                { value: 'repost', label: i18n.t('skinlib.origin_repost') },
              ]"
            />
          </div>

          <!-- 材质描述 -->
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-ink">
              {{ i18n.t('skinlib.description') }}
            </label>
            <MarkdownEditor
              v-model="description"
              :label="i18n.t('skinlib.description')"
              :limit="descriptionLimit"
              :disabled="busy"
            />
          </div>

          <!-- 费用预估 -->
          <div class="border-t border-line/60 pt-3 text-xs text-muted">
            <p>{{ i18n.t('skinlib.upload_cost', { score: i18n.n(cost) }) }}</p>
          </div>

          <!-- 错误与重复材质提醒 -->
          <div v-if="error" class="alert alert-danger text-xs" role="alert">
            <span>{{ error }}</span>
            <router-link
              v-if="duplicateTextureId"
              :to="`/skinlib/${duplicateTextureId}`"
              class="ml-1 font-semibold underline underline-offset-2"
            >
              {{ i18n.t('user.viewInSkinlib') }}
            </router-link>
          </div>

          <!-- 提交按钮 -->
          <AppButton
            class="btn-primary w-full !py-2.5 !text-sm font-semibold justify-center"
            type="submit"
            :disabled="!canSubmit"
            :loading="busy"
          >
            <AppIcon name="cloud_upload" class="!text-lg" />
            <span>{{ i18n.t('skinlib.upload.button') }}</span>
          </AppButton>
        </fieldset>
      </AppForm>
    </div>
  </div>
</template>
