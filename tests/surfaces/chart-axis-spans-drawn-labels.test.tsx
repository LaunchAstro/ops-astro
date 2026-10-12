// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A chart's axis spans only the values it draws, one per label. A series with
// values past the last label draws nothing there, so those values must not
// stretch the axis and squash what is drawn.

import { afterEach, expect, it } from 'vitest';
import { ColumnChart } from '../../packages/ui/src/kit/chart-column.tsx';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { labelled, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('values past the last label leave a stacked axis scaled to the drawn stacks', async () => {
  mounted = await mount(
    <ColumnChart
      name="Spend by channel"
      labels={['Mon', 'Tue']}
      stacked
      bars={[
        { label: 'Search', values: [5, 5] },
        { label: 'Ads', values: [5, 5, 1000] },
      ]}
    />,
  );
  await resize(600);
  const axis = mounted.all('.chart__axis--y').map((tick) => tick.textContent);
  expect(axis).toEqual([...labelled(10)]);
});

it('values past the last label leave a line chart axis scaled to the drawn points', async () => {
  mounted = await mount(
    <LineChart
      name="Replies by day"
      labels={['Mon', 'Tue']}
      series={[{ label: 'Replies', values: [5, 10, 1000] }]}
    />,
  );
  await resize(600);
  const axis = mounted.all('.chart__axis--y').map((tick) => tick.textContent);
  expect(axis).toEqual([...labelled(10)]);
});
