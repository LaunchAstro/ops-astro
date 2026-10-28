// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Enter that commits an input method's word (Japanese, Chinese and the like)
// is the input method's, not Send: the question stays in the field, unsent.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { drawer, heardOf, press, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const INPUT = '[data-assistant="input"]';
const field = (page: Awaited<ReturnType<typeof drawer>>): HTMLInputElement =>
  page.host.querySelector(INPUT) as HTMLInputElement;

async function composingEnter(
  page: Awaited<ReturnType<typeof drawer>>,
  init: KeyboardEventInit & { readonly keyCode?: number },
): Promise<boolean> {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  // jsdom's KeyboardEvent takes no keyCode; Safari reports 229 on the Enter
  // that ends a composition, after the composition has already ended.
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  let kept = true;
  await act(() => {
    kept = field(page).dispatchEvent(event);
  });
  return kept;
}

it('Enter that commits a composing word sends nothing and keeps the words', async () => {
  const page = await drawer();
  await page.type(INPUT, '未確定');
  const kept = await composingEnter(page, { isComposing: true });
  expect(heardOf(page, 'send')).toStrictEqual([]);
  expect(field(page).value).toBe('未確定');
  expect(kept).toBe(true);
});

it('the Enter a browser reports as the input method key (229) sends nothing', async () => {
  const page = await drawer();
  await page.type(INPUT, '未確定');
  await composingEnter(page, { keyCode: 229 });
  expect(heardOf(page, 'send')).toStrictEqual([]);
  expect(field(page).value).toBe('未確定');
});

it('an ordinary Enter after the word is committed still sends it', async () => {
  const page = await drawer();
  await page.type(INPUT, '確定');
  await press(page, INPUT, 'Enter');
  expect(heardOf(page, 'send')).toStrictEqual([['1', '確定']]);
});
