// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { focus, hover, leave, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

// Sol G1-FIX1 correctness, retitled by what it proves; its body is Sol's.
it('leaving a point cannot restore focus to a removed chart label', async () => {
  view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue', 'Wed']}
      series={[{ label: 'Revenue', values: [10, 20, 30] }]}
    />,
  );
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
  expect(document.activeElement).toBe(document.body);
  const first = view.all('.chart__hit')[0];
  await hover(first);
  expect(view.find('[role="tooltip"]')?.textContent).toBe('MonRevenue 10');
  await leave(first);
  expect(view.find('[role="tooltip"]')).toBeNull();
  expect(view.find('.chart__cursor')).toBeNull();
});
