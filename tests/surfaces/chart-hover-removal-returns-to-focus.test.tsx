// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { focus, hover, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

// Sol G1-FIX2 correctness, retitled by what it proves; its body is Sol's.
it('removing a hovered point hands the tooltip back to surviving focus', async () => {
  const view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue']}
      series={[{ label: 'Revenue', values: [10, 20] }]}
    />,
  );
  try {
    await resize(600);
    const mon = view.all('.chart__hit')[0];
    await focus(mon);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('MonRevenue 10');
    await hover(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueRevenue 20');
    await view.render(
      <LineChart name="Revenue" labels={['Mon']} series={[{ label: 'Revenue', values: [10] }]} />,
    );
    expect(document.activeElement).toBe(mon);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('MonRevenue 10');
  } finally {
    await view.unmount();
  }
});
