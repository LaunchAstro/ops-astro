// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

// Sol OW-110.1 criterion 5, retitled by what it proves; its body is Sol's.
it('another pointer cannot finish and persist the active column drag', async () => {
  const onWidths = vi.fn();
  mounted = await mount(<BoardGallery width={1200} viewport={1480} onWidths={onWidths} />);
  const grip = mounted.find('[data-grip="client"]');
  if (grip === null) throw new Error('missing Client resize grip');
  await act(() => {
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 11,
        pointerType: 'touch',
        clientX: 300,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 11, clientX: 340 }));
  });
  expect(onWidths).not.toHaveBeenCalled();
  expect(grip.classList.contains('is-live')).toBe(true);
  await act(() => {
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 22,
        pointerType: 'touch',
        clientX: 700,
        bubbles: true,
      }),
    );
  });
  await act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 22, clientX: 700 }));
  });
  expect(
    onWidths,
    "lifting a second finger must not save the first finger's unfinished drag",
  ).not.toHaveBeenCalled();
  expect(grip.classList.contains('is-live')).toBe(true);
  await act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, clientX: 340 }));
  });
  expect(onWidths).toHaveBeenCalledTimes(1);
});
