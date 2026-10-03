<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@/stores/i18n';
import SkinPreview from '@/components/SkinPreview.vue';
import { defaultSkinUrls } from '@pigeon-skin/shared/default-skins';

const router = useRouter();
const i18n = useI18n();

const kind = ref<'skin' | 'cape'>('skin');
const model = ref<'default' | 'slim'>('default');
const name = ref('');

const capeTextureUrl = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" shape-rendering="crispEdges"><rect width="64" height="32" fill="#312f53"/><rect x="1" y="1" width="10" height="16" fill="#7651a8"/><rect x="1" y="1" width="10" height="2" fill="#a87be0"/><rect x="1" y="1" width="2" height="16" fill="#9c72d0"/><rect x="9" y="1" width="2" height="16" fill="#523677"/><rect x="1" y="15" width="10" height="2" fill="#4e397b"/><rect x="3" y="4" width="6" height="2" fill="#d9b7ff"/><rect x="4" y="6" width="4" height="2" fill="#d9b7ff"/><rect x="5" y="8" width="2" height="2" fill="#d9b7ff"/><rect x="3" y="10" width="2" height="2" fill="#d9b7ff"/><rect x="7" y="10" width="2" height="2" fill="#d9b7ff"/><rect x="4" y="12" width="4" height="2" fill="#d9b7ff"/></svg>`,
)}`;

const editorUrl = computed(() => ({
  path: `/editor/${kind.value}`,
  query: {
    blank: '1',
    model: model.value,
    ...(name.value.trim() ? { name: name.value.trim() } : {}),
  },
}));

function handleStartCreate() {
  void router.push(editorUrl.value);
}
</script>

<template>
  <div class="resource-page">
    <!-- 面包屑与顶部导航 -->
    <nav class="flex items-center gap-2 text-sm pb-4" :aria-label="i18n.t('skinlib.create.title')">
      <router-link
        to="/skinlib"
        class="flex items-center gap-1 font-medium text-muted hover:text-brand-600"
      >
        <AppIcon name="arrow_back" class="!text-base" />
        <span>{{ i18n.t('general.skinlib') }}</span>
      </router-link>
      <span class="text-muted/60">/</span>
      <span class="font-semibold text-ink">{{ i18n.t('skinlib.create.title') }}</span>
    </nav>

    <!-- 主展示区 -->
    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] max-w-[1160px] mx-auto">
      <!-- 左侧：基础模板展示台 -->
      <section class="rounded-xl border border-line bg-surface p-6 shadow-sm flex flex-col items-center">
        <!-- 模板标题与规格徽章 -->
        <div class="w-full flex items-center justify-between pb-4 border-b border-line/60">
          <div>
            <h2 class="text-sm font-semibold text-ink">
              {{
                kind === 'cape'
                  ? i18n.t('general.cape')
                  : model === 'slim'
                    ? i18n.t('skinlib.model_slim')
                    : i18n.t('skinlib.model_classic')
              }}
            </h2>
            <p class="text-xs text-muted">
              {{
                kind === 'cape'
                  ? '64 × 32 PNG'
                  : model === 'slim'
                    ? '64 × 64 · 3px Arm'
                    : '64 × 64 · 4px Arm'
              }}
            </p>
          </div>
          <span class="badge !bg-brand-500/15 !text-brand-600 font-medium">
            {{ kind === 'cape' ? i18n.t('general.cape') : i18n.t('general.skin') }}
          </span>
        </div>

        <!-- 模板立绘展示区域 -->
        <div class="create-preview-canvas w-full my-6 flex items-center justify-center rounded-lg bg-surface-2 p-6">
          <SkinPreview
            class="max-h-[360px] w-auto object-contain filter drop-shadow-md"
            :skin-url="kind === 'cape' ? capeTextureUrl : model === 'slim' ? defaultSkinUrls.alex : defaultSkinUrls.steve"
            :slim="model === 'slim'"
            :cape="kind === 'cape'"
            :alt="i18n.t('skinlib.preview_label')"
          />
        </div>

        <!-- 规格特征提示说明 -->
        <div class="w-full rounded-lg bg-surface-2/60 p-3.5 text-xs text-muted space-y-1">
          <p class="font-medium text-ink">
            {{
              kind === 'cape'
                ? i18n.t('general.cape')
                : model === 'slim'
                  ? `${i18n.t('skinlib.model_slim')} (Alex)`
                  : `${i18n.t('skinlib.model_classic')} (Steve)`
            }}
          </p>
          <p v-if="kind === 'skin'">
            {{
              model === 'slim'
                ? '手臂宽度为 3 像素，适合纤细身形。'
                : '手臂宽度为 4 像素，适合标准经典身形。'
            }}
          </p>
          <p v-else>
            标准 Minecraft 披风格式，双面 UV 贴图展开。
          </p>
        </div>
      </section>

      <!-- 右侧：创作配置卡片 -->
      <AppForm class="rounded-xl border border-line bg-surface p-6 shadow-sm space-y-5" @submit="handleStartCreate">
        <div>
          <h1 class="text-lg font-bold text-ink">{{ i18n.t('skinlib.create.title') }}</h1>
          <p class="mt-1 text-xs text-muted">{{ i18n.t('skinlib.create.description') }}</p>
        </div>

        <!-- 材质预设名称 -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-ink" for="create-name">
            {{ i18n.t('skinlib.upload.texture-name') }}
          </label>
          <AppInput
            id="create-name"
            v-model="name"
            maxlength="50"
            :placeholder="i18n.t('skinlib.upload.texture-name')"
            class="w-full"
          />
        </div>

        <!-- 材质类型选择 -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-ink">
            {{ i18n.t('skinlib.texture_type') }}
          </label>
          <div class="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              class="flex items-center gap-3 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand-500"
              :class="kind === 'skin' ? '!border-brand-500 !bg-brand-500/10' : 'bg-surface'"
              @click="kind = 'skin'"
            >
              <div
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                :class="kind === 'skin' ? 'bg-brand-500 text-white' : 'bg-surface-2 text-muted'"
              >
                <AppIcon name="accessibility_new" class="!text-xl" />
              </div>
              <div class="min-w-0">
                <p class="text-xs font-semibold text-ink">{{ i18n.t('general.skin') }}</p>
                <p class="text-[11px] text-muted">Steve / Alex</p>
              </div>
            </button>

            <button
              type="button"
              class="flex items-center gap-3 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand-500"
              :class="kind === 'cape' ? '!border-brand-500 !bg-brand-500/10' : 'bg-surface'"
              @click="kind = 'cape'"
            >
              <div
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                :class="kind === 'cape' ? 'bg-brand-500 text-white' : 'bg-surface-2 text-muted'"
              >
                <AppIcon name="dry_cleaning" class="!text-xl" />
              </div>
              <div class="min-w-0">
                <p class="text-xs font-semibold text-ink">{{ i18n.t('general.cape') }}</p>
                <p class="text-[11px] text-muted">Minecraft Cape</p>
              </div>
            </button>
          </div>
        </div>

        <!-- 适用模型（仅皮肤时显示） -->
        <div v-if="kind === 'skin'">
          <label class="mb-1.5 block text-xs font-semibold text-ink">
            {{ i18n.t('skinlib.show.model') }}
          </label>
          <div class="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              class="flex items-center gap-2.5 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand-500"
              :class="model === 'default' ? '!border-brand-500 !bg-brand-500/10' : 'bg-surface'"
              @click="model = 'default'"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-bold"
                :class="model === 'default' ? 'bg-brand-500 text-white' : 'bg-surface-2 text-muted'"
              >
                4px
              </div>
              <div class="min-w-0">
                <p class="text-xs font-semibold text-ink">{{ i18n.t('skinlib.model_classic') }}</p>
                <p class="text-[11px] text-muted">Steve</p>
              </div>
            </button>

            <button
              type="button"
              class="flex items-center gap-2.5 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand-500"
              :class="model === 'slim' ? '!border-brand-500 !bg-brand-500/10' : 'bg-surface'"
              @click="model = 'slim'"
            >
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-bold"
                :class="model === 'slim' ? 'bg-brand-500 text-white' : 'bg-surface-2 text-muted'"
              >
                3px
              </div>
              <div class="min-w-0">
                <p class="text-xs font-semibold text-ink">{{ i18n.t('skinlib.model_slim') }}</p>
                <p class="text-[11px] text-muted">Alex</p>
              </div>
            </button>
          </div>
        </div>

        <!-- 开始创作按钮 -->
        <div class="pt-3 border-t border-line/60">
          <AppButton class="btn-primary w-full !py-2.5 !text-sm font-semibold justify-center" type="submit">
            <AppIcon name="brush" class="!text-lg" />
            <span>{{ i18n.t('skinlib.create.start') }}</span>
          </AppButton>
        </div>
      </AppForm>
    </div>
  </div>
</template>

<style scoped>
.create-preview-canvas {
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--v0-border) 40%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--v0-border) 40%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 40%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--v0-border) 40%, transparent) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
