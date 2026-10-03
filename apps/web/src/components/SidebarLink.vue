<script setup lang="ts">
import AppTooltip from '@/components/ui/AppTooltip.vue';
defineProps<{ to: string; label: string; icon: string; active?: boolean }>();
</script>
<template>
  <div class="sidebar-link">
    <AppTooltip :text="label" v-slot="{ attrs }">
      <router-link v-bind="attrs" :to="to" class="nav-item" :class="{ active }" :aria-label="label" :aria-current="active ? 'page' : undefined">
        <AppIcon :name="icon" />
        <span class="sidebar-text">{{ label }}</span>
      </router-link>
    </AppTooltip>
  </div>
</template>
