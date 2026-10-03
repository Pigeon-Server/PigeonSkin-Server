<script setup lang="ts">
import { useI18n } from '@/stores/i18n';

const i18n = useI18n();
const delays = [1.8, 2.1, 2.4, 0.9, 1.2, 1.5, 0, 0.3, 0.6];
</script>

<template>
  <div class="skinlib-loading" role="status" :aria-label="i18n.t('common.loading')">
    <div class="skinlib-loading-grid" aria-hidden="true">
      <div
        v-for="(delay, index) in delays"
        :key="index"
        class="skinlib-loading-square"
        :style="{ animationDelay: `${delay}s` }"
      />
    </div>
  </div>
</template>

<style scoped>
.skinlib-loading {
  min-height: min(60dvh, 560px);
  display: grid;
  place-items: center;
}

.skinlib-loading-grid {
  display: grid;
  grid-template-columns: repeat(3, 15px);
  gap: 5px;
}

.skinlib-loading-square {
  width: 15px;
  height: 15px;
  background: #6610f2;
  opacity: 0;
  transform: translateY(-10px);
  animation: skinlib-loading-enter 6s infinite;
}

.skinlib-loading-square:nth-child(3) {
  background: #fdc96f;
}

@keyframes skinlib-loading-enter {
  0% {
    opacity: 0;
    transform: translateY(-10px);
  }
  5%, 50.9% {
    opacity: 1;
    transform: translateY(0);
  }
  55.9% {
    opacity: 0;
    transform: translateY(10px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .skinlib-loading-square {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
</style>
