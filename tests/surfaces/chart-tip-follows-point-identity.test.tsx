// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { focus, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

// Sol G1c-FIX2 correctness, retitled by what it proves; its body is Sol's.
it('removing a focused point immediately clears its replacement tooltip', async () => {
  const view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue']}
      series={[{ label: 'Revenue', values: [10, 20] }]}
    />,
  );
  try {
    await resize(600);
    await focus(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueRevenue 20');
    await view.render(
      <LineChart
        name="Revenue"
        labels={['Mon', 'Wed']}
        series={[{ label: 'Revenue', values: [10, 30] }]}
      />,
    );
    expect(document.activeElement?.classList.contains('chart__hit')).toBe(false);
    expect(view.find('[role="tooltip"]'), 'Wed is neither focused nor hovered').toBeNull();
  } finally {
    await view.unmount();
  }
});

// Sol G1c-FIX2 correctness, retitled by what it proves; its body is Sol's.
it('reordered chart points keep the tooltip on the point holding focus', async () => {
  const view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue']}
      series={[{ label: 'Revenue', values: [10, 20] }]}
    />,
  );
  try {
    await resize(600);
    const tue = view.all('.chart__hit')[1];
    await focus(tue);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueRevenue 20');
    await view.render(
      <LineChart
        name="Revenue"
        labels={['Tue', 'Mon']}
        series={[{ label: 'Revenue', values: [20, 10] }]}
      />,
    );
    expect(document.activeElement).toBe(tue);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueRevenue 20');
  } finally {
    await view.unmount();
  }
});
