<script setup lang="ts">
import AccountSecurity from '@/components/AccountSecurity.vue';
import { useI18n } from '@/stores/i18n';

const i18n = useI18n();
</script>
<template>
  <div class="page">
    <PageHeader :title="i18n.t('security.title')" />
    <AccountSecurity :heading="false" />
  </div>
</template>
