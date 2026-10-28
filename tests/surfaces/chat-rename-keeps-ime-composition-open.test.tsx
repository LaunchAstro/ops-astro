// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { doubleClick, drawer, heardOf, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

it.each([
  ['while composing', true, 13],
  ['reported as the input method key 229', false, 229],
] as const)(
  'committing an IME word keeps the rename editor open without saving (%s)',
  async (_, isComposing, keyCode) => {
    const page = await drawer();
    (page.find('[data-chat="1"]') as HTMLButtonElement).focus();
    await doubleClick(page, '[data-chat="1"]');
    const field = page.find('[data-chat-rename="1"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    await page.type('[data-chat-rename="1"]', '未確定');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    await act(() => {
      field.dispatchEvent(event);
    });
    expect(heardOf(page, 'rename')).toStrictEqual([]);
    expect(page.find('[data-chat-rename="1"]')).toBe(field);
    expect(field.value).toBe('未確定');
  },
);
