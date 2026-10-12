// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A chart's one tab stop belongs to the point that holds focus, not to the
// place it was drawn. When a render reorders the points, the focused point
// keeps tabindex 0 and every other point has -1, so Tab leaves the chart.

import { afterEach, expect, it } from 'vitest';
import { ColumnChart } from '../../packages/ui/src/kit/chart-column.tsx';
import { focus, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Each point's day and tab index, in drawn order. */
const stops = (view: Mounted): string[] =>
  view
    .all('.chart__hit')
    .map(
      (hit) =>
        `${(hit.getAttribute('aria-label') ?? '').split(':')[0]} ${String(hit.getAttribute('tabindex'))}`,
    );

const spend = (values: number[]) => [{ label: 'Spend', values }];

it('a focused point keeps the tab stop after the points are redrawn in another order', async () => {
  mounted = await mount(
    <ColumnChart name="Spend" labels={['Mon', 'Tue']} bars={spend([10, 55])} />,
  );
  await resize(600);
  await focus(mounted.all('.chart__hit')[1]);
  expect(stops(mounted)).toEqual(['Mon -1', 'Tue 0']);
  await mounted.render(<ColumnChart name="Spend" labels={['Tue', 'Mon']} bars={spend([55, 10])} />);
  const tue = mounted.all('.chart__hit')[0];
  expect(document.activeElement, 'Tue still holds focus').toBe(tue);
  expect(stops(mounted)).toEqual(['Tue 0', 'Mon -1']);
  expect(mounted.find('[role="tooltip"]')?.textContent).toBe('TueSpend 55');
});
