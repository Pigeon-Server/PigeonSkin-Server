<script setup lang="ts">
import { computed, useId } from 'vue';
import { useSiteSettings } from '@/stores/site';
import { useI18n } from '@/stores/i18n';
import DOMPurify from 'dompurify';
import { I18nT } from 'vue-i18n';
const creditId = useId();
const site = useSiteSettings();
const i18n = useI18n();
const icpBeian = computed(() => site.get('icp_beian').trim());
const publicSecurityBeian = computed(() => site.get('public_security_beian').trim());
const publicSecurityUrl = computed(() => {
  const code = publicSecurityBeian.value.match(/\d{14}/)?.[0];
  return code ? `https://beian.mps.gov.cn/#/query/webSearch?code=${code}` : 'https://beian.mps.gov.cn/';
});
const preset = computed(() => {
  const value = Number(site.get('copyright_preset'));
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0;
});
const copyright = computed(() => {
  const html = DOMPurify.sanitize(
    site
      .get('copyright_text')
      .replaceAll('{year}', String(new Date().getFullYear()))
      .replaceAll('{site_name}', site.get('site_name'))
      .replaceAll('{site_url}', location.origin),
  );
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll('.copyright-now')) {
    element.textContent = String(new Date().getFullYear());
  }
  return template.innerHTML;
});
</script>
<template>
  <footer class="app-footer">
    <div class="footer-site-info">
      <div v-if="copyright" v-html="copyright" />
      <span v-else>
        {{ i18n.t('common.copyright', { year: new Date().getFullYear(), name: site.get('site_name') || i18n.t('home.title') }) }}
      </span>
      <div v-if="icpBeian || publicSecurityBeian" class="footer-beian-links">
        <a v-if="icpBeian" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{{ icpBeian }}</a>
        <a v-if="publicSecurityBeian" :href="publicSecurityUrl" target="_blank" rel="noopener noreferrer">
          <img src="/beian.svg" alt="" width="16" height="16" />
          <span>{{ publicSecurityBeian }}</span>
        </a>
      </div>
    </div>
    <span class="footer-credit">
      <a :aria-describedby="creditId" href="https://github.com/bs-community/blessing-skin-server" target="_blank" rel="noopener noreferrer">
        <I18nT scope="global" :keypath="`common.copyright_presets.${preset}`" tag="span">
          <template #product>{{ i18n.t('common.product_name') }}</template>
          <template #love><AppIcon name="favorite" class="!text-xs text-red-500" /><span class="sr-only">{{ i18n.t('common.care') }}</span></template>
        </I18nT>
      </a>
      <span :id="creditId" role="tooltip" class="footer-credit-tooltip">{{ i18n.t('common.upstream_credit', { upstream: i18n.t('common.upstream_product_name') }) }}</span>
    </span>
  </footer>
</template>
<style scoped>
.footer-site-info, .footer-beian-links { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; min-width:0; }
.footer-beian-links a { display:inline-flex; align-items:center; gap:6px; overflow-wrap:anywhere; }
.footer-beian-links img { flex-shrink:0; }
@media (max-width:767px) {
  .footer-site-info, .footer-beian-links { justify-content:center; }
}
</style>
