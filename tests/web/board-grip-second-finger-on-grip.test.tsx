// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable unicorn/consistent-function-scoping -- Sol's proof, kept as written */
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { BoardGallery } from '../surfaces/mp-5-board-gallery-fixture.tsx';
import { mount } from '../surfaces/mount.tsx';

it('another finger on a column grip cannot take over the active drag', async () => {
  const onWidths = vi.fn();
  const view = await mount(<BoardGallery width={1200} viewport={1480} onWidths={onWidths} />);
  const grip = view.find('[data-grip="client"]');
  if (grip === null) throw new Error('Missing Client grip');
  const pointer = async (target: EventTarget, type: string, pointerId: number, clientX: number) => {
    await act(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          clientX,
          pointerType: 'touch',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  };
  await pointer(grip, 'pointerdown', 11, 300);
  await pointer(window, 'pointermove', 11, 340);
  expect(grip.classList.contains('is-live')).toBe(true);
  expect(onWidths).not.toHaveBeenCalled();
  await pointer(grip, 'pointerdown', 22, 340);
  await pointer(window, 'pointermove', 22, 400);
  await pointer(window, 'pointerup', 22, 400);
  expect(
    onWidths,
    'the first finger remains down, so the second finger must not persist its own drag',
  ).not.toHaveBeenCalled();
  expect(grip.classList.contains('is-live')).toBe(true);
  await pointer(window, 'pointermove', 11, 360);
  await pointer(window, 'pointerup', 11, 360);
  expect(onWidths).toHaveBeenCalledTimes(1);
});
