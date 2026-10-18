// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The ticket filters narrow the tickets and frontier views only, so the map
// screen shows them there and nowhere else: on the Map and Fog views they
// would filter nothing.

import { afterEach, describe, expect, it } from 'vitest';
import type { Mounted } from '../surfaces/mount.tsx';
import { openMadeUpMap, tab } from './one-made-up-map.tsx';

const open: Mounted[] = [];

afterEach(async () => {
  for (const page of open.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop
    await page.unmount();
  }
});

describe('the map filter bar', () => {
  it('shows on the tickets and frontier views, and not on the map or fog views', async () => {
    const page = await openMadeUpMap(open);
    const shown: Record<string, boolean> = {};
    for (const view of ['map', 'tickets', 'frontier', 'fog']) {
      // oxlint-disable-next-line no-await-in-loop
      await tab(page, view);
      shown[view] = page.find('[data-map-filters]') !== null;
    }
    expect(shown).toStrictEqual({ map: false, tickets: true, frontier: true, fog: false });
  });

  it('keeps what was chosen when it comes back after a view without it', async () => {
    const page = await openMadeUpMap(open);
    await tab(page, 'tickets');
    await page.choose('select[name="filter-type"]', 'build');
    await tab(page, 'fog');
    await tab(page, 'frontier');
    expect((page.find('select[name="filter-type"]') as HTMLSelectElement).value).toBe('build');
  });
});
