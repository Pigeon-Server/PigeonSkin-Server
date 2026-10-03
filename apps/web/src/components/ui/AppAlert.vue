<script setup lang="ts">
import { Alert } from '@vuetify/v0';

withDefaults(defineProps<{ variant?: 'info' | 'success' | 'warning' | 'danger'; role?: 'alert' | 'status' }>(), {
  variant: 'info',
  role: 'status',
});
</script>

<template>
  <Alert.Root v-bind="role ? { role } : {}" class="app-alert" :class="`app-alert-${variant}`">
    <slot />
  </Alert.Root>
</template>
