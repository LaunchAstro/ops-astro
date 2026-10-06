// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { draft } from './draft-support.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

// Sol OW-089.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('Enter that commits IME composition does not add an unfinished tag', async () => {
  const { view } = await draft();
  await typeInto(view, '#panel-draft-tags', '未確定');
  const field = view.host.querySelector<HTMLInputElement>('#panel-draft-tags');
  expect(field).not.toBeNull();
  await act(() => {
    field?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(view.all('[data-draft-tag]')).toHaveLength(0);
  expect(field?.value).toBe('未確定');
});
