// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AppRadioGroup from '@/components/ui/AppRadioGroup.vue';

const options = [
  { value: 'opt-a', label: 'Option A' },
  { value: 'opt-b', label: 'Option B' },
  { value: 'opt-c', label: 'Option C' },
];

const checkedStates = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('[role="radio"]').map(r => r.attributes('aria-checked'));

/** 模拟投票页的真实时序：先以未投票状态挂载（骨架屏结束），拿到已投选票后经 v-model 回填 */
describe('AppRadioGroup', () => {
  it('reflects a model updated via props after mount (late ballot restore)', async () => {
    const wrapper = mount(AppRadioGroup, { props: { options, modelValue: null } });
    expect(checkedStates(wrapper)).toEqual(['false', 'false', 'false']);

    await wrapper.setProps({ modelValue: 'opt-b' });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['false', 'true', 'false']);
  });

  it('reflects an initial model (options registered after model set)', async () => {
    const wrapper = mount(AppRadioGroup, { props: { options, modelValue: 'opt-c' } });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['false', 'false', 'true']);
  });

  it('emits update:model-value when an option is activated', async () => {
    const wrapper = mount(AppRadioGroup, { props: { options, modelValue: null } });
    await wrapper.findAll('[role="radio"]')[1]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['opt-b']);
  });
});

describe('AppRadioGroup with disabled options (voted state)', () => {
  const disabledOptions = options.map(o => ({ ...o, disabled: true }));

  it('restores selection when every option is disabled (after voting)', async () => {
    const wrapper = mount(AppRadioGroup, { props: { options: disabledOptions, modelValue: null } });
    await wrapper.setProps({ modelValue: 'opt-b' });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['false', 'true', 'false']);
  });

  it('keeps selection visible when mounted with model and disabled options', async () => {
    const wrapper = mount(AppRadioGroup, { props: { options: disabledOptions, modelValue: 'opt-b' } });
    await nextTick();
    expect(checkedStates(wrapper)).toEqual(['false', 'true', 'false']);
  });
});
