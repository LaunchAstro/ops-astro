// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { EdgeGrip } from '../../packages/ui/src/surfaces/EdgeGrip.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

// jsdom has no pointer capture implementation. Only that browser API is
// stubbed; React receives the same pointer ids and coordinates as a touch.
async function pointer(target: HTMLElement, type: string, id: number, x: number): Promise<void> {
  await act(() => {
    target.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x }), {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
      }),
    );
  });
}

// Sol OW-111.1 criterion 5, retitled by what it proves; its body is Sol's.
it('a second touch cannot replace or commit the active resize', async () => {
  const changed: number[] = [];
  const committed: number[] = [];
  view = await mount(
    <EdgeGrip
      edge="left"
      className="grip"
      label="Panel width"
      value={550}
      min={380}
      reset={550}
      per={1}
      onDragging={() => {}}
      onChange={(value) => changed.push(value)}
      onCommit={(value) => committed.push(value)}
    />,
  );
  const grip = view.find('.grip');
  if (!(grip instanceof HTMLElement)) throw new Error('grip not mounted');
  grip.setPointerCapture = () => {};
  await pointer(grip, 'pointerdown', 1, 1000);
  await pointer(grip, 'pointermove', 1, 950);
  expect(changed).toEqual([600]);
  await pointer(grip, 'pointerdown', 2, 900);
  await pointer(grip, 'pointermove', 2, 850);
  await pointer(grip, 'pointerup', 2, 850);
  await pointer(grip, 'pointermove', 1, 900);
  await pointer(grip, 'pointerup', 1, 900);
  // The first finger grew the panel by 100 px. The second finger must
  // neither change that origin nor finish the first finger's gesture.
  expect(changed).toEqual([600, 650]);
  expect(committed).toEqual([650]);
});
