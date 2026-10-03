// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AppCheckboxGroup from '@/components/ui/AppCheckboxGroup.vue';

const options = [
  { value: 'opt-a', label: 'Option A' },
  { value: 'opt-b', label: 'Option B' },
];

const checkedStates = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('[role="checkbox"]').map(r => r.attributes('aria-checked'));

describe('AppCheckboxGroup', () => {
  it('toggles options and emits the updated array', async () => {
    const wrapper = mount(AppCheckboxGroup, { props: { options, modelValue: [] } });
    await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['opt-a']]);
  });

  it('keeps checked visible when options are disabled (after voting)', async () => {
    const disabled = options.map(o => ({ ...o, disabled: true }));
    const wrapper = mount(AppCheckboxGroup, { props: { options: disabled, modelValue: ['opt-a'] } });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['true', 'false']);
    await wrapper.findAll('[role="checkbox"]')[1]!.trigger('click');
    expect(checkedStates(wrapper)).toEqual(['true', 'false']);
  });

  it('reflects a model updated via props after mount', async () => {
    const wrapper = mount(AppCheckboxGroup, { props: { options, modelValue: [] } });
    await wrapper.setProps({ modelValue: ['opt-b'] });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['false', 'true']);
  });
});
