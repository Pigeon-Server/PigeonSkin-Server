import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AppForm from '@/components/ui/AppForm.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import { createSubmitEvent } from '@/components/ui/app-form';

const components = { AppIcon };

describe('Vuetify form wrappers', () => {
  it('renders native input constraints through AppInput', async () => {
    const app = createSSRApp({ render: () => h(AppInput, { id: 'email', type: 'email', required: true, maxlength: 80 }) });
    app.component('AppIcon', components.AppIcon);
    const html = await renderToString(app);
    expect(html).toContain('id="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('required');
    expect(html).toContain('maxlength="80"');
  });

  it('renders select options and keeps the selected value in the trigger', async () => {
    const app = createSSRApp({ render: () => h(AppSelect, { modelValue: 'likes', options: [{ value: 'time', label: 'Newest' }, { value: 'likes', label: 'Most liked' }] }) });
    app.component('AppIcon', components.AppIcon);
    const html = await renderToString(app);
    expect(html).toContain('Most liked');
    expect(html).toContain('id="v-0-activator"');
  });

  it('keeps a form element around Vuetify registered controls', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(AppForm, {}, { default: () => h('button', { type: 'submit' }, 'Save') }) }));
    expect(html).toMatch(/<form[^>]*>/);
    expect(html).toContain('type="submit"');
  });

  it('keeps Vuetify validation result on a real cancelable submit event', () => {
    const event = createSubmitEvent(false);
    expect(event).toBeInstanceOf(Event);
    expect(event.valid).toBe(false);
    event.preventDefault();
    expect(event.defaultPrevented).toBe(true);
  });
});
