// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { StyledSelect } from '../../packages/ui/src/kit/styled-select.tsx';
import { mount } from './mount.tsx';

it('a form reset that stops bubbling still restores the visible submitted choice', async () => {
  const view = await mount(
    <form onReset={(event) => event.stopPropagation()}>
      <StyledSelect name="choice" defaultValue="a" aria-label="Choice">
        <option value="a">Ada</option>
        <option value="b">Bea</option>
      </StyledSelect>
      <button type="reset">Reset</button>
    </form>,
  );
  await view.click('.sel__btn');
  await view.click('[role="option"]:nth-child(2)');
  const form = view.find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Expected the form');
  expect(new FormData(form).get('choice')).toBe('b');
  expect(view.find('.sel__btn')?.textContent).toBe('Bea');
  await act(async () => {
    form.querySelector<HTMLButtonElement>('[type="reset"]')?.click();
    // eslint-disable-next-line no-promise-executor-return -- waits one task for the reset to apply
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(new FormData(form).get('choice')).toBe('a');
  expect(view.find('.sel__btn')?.textContent).toBe('Ada');
});
