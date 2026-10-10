<script setup lang="ts">
import { ref } from 'vue';
import ConnectGrants from '@/components/ConnectGrants.vue';
import OAuthClients from '@/components/OAuthClients.vue';
import { useI18n } from '@/stores/i18n';
const i18n = useI18n();
const tab = ref<'grants' | 'clients'>('grants');
</script>
<template>
  <PageHeader :title="i18n.t('oauth.applications')" />
  <div class="flex gap-2">
    <AppButton :class="tab === 'grants' ? 'btn-primary' : ''" :aria-pressed="tab === 'grants'" @click="tab = 'grants'">{{ i18n.t('connect.authorized_apps') }}</AppButton>
    <AppButton :class="tab === 'clients' ? 'btn-primary' : ''" :aria-pressed="tab === 'clients'" @click="tab = 'clients'">{{ i18n.t('oauth.my_apps') }}</AppButton>
  </div>
  <div><ConnectGrants v-if="tab === 'grants'" /><OAuthClients v-else /></div>
</template>
