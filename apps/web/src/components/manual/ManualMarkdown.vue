<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useI18n } from '@/stores/i18n';
const i18n = useI18n();
const props = withDefaults(defineProps<{ content: string; interactiveImages?: boolean }>(), { interactiveImages: true });
const emit = defineEmits<{ image: [source: string, caption: string] }>();
const router = useRouter();
const html = computed(() => {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(marked.parse(props.content, { async: false }) as string);
  for (const table of template.content.querySelectorAll('table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'manual-table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', i18n.t('manual.content'));
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for (const image of template.content.querySelectorAll('img')) {
    const figure = document.createElement('figure');
    const button = document.createElement(props.interactiveImages ? 'button' : 'div');
    button.className = props.interactiveImages ? 'manual-image-button' : 'manual-image-frame';
    if (button instanceof HTMLButtonElement) { button.type = 'button'; button.setAttribute('aria-label', i18n.t('manual.enlarge_image', { caption: image.alt })); }
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = 1440;
    image.height = 900;
    const caption = document.createElement('figcaption');
    caption.textContent = image.alt;
    const parent = image.parentElement;
    image.replaceWith(figure);
    button.append(image);
    figure.append(button, caption);
    if (parent?.tagName === 'P' && parent.childNodes.length === 1) parent.replaceWith(figure);
  }
  for (const paragraph of template.content.querySelectorAll('p')) {
    if (paragraph.children.length === 1 && paragraph.firstElementChild?.tagName === 'CODE' && paragraph.textContent === paragraph.firstElementChild.textContent) {
      paragraph.classList.add('manual-code-address');
    }
  }
  for (const media of template.content.querySelectorAll('audio, video')) {
    media.setAttribute('controls', '');
    media.setAttribute('preload', 'metadata');
    media.removeAttribute('autoplay');
  }
  for (const link of template.content.querySelectorAll('a')) {
    const url = new URL(link.href, location.origin);
    if (url.origin === location.origin && url.pathname.startsWith('/api/v1/manual/assets/')) link.setAttribute('download', link.textContent || '');
  }
  return template.innerHTML;
});
function follow(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const imageButton = target.closest('.manual-image-button');
  if (imageButton) {
    const image = imageButton.querySelector('img');
    if (image) emit('image', image.src, image.alt);
    return;
  }
  const link = target.closest('a');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href);
  if (url.pathname.startsWith('/api/') || /^\/manual\/[^/]+\.[a-z0-9]+$/i.test(url.pathname)) return;
  if (url.origin === location.origin && !link.hasAttribute('download')) {
    event.preventDefault();
    void router.push(url.pathname + url.search + url.hash);
  }
}
</script>
<template><div class="manual-markdown" v-html="html" @click="follow" /></template>
<style scoped>
.manual-markdown { font-size: 16px; line-height: 1.85; overflow-wrap: break-word; }
.manual-markdown :deep(p) { margin: 0 0 18px; }
.manual-markdown :deep(a) { color: var(--brand); text-decoration: underline; text-underline-offset: 3px; }
.manual-markdown :deep(strong) { font-weight: 650; }
.manual-markdown :deep(ul), .manual-markdown :deep(ol) { margin: 18px 0; padding-left: 25px; }
.manual-markdown :deep(ul) { list-style: disc; }
.manual-markdown :deep(ol) { list-style: decimal; }
.manual-markdown :deep(li) { padding-left: 4px; margin: 8px 0; }
.manual-markdown :deep(li > p) { margin-bottom: 8px; }
.manual-markdown :deep(h3) { margin: 28px 0 12px; font-size: 18px; font-weight: 650; }
.manual-markdown :deep(h1) { margin: 32px 0 20px; font-size: 28px; font-weight: 700; }
.manual-markdown :deep(h2) { margin: 32px 0 18px; font-size: 22px; font-weight: 650; }
.manual-markdown :deep(blockquote) { margin: 24px 0; padding: 16px 20px; border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0; background: var(--v0-surface-2); color: var(--ink); }
.manual-markdown :deep(blockquote p:last-child) { margin-bottom: 0; }
.manual-markdown :deep(code) { padding: 2px 5px; border-radius: 4px; font-size: .875em; background: var(--v0-surface-2); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.manual-markdown :deep(pre) { margin: 20px 0; padding: 18px; overflow-x: auto; border: 1px solid var(--v0-border); border-radius: 8px; background: var(--v0-surface-2); }
.manual-markdown :deep(pre code) { padding: 0; background: none; overflow-wrap: normal; }
.manual-markdown :deep(.manual-code-address) { padding: 14px 18px; border: 1px solid var(--v0-border); border-radius: 8px; background: var(--v0-surface-2); }
.manual-markdown :deep(.manual-code-address code) { padding: 0; background: none; }
.manual-markdown :deep(.manual-table-scroll) { max-width: 100%; overflow-x: auto; margin: 24px 0; border: 1px solid var(--v0-border); border-radius: 8px; }
.manual-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.7; text-align: left; }
.manual-markdown :deep(th), .manual-markdown :deep(td) { padding: 12px 16px; min-width: 160px; vertical-align: top; }
.manual-markdown :deep(th) { background: var(--v0-surface-2); font-weight: 650; }
.manual-markdown :deep(tr + tr td), .manual-markdown :deep(tbody tr:first-child td) { border-top: 1px solid var(--v0-border); }
.manual-markdown :deep(th + th), .manual-markdown :deep(td + td) { border-left: 1px solid var(--v0-border); }
.manual-markdown :deep(figure) { margin: 28px 0; }
.manual-markdown :deep(.manual-image-button) { width: 100%; display: block; overflow: hidden; border: 1px solid var(--v0-border); border-radius: 8px; background: var(--v0-surface-2); cursor: zoom-in; padding: 0; }
.manual-markdown :deep(.manual-image-frame) { overflow: hidden; border: 1px solid var(--v0-border); border-radius: 8px; }
.manual-markdown :deep(img) { display: block; width: 100%; height: auto; }
.manual-markdown :deep(audio), .manual-markdown :deep(video) { display: block; width: 100%; max-width: 100%; margin: 24px 0 12px; border-radius: 8px; }
.manual-markdown :deep(video) { max-height: 70dvh; background: #000; }
.manual-markdown :deep(figcaption) { margin-top: 10px; color: var(--v0-muted); font-size: 12px; line-height: 1.7; text-align: center; }
.manual-markdown :deep(:focus-visible) { outline: 2px solid var(--brand); outline-offset: 3px; }
@media (max-width: 767px) { .manual-markdown { font-size: 15px; } .manual-markdown :deep(th), .manual-markdown :deep(td) { min-width: 150px; padding: 10px 12px; } }
</style>
