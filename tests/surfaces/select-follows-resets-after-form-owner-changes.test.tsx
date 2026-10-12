// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { StyledSelect } from '../../packages/ui/src/kit/styled-select.tsx';
import { mount } from './mount.tsx';

const fields = (form: string) => (
  <>
    <form id="first" />
    <form id="second" />
    <StyledSelect form={form} name="choice" defaultValue="a" aria-label="Choice">
      <option value="a">Ada</option>
      <option value="b">Bea</option>
    </StyledSelect>
  </>
);

it('a select follows resets after its native form owner changes', async () => {
  const view = await mount(fields('first'));
  await view.render(fields('second'));
  await view.click('button');
  await view.click('[role=option]:nth-child(2)');
  expect(view.find('button')?.textContent).toBe('Bea');
  const form = view.find('#second');
  if (!(form instanceof HTMLFormElement)) throw new Error('Expected second form');
  expect(new FormData(form).get('choice')).toBe('b');
  await act(async () => {
    form.reset();
    // eslint-disable-next-line no-promise-executor-return -- waits one task for the reset to apply
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(new FormData(form).get('choice')).toBe('a');
  expect(view.find('button')?.textContent).toBe('Ada');
});
