<script setup lang="ts">
import { useI18n } from '@/stores/i18n';
const i18n = useI18n();
import { useManualStore } from '@/stores/manual';
const manual = useManualStore();
defineProps<{ activeSlug: string }>();
defineEmits<{ navigate: [] }>();
</script>
<template>
  <nav :aria-label="i18n.t('manual.navigation')" class="manual-navigation">
    <section v-for="group in manual.groups.value" :key="group.title">
      <h2>{{ group.title }}</h2>
      <router-link v-for="item in group.pages" :key="item.slug" :to="`/manual${item.slug ? `/${item.slug}` : ''}`" :aria-current="activeSlug === item.slug ? 'page' : undefined" @click="$emit('navigate')">{{ item.title }}</router-link>
    </section>
  </nav>
</template>
<style scoped>
.manual-navigation { padding: 26px 20px 32px; }
section + section { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--v0-border); }
h2 { font-size: 13px; font-weight: 650; margin: 0 12px 10px; }
a { display: block; padding: 8px 12px; border-radius: 6px; color: var(--v0-muted); font-size: 13px; line-height: 1.5; transition: background-color .18s, color .18s; }
a:hover { color: var(--ink); background: var(--v0-surface); }
a[aria-current] { color: var(--brand); background: var(--v0-surface); font-weight: 650; }
a:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { a { transition: none; } }
</style>
