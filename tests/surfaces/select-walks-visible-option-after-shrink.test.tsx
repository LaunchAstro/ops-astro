// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { Select } from '../../packages/ui/src/kit/controls-fields.tsx';
import { mount } from './mount.tsx';

const options = [
  { value: 'a', label: 'Ada' },
  { value: 'b', label: 'Bea' },
  { value: 'c', label: 'Cal' },
];

// Sol G1c-FIX2 correctness, retitled by what it proves; its body is Sol's.
it('an open select walks from its visible option after options shrink', async () => {
  const changed = vi.fn();
  const view = await mount(
    <Select label="Assignee" options={options} value="c" onChange={changed} />,
  );
  const key = async (name: string): Promise<void> => {
    const trigger = view.find('button');
    if (trigger === null) throw new Error('select missing');
    await act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  };
  try {
    await view.click('button');
    expect(view.find('.menu__opt.is-active')?.textContent).toContain('Cal');
    await view.render(
      <Select label="Assignee" options={options.slice(0, 2)} value="b" onChange={changed} />,
    );
    expect(view.find('.menu__opt.is-active')?.textContent).toContain('Bea');
    await key('ArrowUp');
    await key('Enter');
    expect(changed).toHaveBeenCalledWith('a');
  } finally {
    await view.unmount();
  }
});
