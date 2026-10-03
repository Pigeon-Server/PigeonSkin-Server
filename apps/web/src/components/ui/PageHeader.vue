<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template><header class="page-header"><div><h1>{{ title }}</h1><p v-if="description" class="mt-2 text-muted">{{ description }}</p></div><div class="flex flex-wrap items-center gap-2"><slot /></div></header></template>
