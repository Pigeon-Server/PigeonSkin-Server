<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import SidebarLink from '@/components/SidebarLink.vue';
const props = defineProps<{ title: string; icon: string; items: Array<{ title: string; link: string; icon: string }>; activePath: string }>();
const id = useId();
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const open = ref(false);
const top = ref(12);
function active(link: string) {
  return props.activePath === link || (['/skinlib', '/votes', '/admin/integrations'].includes(link) && props.activePath.startsWith(`${link}/`));
}
function toggled(event: Event) {
  open.value = (event as ToggleEvent).newState === 'open';
  if (open.value) top.value = Math.max(12, Math.min(trigger.value?.getBoundingClientRect().top ?? 12, innerHeight - (panel.value?.offsetHeight ?? 0) - 12));
}
function close() {
  if (panel.value?.matches(':popover-open')) panel.value.hidePopover();
}
watch(() => props.activePath, close);
</script>
<template>
  <div ref="trigger" class="sidebar-category">
    <AppButton class="btn-icon nav-item" :class="{ active: items.some(item => active(item.link)) }" :aria-label="title" :aria-expanded="open" :aria-controls="id" :popovertarget="id">
      <AppIcon :name="icon" />
    </AppButton>
  </div>
  <Teleport to="body">
    <nav :id="id" ref="panel" popover class="sidebar-flyout" :aria-label="title" :style="{ top: `${top}px` }" @toggle="toggled">
      <p class="nav-label">{{ title }}</p>
      <SidebarLink v-for="item in items" :key="item.link" :to="item.link" :label="item.title" :icon="item.icon" :active="active(item.link)" @click="close" />
    </nav>
  </Teleport>
</template>
