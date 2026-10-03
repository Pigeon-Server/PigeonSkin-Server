<script setup lang="ts">
defineProps<{ title: string; icon?: string }>();
</script>
<template><div class="empty-state"><AppIcon :name="icon || 'inventory_2'" /><h2>{{ title }}</h2><div class="mt-4"><slot /></div></div></template>
