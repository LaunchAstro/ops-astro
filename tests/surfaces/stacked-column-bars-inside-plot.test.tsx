// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (REVIEW-MAIN-B1 p06-1): a stacked column chart's axis must
// cover every bar it draws. The axis sums only each label's positive values,
// and only over the first series' length, while the bars stack every value
// over every label, so a negative value or a longer later series draws a bar
// outside the plot.

import { afterEach, describe, expect, it } from 'vitest';
import { ColumnChart } from '../../packages/ui/src/kit/charts.tsx';
import { mount, type Mounted } from './mount.tsx';
import { resize, standInResizeObserver } from './chart-driver.tsx';

let mounted: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Each bar's top and bottom, against the plot's. */
function outside(view: Mounted): string[] {
  const plot = view.find('.chart__plot');
  const top = Number(plot?.getAttribute('y'));
  const bottom = top + Number(plot?.getAttribute('height'));
  return view.all('rect.chart__bar').flatMap((bar) => {
    const y = Number(bar.getAttribute('y'));
    const end = y + Number(bar.getAttribute('height'));
    return y < top - 0.5 || end > bottom + 0.5
      ? [`bar ${y.toFixed(1)}..${end.toFixed(1)} outside plot ${top}..${bottom}`]
      : [];
  });
}

describe('review p06-1: stacked column axis covers the stack it draws', () => {
  it('a negative value in a stacked column stays inside the plot', async () => {
    mounted = await mount(
      <ColumnChart
        name="Net sales"
        labels={['Mon', 'Tue']}
        stacked
        bars={[
          { label: 'Refunds', values: [-30, -20], unit: 'money' },
          { label: 'Sales', values: [100, 80], unit: 'money' },
        ]}
      />,
    );
    await resize(600);
    expect(
      outside(mounted),
      'defect: stacked column axis ignores negative values, so the bar is drawn outside the plot',
    ).toEqual([]);
  });

  it('a later series longer than the first stays inside the plot', async () => {
    mounted = await mount(
      <ColumnChart
        name="Spend by channel"
        labels={['Mon', 'Tue']}
        stacked
        bars={[
          { label: 'Search', values: [5] },
          { label: 'Ads', values: [5, 100] },
        ]}
      />,
    );
    await resize(600);
    expect(
      outside(mounted),
      "defect: stacked column axis sums only over the first series' length, so a longer series overflows the plot",
    ).toEqual([]);
  });
});
