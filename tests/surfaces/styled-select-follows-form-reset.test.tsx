// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { StyledSelect } from '../../packages/ui/src/kit/styled-select.tsx';
import { mount } from './mount.tsx';

it('a form reset puts the visible choice back to the value the form submits', async () => {
  const view = await mount(
    <form>
      <StyledSelect aria-label="Choice" name="choice" defaultValue="a">
        <option value="a">Ada</option>
        <option value="b">Bea</option>
      </StyledSelect>
    </form>,
  );
  await view.click('button');
  await view.click('[role=option]:nth-child(2)');
  expect(view.find('button')?.textContent).toBe('Bea');
  const form = view.find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Missing form');
  await act(async () => {
    form.reset();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  expect(new FormData(form).get('choice')).toBe('a');
  expect(view.find('button')?.textContent).toBe('Ada');
  await view.unmount();
});
