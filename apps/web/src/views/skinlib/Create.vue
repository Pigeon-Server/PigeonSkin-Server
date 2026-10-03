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
const capeTextureUrl = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" shape-rendering="crispEdges"><rect width="64" height="32" fill="#312f53"/><rect x="1" y="1" width="10" height="16" fill="#7651a8"/><rect x="1" y="1" width="10" height="2" fill="#a87be0"/><rect x="1" y="1" width="2" height="16" fill="#9c72d0"/><rect x="9" y="1" width="2" height="16" fill="#523677"/><rect x="1" y="15" width="10" height="2" fill="#4e397b"/><rect x="3" y="4" width="6" height="2" fill="#d9b7ff"/><rect x="4" y="6" width="4" height="2" fill="#d9b7ff"/><rect x="5" y="8" width="2" height="2" fill="#d9b7ff"/><rect x="3" y="10" width="2" height="2" fill="#d9b7ff"/><rect x="7" y="10" width="2" height="2" fill="#d9b7ff"/><rect x="4" y="12" width="4" height="2" fill="#d9b7ff"/></svg>`)}`;
const editorUrl = computed(() => ({
  path: `/editor/${kind.value}`,
  query: { blank: '1', model: model.value, ...(name.value.trim() ? { name: name.value.trim() } : {}) },
}));
</script>

<template>
  <PageHeader :title="i18n.t('skinlib.create.title')">
    <router-link to="/skinlib" class="btn">
      <AppIcon name="arrow_back" />
      {{ i18n.t('general.back') }}
    </router-link>
  </PageHeader>

  <AppForm class="create-workspace" @submit.prevent="router.push(editorUrl)">
    <section class="create-showcase">
      <div class="create-preview-stage" :class="{ 'is-cape': kind === 'cape' }">
        <SkinPreview
          class="create-texture-preview"
          :skin-url="kind === 'cape' ? capeTextureUrl : model === 'slim' ? defaultSkinUrls.alex : defaultSkinUrls.steve"
          :slim="model === 'slim'"
          :cape="kind === 'cape'"
          :alt="i18n.t('skinlib.preview_label')"
        />
      </div>
    </section>

    <section class="create-config panel">
      <div class="create-fieldset">
        <label for="create-name">{{ i18n.t('skinlib.upload.texture-name') }}</label>
        <AppInput id="create-name" v-model="name" maxlength="50" :placeholder="i18n.t('skinlib.upload.texture-name')" />
      </div>

      <fieldset class="create-fieldset">
        <legend>{{ i18n.t('skinlib.texture_type') }}</legend>
        <AppRadioGroup v-model="kind" class="create-choice-grid create-choice-grid--types" :options="[{ value: 'skin', label: i18n.t('general.skin') }, { value: 'cape', label: i18n.t('general.cape') }]" />
      </fieldset>

      <fieldset v-if="kind === 'skin'" class="create-fieldset">
        <legend>{{ i18n.t('skinlib.show.model') }}</legend>
        <AppRadioGroup v-model="model" class="create-choice-grid create-choice-grid--models" :options="[{ value: 'default', label: i18n.t('skinlib.model_classic') }, { value: 'slim', label: i18n.t('skinlib.model_slim') }]" />
      </fieldset>

      <AppButton class="btn-primary create-submit" type="submit">
        <AppIcon name="brush" />
        {{ i18n.t('skinlib.create.start') }}
      </AppButton>
    </section>
  </AppForm>
</template>

<style scoped>
.create-workspace { display: grid; grid-template-columns: minmax(280px, .82fr) minmax(420px, 1.18fr); gap: 24px; align-items: start; max-width: 1040px; margin: 0 auto; }
.create-showcase { position: relative; display: flex; min-height: 400px; align-items: center; overflow: hidden; border: 1px solid var(--v0-border); border-radius: 12px; padding: 20px; color: var(--ink); background: linear-gradient(148deg, var(--v0-surface) 0%, var(--v0-surface-2) 100%); box-shadow: 0 12px 28px color-mix(in srgb, var(--ink) 8%, transparent); }
.create-showcase::before, .create-showcase::after { position: absolute; content: ''; pointer-events: none; border: 1px solid color-mix(in srgb, var(--brand-base) 10%, transparent); border-radius: 50%; }
.create-showcase::before { width: 330px; height: 330px; right: -120px; top: -130px; }
.create-showcase::after { width: 420px; height: 420px; left: -250px; bottom: -270px; }
.create-preview-stage { position: relative; z-index: 1; display: flex; width: 100%; min-height: 350px; align-items: center; justify-content: center; }
.create-texture-preview { display: block; width: 220px; height: 330px; object-fit: contain; image-rendering: pixelated; filter: drop-shadow(0 12px 12px color-mix(in srgb, var(--ink) 18%, transparent)); }
.create-config { display: flex; flex-direction: column; gap: 20px; padding: 24px; }
.create-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.create-fieldset > label, .create-fieldset legend { display: block; margin-bottom: 10px; color: var(--ink); font-size: 14px; font-weight: 600; }
.create-choice-grid { display: grid; gap: 10px; }
.create-choice-grid--types, .create-choice-grid--models { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.create-choice, .create-model-choice { position: relative; display: flex; min-width: 0; cursor: pointer; align-items: center; gap: 10px; border: 1px solid var(--v0-border); border-radius: 8px; padding: 13px; transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease; }
.create-choice:hover, .create-model-choice:hover { border-color: var(--brand-base); }
.create-choice.selected, .create-model-choice.selected { border-color: var(--brand-base); background: var(--brand-soft); box-shadow: 0 0 0 2px rgb(82 106 135 / 10%); }
.create-choice input, .create-model-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.create-choice-icon { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 7px; color: var(--brand); background: var(--v0-surface-2); font-size: 20px; }
.create-choice-text { display: grid; min-width: 0; }
.create-choice-text strong { color: var(--ink); font-size: 13px; }
.create-choice-check { margin-left: auto; color: var(--brand); font-size: 17px; }
.create-model-choice { justify-content: flex-start; color: var(--ink); font-size: 12px; font-weight: 600; }
.create-model-avatar { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border-radius: 6px; color: #fff; background: #607995; font-size: 19px; }
.create-model-avatar--slim { background: #9a789f; }
.create-config .input { width: 100%; }
.create-submit { display: inline-flex; width: 100%; align-items: center; justify-content: center; gap: 9px; }
@media (max-width: 850px) { .create-workspace { grid-template-columns: 1fr; } .create-showcase { min-height: 360px; } .create-preview-stage { min-height: 320px; } }
@media (max-width: 520px) { .create-showcase, .create-config { padding: 20px; } .create-choice-grid--types, .create-choice-grid--models { grid-template-columns: 1fr; } }
</style>
