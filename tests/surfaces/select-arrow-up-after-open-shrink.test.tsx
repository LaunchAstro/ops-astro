// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { Select } from '../../packages/ui/src/kit/controls-fields.tsx';
import { mount } from './mount.tsx';

// Sol G1-FIX1 correctness, retitled by what it proves; its body is Sol's.
it('ArrowUp moves from the visible option after an open select shrinks', async () => {
  const options = [
    { value: 'a', label: 'Ada' },
    { value: 'b', label: 'Bea' },
    { value: 'c', label: 'Cal' },
  ];
  const changed = vi.fn();
  const view = await mount(
    <Select label="Assignee" options={options} value="c" onChange={changed} />,
  );
  try {
    await view.click('button');
    expect(view.find('.is-active')?.textContent).toContain('Cal');
    await view.render(
      <Select label="Assignee" options={options.slice(0, 2)} value="b" onChange={changed} />,
    );
    expect(view.find('.is-active')?.textContent).toContain('Bea');
    const trigger = view.find('button');
    if (trigger === null) throw new Error('missing select trigger');
    for (const key of ['ArrowUp', 'Enter']) {
      await act(() => {
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    }
    expect(changed).toHaveBeenCalledExactlyOnceWith('a');
  } finally {
    await view.unmount();
  }
});
