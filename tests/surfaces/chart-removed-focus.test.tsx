// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { focus, hover, leave, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

// Sol G1c-FIX1 criterion correctness, retitled by what it proves; its body is Sol's.
it('removing a focused point cannot transfer its tooltip to an unfocused replacement', async () => {
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
    await hover(view.all('.chart__hit')[0]);
    await leave(view.all('.chart__hit')[0]);
    expect(view.find('[role="tooltip"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});
