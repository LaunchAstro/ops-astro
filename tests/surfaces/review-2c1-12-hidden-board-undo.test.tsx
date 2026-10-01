// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-12 red proof: a hidden board (another panel showing, D-03) still
// listens for ⌘Z on the document and steps its view back. useUndoKeys in
// packages/ui/src/surfaces/board-hooks.ts has no `hidden` check, while
// BoardMachine only hides the bar. Passes once the undo keys stand down
// while the board is hidden.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const key = async (target: EventTarget, init: KeyboardEventInit): Promise<void> => {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

describe('REVIEW-2C1-12 hidden board', () => {
  it('REVIEW-2C1-12: a hidden board does not undo its view on ⌘Z pressed elsewhere on the page', async () => {
    const onAddress = vi.fn();
    const title = document.createElement('div');
    document.body.append(title);
    try {
      mounted = await mount(
        <BoardGallery width={1200} viewport={1480} bar={title} onAddress={onAddress} />,
      );
      const board = mounted;
      await press(board.find('[data-preset="mine"]'));
      expect(board.find('[data-preset="mine"]')?.getAttribute('aria-pressed')).toBe('true');
      const calls = onAddress.mock.calls.length;
      expect(calls).toBeGreaterThan(0);

      // Another panel is showing: the board is hidden.
      await board.render(
        <BoardGallery width={1200} viewport={1480} bar={title} onAddress={onAddress} hidden />,
      );
      expect(board.find('.cbd')?.hasAttribute('hidden')).toBe(true);
      await key(document.body, { key: 'z', metaKey: true });
      expect(
        onAddress.mock.calls.length,
        'the hidden board answered ⌘Z: its view stepped back and wrote a new address',
      ).toBe(calls);

      await board.render(
        <BoardGallery width={1200} viewport={1480} bar={title} onAddress={onAddress} />,
      );
      expect(
        board.find('[data-preset="mine"]')?.getAttribute('aria-pressed'),
        'the preset chosen before hiding was undone while the board was hidden',
      ).toBe('true');
    } finally {
      title.remove();
    }
  });
});
