// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { doubleClick, drawer, heardOf, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

it('committing an IME word keeps the rename editor open without saving', async () => {
  const page = await drawer();
  (page.find('[data-chat="1"]') as HTMLButtonElement).focus();
  await doubleClick(page, '[data-chat="1"]');
  const field = page.find('[data-chat-rename="1"]') as HTMLInputElement;
  expect(field).not.toBeNull();
  await page.type('[data-chat-rename="1"]', '未確定');
  await act(() => {
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(heardOf(page, 'rename')).toStrictEqual([]);
  expect(page.find('[data-chat-rename="1"]')).toBe(field);
  expect(field.value).toBe('未確定');
});
