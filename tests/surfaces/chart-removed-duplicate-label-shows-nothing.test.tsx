// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { hover, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

// Sol G1c-FIX3 correctness, retitled by what it proves; its body is Sol's.
it('removing a hovered duplicate label clears its tooltip instead of showing another point', async () => {
  const view = await mount(
    <LineChart
      name="Spend"
      labels={['Mon', 'Tue', 'Mon']}
      series={[{ label: 'Spend', values: [10, 20, 99] }]}
    />,
  );
  try {
    await resize(600);
    const removed = view.all('.chart__hit')[2];
    await hover(removed);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('MonSpend 99');
    await view.render(
      <LineChart
        name="Spend"
        labels={['Mon', 'Tue']}
        series={[{ label: 'Spend', values: [10, 20] }]}
      />,
    );
    expect(removed?.isConnected).toBe(false);
    expect(view.all('.chart__hit')).toHaveLength(2);
    expect(document.activeElement).toBe(document.body);
    expect(
      view.find('[role="tooltip"]'),
      'the removed Mon does not make the remaining Mon hovered',
    ).toBeNull();
    expect(view.find('.chart__cursor')).toBeNull();
  } finally {
    await view.unmount();
  }
});
