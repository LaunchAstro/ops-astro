// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Columns shown only above a screen width (hideBelow) follow the window as it
// resizes, even when the board's own width does not change.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
const opened = window.innerWidth;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.innerWidth = opened;
});

const resize = async (width: number): Promise<void> => {
  window.innerWidth = width;
  await act(() => {
    window.dispatchEvent(new Event('resize'));
  });
};

it('a column hidden below a screen width goes and comes back as the window crosses it', async () => {
  window.innerWidth = 1480;
  mounted = await mount(<BoardGallery width={1200} />);
  expect(mounted.find('th[data-key="actual"]')).not.toBeNull();
  await resize(1000);
  expect(mounted.find('th[data-key="actual"]')).toBeNull();
  await resize(1480);
  expect(mounted.find('th[data-key="actual"]')).not.toBeNull();
});
