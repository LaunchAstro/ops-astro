// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { BLOCKS } from '../../packages/ui/src/kit/gallery-layout.tsx';
import { mount } from './mount.tsx';

// Sol OW-105.1 correctness, retitled by what it proves; its body is Sol's.
it('the gallery table rows follow its announced sort direction', async () => {
  const state = BLOCKS.find((entry) => entry.id === 'DS-PRIM-20')?.states.find(
    (candidate) => candidate.label === 'Default, sorted by hours',
  );
  if (state === undefined) throw new Error('the default table state is missing');
  const mounted = await mount(state.render());
  try {
    const headers = mounted.all('th');
    const column = headers.findIndex((header) => header.hasAttribute('aria-sort'));
    expect(column).toBeGreaterThanOrEqual(0);
    const direction = headers[column]?.getAttribute('aria-sort');
    expect(['ascending', 'descending']).toContain(direction);
    const values = mounted
      .all('tbody tr')
      .map((row) => Number(row.querySelectorAll('td')[column]?.textContent));
    expect(values.length).toBeGreaterThan(1);
    expect(values.every((value) => Number.isFinite(value))).toBe(true);
    const expected = values.toSorted((left, right) =>
      direction === 'descending' ? right - left : left - right,
    );
    expect(values, `rows must match aria-sort=${String(direction)}`).toEqual(expected);
  } finally {
    await mounted.unmount();
  }
});
