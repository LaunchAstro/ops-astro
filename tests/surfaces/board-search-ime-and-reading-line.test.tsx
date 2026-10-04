// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardSearch } from '../../packages/ui/src/surfaces/BoardSearch.tsx';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

// Sol OW-110.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('the reading line counts the rows actually shown by a table mode', async () => {
  mounted = await mount(
    <BoardGallery
      width={1200}
      viewport={1480}
      modes={[{ id: 'review', label: 'Review', narrow: (row) => row.waiting }]}
    />,
  );
  expect(mounted.all('tbody tr[data-row]')).toHaveLength(8);
  await mounted.click('[data-mode="review"]');
  expect(mounted.all('tbody tr[data-row]')).toHaveLength(2);
  expect(mounted.find('.cbd__read')?.textContent).toBe('2 shown · 2 more withheld by permission');
});

// Sol OW-110.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('Enter during IME composition does not commit or erase the draft', async () => {
  const onCommit = vi.fn();
  const onTake = vi.fn();
  mounted = await mount(
    <BoardSearch
      facets={[]}
      names={[]}
      noun="task"
      have={{ ids: [], text: [] }}
      onCommit={onCommit}
      onTake={onTake}
      onDropLast={vi.fn()}
    />,
  );
  await mounted.type('[data-board-search]', '東京');
  const field = mounted.find('[data-board-search]');
  if (!(field instanceof HTMLInputElement)) throw new Error('missing search field');
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
  expect(
    onCommit,
    'confirming an IME candidate must not submit a board query',
  ).not.toHaveBeenCalled();
  expect(onTake).not.toHaveBeenCalled();
  expect(field.value).toBe('東京');
});
