// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { page, found } from './task-page-stub.tsx';

it('the task page links its admitted map by key', async () => {
  const view = await page(
    'Proj-Verity-Pacing',
    found({
      map: { id: 'map-one', key: 'MAP-7', title: 'A made-up plan' },
    }),
  );
  expect(view.find('a[href="/map/MAP-7"]')?.textContent).toBe('Map: A made-up plan');
});

it('the task page uses the map ID when its key is absent', async () => {
  const view = await page(
    'Proj-Verity-Pacing',
    found({
      map: { id: 'map-two', key: null, title: 'Another made-up plan' },
    }),
  );
  expect(view.find('a[href="/map/map-two"]')?.textContent).toBe('Map: Another made-up plan');
});

it.each([{}, { map: null }])(
  'the task page draws no map link when its read names no map: %j',
  async (over) => {
    const admitted = await page(
      'Proj-Verity-Pacing',
      found({
        map: { id: 'map-one', key: 'MAP-7', title: 'A made-up plan' },
      }),
    );
    expect(admitted.text()).toContain('Map: A made-up plan');
    await admitted.unmount();
    const view = await page('Proj-Verity-Pacing', found(over));
    expect(view.text()).not.toContain('Map:');
    expect(view.all('a[href^="/map/"]')).toHaveLength(0);
  },
);
