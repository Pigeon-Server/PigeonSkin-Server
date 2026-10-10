<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/stores/i18n';
import SkinViewer from '@/components/SkinViewer.vue';
import SkinPreview from '@/components/SkinPreview.vue';
import AppButton from '@/components/ui/AppButton.vue';
const props = withDefaults(defineProps<{ skinUrl?: string | null | undefined; capeUrl?: string | null | undefined; slim?: boolean; height?: number; name?: string }>(), { height: 380, slim: false, name: '' });
const i18n = useI18n();
const mode = ref<'3d' | '2d'>('3d');
const parts = computed(() => props.skinUrl && props.capeUrl || !props.skinUrl && !props.capeUrl ? ['skin', 'cape'] as const : props.skinUrl ? ['skin'] as const : ['cape'] as const);
function source(kind: 'skin' | 'cape') { return kind === 'skin' ? props.skinUrl : props.capeUrl; }
</script>
<template>
  <div class="overflow-hidden bg-surface">
    <div class="border-b border-line px-3 py-2">
      <div class="filter-tabs" :aria-label="i18n.t('general.texturePreview')">
        <AppButton v-for="value in ['3d', '2d'] as const" :key="value" :class="{ selected: mode === value }" :aria-pressed="mode === value" @click="mode = value">{{ i18n.t('skinlib.preview_' + value) }}</AppButton>
      </div>
    </div>
    <SkinViewer v-show="mode === '3d'" :skin-url="skinUrl ?? null" :cape-url="capeUrl ?? null" :slim="slim ?? false" :height="height ?? 380" :name="name ?? ''" :active="mode === '3d'" />
    <div v-if="mode === '2d'" class="flex flex-wrap items-center justify-center gap-4 bg-surface-2 p-4" :style="{ minHeight: height + 'px' }">
      <figure v-for="kind in parts" :key="kind" class="flex min-w-0 flex-1 flex-col items-center gap-3">
        <figcaption v-if="parts.length > 1" class="text-sm font-medium">{{ i18n.t('general.' + kind) }}</figcaption>
        <SkinPreview v-if="source(kind)" :skin-url="source(kind)!" :cape="kind === 'cape'" :slim="slim ?? false" :alt="i18n.t('general.' + kind)" class="max-w-full object-contain" :style="{ maxHeight: (height ?? 380) - 40 + 'px' }" />
        <p v-else class="text-sm text-muted">{{ i18n.t('player.texture_empty') }}</p>
      </figure>
    </div>
  </div>
</template>
