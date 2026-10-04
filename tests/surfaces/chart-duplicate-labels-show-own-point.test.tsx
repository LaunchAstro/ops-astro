// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Security re-bind SEC-KIT L1 on #385: a chart holding its shown point by key
// must still show the hovered point when two points share a label.
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { hover, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

it('a hovered point shows its own values when another point shares its label', async () => {
  const view = await mount(
    <LineChart
      name="Spend"
      labels={['Mon', 'Tue', 'Mon']}
      series={[{ label: 'Spend', values: [10, 20, 99] }]}
    />,
  );
  try {
    await resize(600);
    await hover(view.all('.chart__hit')[2]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('MonSpend 99');
  } finally {
    await view.unmount();
  }
});
