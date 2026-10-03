// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
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

// Sol OW-103.2 correctness, retitled by what it proves; its body is Sol's.
it('leaving a focused point keeps its focus tooltip', async () => {
  view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue']}
      series={[{ label: 'Revenue', values: [10, 20] }]}
    />,
  );
  await resize(600);
  const point = view.find('.chart__hit[tabindex="0"]');
  await focus(point);
  expect(view.find('[role="tooltip"]')?.textContent).toBe('MonRevenue 10');
  await hover(point);
  await leave(point);
  expect(document.activeElement).toBe(point);
  expect(view.find('[role="tooltip"]')?.textContent).toBe('MonRevenue 10');
});

// Sol OW-103.3 correctness, retitled by what it proves; its body is Sol's.
it('removing a hovered point removes its tooltip and cursor', async () => {
  view = await mount(
    <LineChart
      name="Revenue"
      labels={['Mon', 'Tue', 'Wed']}
      series={[{ label: 'Revenue', values: [10, 20, 30] }]}
    />,
  );
  await resize(600);
  await hover(view.all('.chart__hit')[2]);
  expect(view.find('[role="tooltip"]')?.textContent).toBe('WedRevenue 30');
  await view.render(
    <LineChart name="Revenue" labels={['Mon']} series={[{ label: 'Revenue', values: [10] }]} />,
  );
  expect(view.all('.chart__hit')).toHaveLength(1);
  expect(view.find('[role="tooltip"]')).toBeNull();
  expect(view.find('.chart__cursor')).toBeNull();
});
