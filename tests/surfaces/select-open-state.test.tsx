// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Select } from '../../packages/ui/src/kit/controls-fields.tsx';
import { mount, type Mounted } from './mount.tsx';

const options = [
  { value: 'a', label: 'Ada' },
  { value: 'b', label: 'Bea' },
  { value: 'c', label: 'Cal' },
];
let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
async function key(name: string): Promise<void> {
  const trigger = mounted?.find('button');
  if (trigger === null || trigger === undefined) throw new Error('missing select');
  await act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

// Sol OW-104.1 correctness, retitled by what it proves; its body is Sol's.
it('a select disabled while open refuses option clicks', async () => {
  const changed = vi.fn();
  mounted = await mount(<Select label="Assignee" options={options} value="a" onChange={changed} />);
  await mounted.click('button');
  await mounted.render(
    <Select label="Assignee" options={options} value="a" onChange={changed} disabled />,
  );
  const option = mounted.find('[role="option"]:nth-child(2)');
  if (option instanceof HTMLElement)
    await act(() => {
      option.click();
    });
  expect(changed).not.toHaveBeenCalled();
});

// Sol OW-104.2 correctness, retitled by what it proves; its body is Sol's.
it('reopening a select starts at its externally updated value', async () => {
  const changed = vi.fn();
  mounted = await mount(<Select label="Assignee" options={options} value="a" onChange={changed} />);
  await mounted.render(<Select label="Assignee" options={options} value="c" onChange={changed} />);
  expect(mounted.find('button')?.textContent).toBe('Cal');
  await key('ArrowDown');
  await key('Enter');
  expect(changed).toHaveBeenCalledWith('c');
});

// Sol OW-104.2 correctness, retitled by what it proves; its body is Sol's.
it('replacing select options keeps an available keyboard choice', async () => {
  const changed = vi.fn();
  mounted = await mount(<Select label="Assignee" options={options} value="c" onChange={changed} />);
  await mounted.render(
    <Select label="Assignee" options={options.slice(0, 1)} value="a" onChange={changed} />,
  );
  await key('ArrowDown');
  await key('Enter');
  expect(changed).toHaveBeenCalledWith('a');
});

// Sol OW-104.3 correctness, retitled by what it proves; its body is Sol's.
it('Escape closes the select without reaching its host panel', async () => {
  const hostEscape = vi.fn();
  mounted = await mount(
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') hostEscape();
      }}
    >
      <Select label="Assignee" options={options} value="a" onChange={() => {}} />
    </div>,
  );
  await mounted.click('button');
  await key('Escape');
  expect(mounted.find('[role="listbox"]')).toBeNull();
  expect(hostEscape).not.toHaveBeenCalled();
});
