// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Two boards in view at once (the Projects page and a Projects dock panel)
// keep their own histories: an undo key pressed inside one board steps that
// board only, and one pressed outside every board steps one board, never
// both.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const press = async (target: Element | null): Promise<void> => {
  if (target === null) throw new Error('nothing to press');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const undoKey = async (target: EventTarget): Promise<void> => {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }),
    );
  });
};

async function twoBoards(): Promise<readonly [Element, Element]> {
  mounted = await mount(
    <>
      <section data-test="page">
        <BoardGallery width={1200} viewport={1480} />
      </section>
      <section data-test="panel">
        <BoardGallery width={1200} viewport={1480} />
      </section>
    </>,
  );
  const page = mounted.find('[data-test="page"]')!;
  const panel = mounted.find('[data-test="panel"]')!;
  await press(page.querySelector('th[data-key="name"] button'));
  await press(panel.querySelector('th[data-key="due"] button'));
  return [page, panel];
}

const sortOf = (board: Element, key: string) =>
  board.querySelector(`th[data-key="${key}"]`)?.getAttribute('aria-sort');

it('an undo key pressed inside one board steps that board and leaves the other alone', async () => {
  const [page, panel] = await twoBoards();
  expect(sortOf(page, 'name')).toBe('ascending');
  expect(sortOf(panel, 'due')).toBe('ascending');
  await undoKey(panel.querySelector('th[data-key="due"] button')!);
  expect(sortOf(panel, 'due')).toBe('none');
  expect(sortOf(page, 'name')).toBe('ascending');
});

it('an undo key pressed outside every board steps one board, not both', async () => {
  const [page, panel] = await twoBoards();
  await undoKey(document.body);
  const stepped = [sortOf(page, 'name'), sortOf(panel, 'due')].filter((sort) => sort === 'none');
  expect(stepped).toHaveLength(1);
});
