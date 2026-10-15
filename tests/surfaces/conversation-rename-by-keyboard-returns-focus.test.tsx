// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A conversation is renamed from the keyboard alone, and focus comes back to
// its tab when the rename ends by Enter or Escape, never to the page body.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { doubleClick, drawer, heardOf, press, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

it('F2 on the selected tab opens its rename field, and Enter hands on the new title', async () => {
  const page = await drawer();
  const tab = page.find('[data-chat="1"]') as HTMLButtonElement;
  expect(tab.getAttribute('aria-keyshortcuts')).toBe('F2');
  tab.focus();
  await press(page, '[data-chat="1"]', 'F2');
  const field = page.find('[data-chat-rename="1"]') as HTMLInputElement | null;
  expect(field).not.toBeNull();
  expect(document.activeElement).toBe(field);
  await page.type('[data-chat-rename="1"]', 'Booking form');
  await press(page, '[data-chat-rename="1"]', 'Enter');
  expect(heardOf(page, 'rename')).toStrictEqual([['1', 'Booking form']]);
});

it('finishing a rename with Enter puts focus back on that conversation tab', async () => {
  const page = await drawer();
  (page.find('[data-chat="1"]') as HTMLButtonElement).focus();
  await doubleClick(page, '[data-chat="1"]');
  await page.type('[data-chat-rename="1"]', 'Booking form');
  await press(page, '[data-chat-rename="1"]', 'Enter');
  expect(page.find('[data-chat-rename]')).toBeNull();
  expect(document.activeElement).toBe(page.find('[data-chat="1"]'));
});

it('cancelling a rename with Escape puts focus back on that conversation tab', async () => {
  const page = await drawer();
  (page.find('[data-chat="1"]') as HTMLButtonElement).focus();
  await doubleClick(page, '[data-chat="1"]');
  await page.type('[data-chat-rename="1"]', 'Thrown away');
  await press(page, '[data-chat-rename="1"]', 'Escape');
  expect(heardOf(page, 'rename')).toStrictEqual([]);
  expect(document.activeElement).toBe(page.find('[data-chat="1"]'));
});

it('a rename ended by leaving the field leaves focus where the person moved it', async () => {
  const page = await drawer();
  (page.find('[data-chat="1"]') as HTMLButtonElement).focus();
  await press(page, '[data-chat="1"]', 'F2');
  const send = page.find('[data-assistant="send"]') as HTMLButtonElement;
  await act(() => {
    send.focus();
  });
  expect(page.find('[data-chat-rename]')).toBeNull();
  expect(document.activeElement).toBe(send);
});
