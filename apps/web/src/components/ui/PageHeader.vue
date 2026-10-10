<script setup lang="ts">
defineProps<{ title: string; description?: string; dense?: boolean }>();
</script>
<template>
  <header class="page-header" :class="{ 'page-header--dense': dense }">
    <div class="min-w-0">
      <slot name="breadcrumb" />
      <div class="flex flex-wrap items-baseline gap-3">
        <h1>{{ title }}</h1>
        <slot name="meta" />
      </div>
      <p v-if="description" class="mt-2 text-muted">{{ description }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2"><slot /></div>
  </header>
</template>
