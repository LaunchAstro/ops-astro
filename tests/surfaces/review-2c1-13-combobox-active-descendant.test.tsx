// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-13 red proof: the board search is a combobox whose marked
// suggestion a screen reader never hears. In
// packages/ui/src/surfaces/BoardSearch.tsx the input carries no
// aria-activedescendant and the options carry no ids, so moving the mark with
// the arrows says nothing. Passes once each option has an id and the input
// points aria-activedescendant at the marked one.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const key = async (target: EventTarget, init: KeyboardEventInit): Promise<void> => {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

describe('REVIEW-2C1-13 board search combobox', () => {
  it('REVIEW-2C1-13: the search field names the marked suggestion through aria-activedescendant', async () => {
    mounted = await mount(<BoardGallery width={1200} viewport={1480} />);
    const board = mounted;
    const field = board.find('[data-board-search]') as HTMLInputElement;
    await board.type('[data-board-search]', 'br');
    expect(board.all('[role="option"]').length).toBeGreaterThan(1);
    await key(field, { key: 'ArrowDown' });
    const marked = board.find('[role="option"][aria-selected="true"]');
    expect(marked, 'no option is marked after ArrowDown').not.toBeNull();
    const pointer = field.getAttribute('aria-activedescendant');
    expect(pointer, 'the combobox input has no aria-activedescendant').not.toBeNull();
    expect(marked?.id ?? '', 'the marked option has no id to point at').not.toBe('');
    expect(pointer).toBe(marked?.id);
  });
});
