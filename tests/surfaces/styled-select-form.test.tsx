// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { StyledSelect } from '../../packages/ui/src/kit/styled-select.tsx';
import { mount } from './mount.tsx';

it('custom choices retain native form values and the existing change handler', async () => {
  const changes: string[] = [];
  function Form() {
    const [value, setValue] = useState('a');
    return (
      <form>
        <label htmlFor="assignee">Assignee</label>
        <StyledSelect
          id="assignee"
          name="assignee"
          value={value}
          onChange={(event) => {
            changes.push(event.target.value);
            setValue(event.target.value);
          }}
        >
          <option value="a">Ada</option>
          <option value="b">Bea</option>
          <option value="c" disabled>
            Unavailable
          </option>
        </StyledSelect>
      </form>
    );
  }
  const view = await mount(<Form />);
  await view.click('button');
  await view.click('[role=option][aria-disabled=true]');
  expect(changes).toEqual([]);
  await view.click('[role=option]:nth-child(1)');
  expect(changes).toEqual([]);
  await view.click('button');
  await view.click('[role=option]:nth-child(2)');
  expect(changes).toEqual(['b']);
  expect(view.find('button')?.textContent).toBe('Bea');
  const form = view.find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Missing form');
  expect(new FormData(form).get('assignee')).toBe('b');
  expect(view.find('[role=listbox]')).toBeNull();
});

it('keyboard selection skips disabled options and Escape leaves the enclosing drawer open', async () => {
  const choices: string[] = [];
  let escaped = false;
  const view = await mount(
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') escaped = true;
      }}
    >
      <StyledSelect
        aria-label="Stage"
        defaultValue="a"
        onChange={(event) => choices.push(event.target.value)}
      >
        <option value="a">Awareness</option>
        <option disabled value="b">
          Unavailable
        </option>
        <option value="c">Sales</option>
      </StyledSelect>
    </div>,
  );
  const button = view.find('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing trigger');
  const key = (name: string) =>
    act(() => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  expect(choices).toEqual(['c']);
  await key('ArrowDown');
  await key('Escape');
  expect(escaped).toBe(false);
  expect(view.find('[role=listbox]')).toBeNull();
});
