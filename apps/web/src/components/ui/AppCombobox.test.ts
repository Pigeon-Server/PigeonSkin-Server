// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AppCombobox from '@/components/ui/AppCombobox.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

// jsdom 未实现 CSS.escape 与 scrollIntoView：前者用于拼选项选择器，后者在虚拟焦点高亮时调用
if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`),
  };
}
Element.prototype.scrollIntoView = () => {};

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

const options = ['DeepSeek/deepseek-flash', 'Qwen/Qwen3.8-27B-FP8'];
const base = { options, customLabel: '手填' };
// 必须挂到 document 上：Combobox 的虚拟焦点按 id 在文档里找选项，relocate 前也才有 aria 关联
// 每个用例结束都卸载，否则同名 id 会让 getElementById 命中上一个用例的残留节点
const mountCombobox = (modelValue = '') => {
  const wrapper = mount(AppCombobox, { props: { ...base, modelValue }, attachTo: document.body, global: { components: { AppIcon } } });
  mounted.push(wrapper);
  return wrapper;
};
const optionTexts = (wrapper: ReturnType<typeof mountCombobox>) =>
  wrapper
    .findAll('[role="option"]')
    .filter(option => (option.element as HTMLElement).style.display !== 'none')
    .map(option => option.text());
// 下拉的开合由 Combobox 内部的延迟驱动，等一拍再断言
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('AppCombobox', () => {
  it('renders the input with the given id and constraints', () => {
    const wrapper = mount(AppCombobox, {
      props: { ...base, modelValue: '', id: 'setting-ai_texture_translate_model', maxlength: 100, placeholder: 'gpt-4o-mini' },
      attachTo: document.body,
      global: { components: { AppIcon } },
    });
    mounted.push(wrapper);
    const input = wrapper.find('input');
    expect(input.attributes('id')).toBe('setting-ai_texture_translate_model');
    expect(input.attributes('maxlength')).toBe('100');
    expect(input.attributes('placeholder')).toBe('gpt-4o-mini');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
  });

  it('keeps a configured model that is missing from the fetched list', () => {
    const wrapper = mountCombobox('self-hosted/private-model');
    expect(optionTexts(wrapper)).toHaveLength(options.length + 1);
    const pinned = wrapper.find('[role="option"]');
    expect(pinned.text()).toContain('self-hosted/private-model');
    expect(pinned.find('.text-xs').exists()).toBe(true);
    expect(wrapper.findAll('[role="option"]').at(-1)!.find('.text-xs').exists()).toBe(false);
  });

  it('filters options while typing', async () => {
    const wrapper = mountCombobox('');
    await wrapper.find('input').setValue('qwen');
    expect(optionTexts(wrapper)).toEqual(['Qwen/Qwen3.8-27B-FP8']);
  });

  it('commits a model name typed by hand on Enter', async () => {
    const wrapper = mountCombobox('');
    await wrapper.find('input').setValue('my-model-v2');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['my-model-v2']);
  });

  it('closes the list when the field loses focus', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.trigger('focus');
    await settle();
    expect(input.attributes('aria-expanded')).toBe('true');
    await input.trigger('focusout');
    await settle();
    expect(input.attributes('aria-expanded')).toBe('false');
  });

  it('commits a model name typed by hand when focus leaves the field', async () => {
    const wrapper = mountCombobox('');
    await wrapper.find('input').setValue('my-model-v2');
    await wrapper.find('input').trigger('focusout');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['my-model-v2']);
  });

  it('confirms a model name typed in full on Enter', async () => {
    const wrapper = mountCombobox('');
    await wrapper.find('input').setValue('Qwen/Qwen3.8-27B-FP8');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Qwen/Qwen3.8-27B-FP8']);
  });

  it('writes the picked option into the model', async () => {
    const wrapper = mountCombobox('');
    await wrapper.findAll('[role="option"]')[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([options[0]]);
  });

  it('does not commit the filter text when the mouse presses the list', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.setValue('Qwen');
    const option = wrapper.findAll('[role="option"]')[1]!;
    // 真实鼠标：先 mousedown（浏览器随即把焦点移出输入框），再 click
    await option.trigger('mousedown');
    await input.trigger('focusout');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await option.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Qwen/Qwen3.8-27B-FP8']);
  });

  it('commits what was typed when the highlighted option no longer matches', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.trigger('focus');
    await settle();
    await input.setValue('Deep');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(wrapper.findAll('[data-highlighted]')).toHaveLength(1);
    await input.setValue('Deepzz');
    await nextTick();
    expect(optionTexts(wrapper)).toEqual([]);
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Deepzz']);
  });

  it('empties the field when the model is cleared', async () => {
    const wrapper = mountCombobox('Qwen/Qwen3.8-27B-FP8');
    await settle();
    await wrapper.setProps({ modelValue: '' });
    await settle();
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
    expect(optionTexts(wrapper)).toEqual(options);
  });

  it('reopens the list when typing after it was closed while the field kept focus', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.trigger('focus');
    await settle();
    await input.trigger('keydown', { key: 'Escape' });
    await settle();
    expect(input.attributes('aria-expanded')).toBe('false');
    await input.setValue('Qwen');
    await settle();
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(optionTexts(wrapper)).toEqual(['Qwen/Qwen3.8-27B-FP8']);
  });

  it('selects the highlighted option on Enter instead of the typed filter', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.trigger('focus');
    await new Promise(resolve => setTimeout(resolve, 20));
    await input.setValue('Qwen');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(wrapper.findAll('[data-highlighted]')).toHaveLength(1);
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Qwen/Qwen3.8-27B-FP8']);
  });

  it('keeps a model name that is typed by hand and left unconfirmed in the list', async () => {
    const wrapper = mountCombobox('');
    const input = wrapper.find('input');
    await input.setValue('my-model-v2');
    expect(optionTexts(wrapper)).toEqual([]);
    await input.trigger('focusout');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['my-model-v2']);
  });
});
