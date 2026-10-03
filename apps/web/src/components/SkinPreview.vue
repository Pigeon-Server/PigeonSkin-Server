<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { renderPreviewFromUrl, renderCapeFromUrl } from '@/lib/iso-preview';
import { useI18n } from '@/stores/i18n';
import { cachedTexturePreview, cacheTexturePreview } from '@/lib/texture-preview-cache';
const props = withDefaults(
  defineProps<{ skinUrl: string; slim?: boolean | undefined; cape?: boolean; alt?: string }>(),
  { slim: false, cape: false, alt: '' },
);
const i18n = useI18n();
const imgUrl = ref<string | null>(null);
const failed = ref(false);
const visible = ref(false);
const target = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let generation = 0;
watch(
  () => [props.skinUrl, props.slim, props.cape, visible.value],
  async () => {
    const id = ++generation;
    imgUrl.value = null;
    failed.value = false;
    if (!visible.value) return;
    const key = JSON.stringify([props.skinUrl, props.slim, props.cape]);
    const cached = cachedTexturePreview(key);
    if (cached) { imgUrl.value = cached; return; }
    try {
      const result = props.cape
        ? await renderCapeFromUrl(props.skinUrl, 240)
        : (await renderPreviewFromUrl(props.skinUrl, props.slim))?.toDataURL('image/png');
      if (id === generation) {
        imgUrl.value = result || null;
        failed.value = !result;
        if (result) cacheTexturePreview(key, result);
      }
    } catch {
      if (id === generation) failed.value = true;
    }
  },
  { immediate: true },
);
onMounted(() => {
  if (!('IntersectionObserver' in window) || !target.value) { visible.value = true; return; }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer?.disconnect(); }
  }, { rootMargin: '240px' });
  observer.observe(target.value);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); });
</script>
<template>
  <img v-if="imgUrl && !failed" ref="target" :src="imgUrl" :alt="alt" loading="lazy" @error="failed = true" />
  <span v-else-if="failed" class="flex h-full w-full items-center justify-center text-muted">
    <AppIcon name="broken_image" />
  </span>
  <div v-else ref="target" class="skeleton h-full w-full" role="status" :aria-label="i18n.t('common.loading')" />
</template>
