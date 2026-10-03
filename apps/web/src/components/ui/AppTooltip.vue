<script setup lang="ts">
import { Tooltip } from '@vuetify/v0';
defineProps<{ text: string }>();
</script>
<template>
  <Tooltip.Root :open-delay="350">
    <Tooltip.Activator as="span" class="inline-flex" v-slot="{ attrs }">
      <slot :attrs="attrs" />
    </Tooltip.Activator>
    <Tooltip.Content
      class="z-50 rounded bg-[var(--ink)] px-2 py-1 text-xs text-[var(--v0-surface)] shadow"
    >
      {{ text }}
    </Tooltip.Content>
  </Tooltip.Root>
</template>
