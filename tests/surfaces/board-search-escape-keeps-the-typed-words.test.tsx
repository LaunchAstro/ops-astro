// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Escape in the board's search closes its suggestions and nothing else: the
// field is a native search input, whose own Escape action (Chromium clears
// the field) is held back, so the typed words stay and Enter still commits.
// With no suggestions shown, Escape is left to the page (a drawer closes).

import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardSearch } from '../../packages/ui/src/surfaces/BoardSearch.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const press = async (field: HTMLInputElement, key: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(() => {
    field.dispatchEvent(event);
  });
  return event;
};

const search = (onCommit: (raw: string) => void) => (
  <BoardSearch
    facets={[]}
    names={['Zebra Zed']}
    noun="task"
    have={{ ids: [], text: [] }}
    onCommit={onCommit}
    onTake={vi.fn()}
    onDropLast={vi.fn()}
  />
);

it('Escape closes the suggestions, keeps the typed words from the browser, and Enter commits them', async () => {
  const onCommit = vi.fn();
  mounted = await mount(search(onCommit));
  await mounted.type('[data-board-search]', 'zeb');
  const field = mounted.find('[data-board-search]') as HTMLInputElement;
  expect(field.getAttribute('aria-expanded')).toBe('true');
  const escape = await press(field, 'Escape');
  expect(escape.defaultPrevented).toBe(true);
  expect(field.getAttribute('aria-expanded')).toBe('false');
  expect(field.value).toBe('zeb');
  await press(field, 'Enter');
  expect(onCommit).toHaveBeenCalledWith('zeb');
});

it('Escape with no suggestions shown is left to the page', async () => {
  mounted = await mount(search(vi.fn()));
  await mounted.type('[data-board-search]', 'quokka');
  const field = mounted.find('[data-board-search]') as HTMLInputElement;
  expect(field.getAttribute('aria-expanded')).toBe('false');
  expect((await press(field, 'Escape')).defaultPrevented).toBe(false);
});
