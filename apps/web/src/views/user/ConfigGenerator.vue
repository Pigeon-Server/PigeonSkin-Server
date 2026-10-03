<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import { createSkinConfigs } from '@/lib/skin-config';
const i18n = useI18n();
const site = useSiteSettings();
const error = ref(''),
  copied = ref('');
const name = computed(() => site.get('site_name') || i18n.t('common.product_name'));
const configs = computed(() =>
  createSkinConfigs(
    name.value,
    location.origin,
    site.get('csl_first') === 'mojang' ? 'mojang' : 'self',
  ),
);
const outputs = computed(() => [
  { id: 'csl', title: 'config_generator.csl', content: JSON.stringify(configs.value.csl, null, 2) },
  { id: 'usm', title: 'config_generator.usm', content: JSON.stringify(configs.value.usm, null, 2) },
]);
async function copy(id: string, content: string) {
  error.value = '';
  try {
    await navigator.clipboard.writeText(content);
    copied.value = id;
  } catch {
    error.value = i18n.t('integration.copy_failed');
  }
}
const extraUrl = computed(() => '/api/v1/config/extra-list?locale=' + encodeURIComponent(i18n.locale.value));
onMounted(() => {
  void site.fetch();
});
</script>
<template>
  <PageHeader
    :title="i18n.t('integration.modules.generator')"
  />
  <p v-if="site.error.value || error" class="alert alert-danger" role="alert">
    {{ error || i18n.t(site.error.value) }}
    <AppButton v-if="site.error.value" class="btn-sm ml-2" @click="site.fetch(true)">
      {{ i18n.t('common.retry') }}
    </AppButton>
  </p>
  <AppSkeleton v-if="!site.ready.value && site.loading.value" :count="3" />
  <div
    v-else-if="site.ready.value"
    class="grid items-start gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]"
  >
    <div class="space-y-4">
      <section class="panel space-y-3">
        <h2 class="font-semibold">{{ i18n.t('config_generator.mods') }}</h2>
        <MarkdownContent
          v-if="site.get('config_generator_intro')"
          :content="site.get('config_generator_intro')"
        />
        <template v-else>
          <p class="text-sm text-muted">{{ i18n.t('config_generator.intro') }}</p>
          <ul class="list-disc pl-5 text-sm space-y-1">
            <li>{{ i18n.t('config_generator.csl') }}</li>
            <li>{{ i18n.t('config_generator.usm') }}</li>
            <li>{{ i18n.t('config_generator.legacy') }}</li>
          </ul>
        </template>
        <div class="flex flex-wrap gap-2">
          <a
            class="btn btn-primary"
            href="https://github.com/xfl03/MCCustomSkinLoader/releases"
            target="_blank"
            rel="noopener noreferrer"
          >
            <AppIcon name="download" />
            {{ i18n.t('config_generator.csl') }}
          </a>
          <a
            class="btn"
            href="https://github.com/RecursiveG/UniSkinMod/releases"
            target="_blank"
            rel="noopener noreferrer"
          >
            <AppIcon name="download" />
            {{ i18n.t('config_generator.usm') }}
          </a>
        </div>
      </section>
      <section class="panel space-y-3">
        <h2 class="font-semibold">{{ i18n.t('config_generator.extra_list') }}</h2>
        <p class="text-sm text-muted">{{ i18n.t('config_generator.extra_intro') }}</p>
        <code class="block break-all rounded border border-line bg-surface-2 p-3 text-xs">
          .minecraft/CustomSkinLoader/ExtraList
        </code>
        <p class="text-sm text-muted">
          {{ i18n.t('config_generator.extra_consumed', { site: name }) }}
        </p>
        <a class="btn btn-primary" :href="extraUrl" download>
          <AppIcon name="download" />
          {{ i18n.t('config_generator.download_extra') }}
        </a>
      </section>
    </div>
    <div class="min-w-0 space-y-4">
      <section v-for="output in outputs" :key="output.id" class="panel !p-0 overflow-hidden">
        <header class="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 class="font-semibold text-sm">{{ i18n.t(output.title) }}</h2>
          <AppButton class="btn-sm" @click="copy(output.id, output.content)">
            <AppIcon :name="copied === output.id ? 'check' : 'content_copy'" />
            {{ i18n.t(copied === output.id ? 'common.copied' : 'common.copy') }}
          </AppButton>
        </header>
        <pre
          class="overflow-auto bg-surface-2 p-4 text-xs leading-6"
        ><code>{{ output.content }}</code></pre>
      </section>
    </div>
  </div>
</template>
