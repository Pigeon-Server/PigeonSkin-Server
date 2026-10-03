<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Combobox } from '@vuetify/v0';
import { playerApi, type PlayerSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import AvatarPreview from '@/components/AvatarPreview.vue';
import { apiErrorMessage } from '@/lib/api-error';
const open = defineModel<boolean>({ default: false });
const props = defineProps<{ textureId?: number | undefined; kind?: 'skin' | 'cape' | undefined; textures?: { skin?: number; cape?: number } | undefined }>();
const emit = defineEmits<{ applied: [] }>();
const i18n = useI18n();
const players = ref<PlayerSummary[]>([]);
const selected = ref<number | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const selectedPlayer = computed(() => players.value.find(player => player.id === selected.value) ?? null);
const displayPlayer = (id: unknown) => players.value.find(player => player.id === Number(id))?.name ?? '';
const assignment = computed<{ skin?: number; cape?: number }>(() => {
  if (props.textures) return props.textures;
  if (!props.textureId || !props.kind) return {};
  return props.kind === 'skin' ? { skin: props.textureId } : { cape: props.textureId };
});
async function load() {
  loading.value = true;
  error.value = '';
  try {
    players.value = (await playerApi.list()).items;
    selected.value = players.value[0]?.id ?? null;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch(
  open,
  (v) => {
    if (v) void load();
  },
  { immediate: true },
);
async function apply() {
  if (!selected.value || busy.value || !Object.keys(assignment.value).length) return;
  busy.value = true;
  error.value = '';
  try {
    await playerApi.setTextures(selected.value, assignment.value);
    open.value = false;
    emit('applied');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog v-model="open" :title="i18n.t('skinlib.apply')" :busy="busy" dialog-class="app-dialog-autocomplete">
    <p v-if="error" class="alert alert-danger" role="alert">
      {{ error }}
      <AppButton @click="load">{{ i18n.t('common.retry') }}</AppButton>
    </p>
    <p v-if="loading" role="status">{{ i18n.t('common.loading') }}</p>
    <AppForm v-else-if="players.length" @submit.prevent="apply">
      <label class="mb-2 block" for="apply-player">{{ i18n.t('skinlib.select_player') }}</label>
      <Combobox.Root v-model="selected" :display-value="displayPlayer" class="apply-player-combobox" v-slot="{ query }">
        <Combobox.Activator class="relative">
          <div class="pointer-events-none absolute inset-y-0 left-2 z-10 flex items-center">
            <AvatarPreview v-if="selectedPlayer" :hash="selectedPlayer.skinHash" :name="selectedPlayer.name" class="h-7 w-7 rounded" />
          </div>
          <Combobox.Control id="apply-player" class="input w-full" :class="selectedPlayer ? 'pl-12' : ''" :placeholder="i18n.t('user.typeToSearch')" open-on="focus" />
          <Combobox.Cue class="absolute inset-y-0 right-2 flex items-center"><AppIcon name="expand_more" class="text-muted" /></Combobox.Cue>
        </Combobox.Activator>
        <Combobox.Content class="app-select-content apply-player-options">
          <Combobox.Item v-for="player in players.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))" :key="player.id" :value="player.id" :id="`apply-player-${player.id}`" class="app-select-item flex items-center gap-3">
            <AvatarPreview :hash="player.skinHash" :name="player.name" class="h-8 w-8 rounded" />
            <span class="truncate text-sm">{{ player.name }}</span>
          </Combobox.Item>
          <Combobox.Empty class="p-3 text-sm text-muted">{{ i18n.t('general.noResult') }}</Combobox.Empty>
        </Combobox.Content>
      </Combobox.Root>
      <div class="mt-5 flex justify-end gap-2">
        <AppButton :disabled="busy" @click="open = false">{{ i18n.t('common.cancel') }}</AppButton>
        <AppButton type="submit" class="btn-primary" :loading="busy" :disabled="!selected">
          {{ i18n.t('skinlib.apply') }}
        </AppButton>
      </div>
    </AppForm>
    <EmptyState v-else-if="!error" :title="i18n.t('player.empty')" icon="sports_esports">
      <router-link to="/player" class="btn btn-primary">{{ i18n.t('player.create') }}</router-link>
    </EmptyState>
  </AppDialog>
</template>
