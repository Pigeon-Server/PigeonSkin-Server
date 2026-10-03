<script setup lang="ts">
import { useI18n } from '@/stores/i18n';

const i18n = useI18n();
</script>

<template>
  <div class="py-24 text-center">
    <p class="text-6xl font-bold text-brand-500">404</p>
    <p class="mt-3 text-muted">{{ i18n.t('common.not_found') }}</p>
    <router-link to="/" class="btn btn-primary mt-6 inline-block">{{ i18n.t('nav.back_home') }}</router-link>
  </div>
</template>
