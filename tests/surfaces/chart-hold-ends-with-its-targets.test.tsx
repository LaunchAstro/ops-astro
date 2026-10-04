// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Security re-bind at 057e424 (L4): a chart that stops drawing its points (no
// width, or no series) lets go of the shown point, so it does not come back.
import { expect, it } from 'vitest';
import { ColumnChart } from '../../packages/ui/src/kit/chart-column.tsx';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { focus, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

const series = [{ label: 'Spend', values: [10, 55] }];

it('a focused point shows no tip after the chart collapses to no width and back', async () => {
  const view = await mount(<ColumnChart name="Spend" labels={['Mon', 'Tue']} bars={series} />);
  try {
    await resize(600);
    await focus(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueSpend 55');
    await resize(0);
    await resize(600);
    expect(view.find('[role="tooltip"]'), 'nothing is hovered or focused').toBeNull();
  } finally {
    await view.unmount();
  }
});

it('a focused point shows no tip after the series empties and returns', async () => {
  const view = await mount(<LineChart name="Spend" labels={['Mon', 'Tue']} series={series} />);
  try {
    await resize(600);
    await focus(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueSpend 55');
    await view.render(<LineChart name="Spend" labels={['Mon', 'Tue']} series={[]} />);
    await view.render(<LineChart name="Spend" labels={['Mon', 'Tue']} series={series} />);
    expect(view.find('[role="tooltip"]'), 'nothing is hovered or focused').toBeNull();
  } finally {
    await view.unmount();
  }
});

it('a focused line point shows no tip after the chart collapses to no width and back', async () => {
  const view = await mount(<LineChart name="Spend" labels={['Mon', 'Tue']} series={series} />);
  try {
    await resize(600);
    await focus(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueSpend 55');
    await resize(0);
    await resize(600);
    expect(view.find('[role="tooltip"]'), 'nothing is hovered or focused').toBeNull();
  } finally {
    await view.unmount();
  }
});

it('a focused column point shows no tip after its bars empty and return', async () => {
  const view = await mount(<ColumnChart name="Spend" labels={['Mon', 'Tue']} bars={series} />);
  try {
    await resize(600);
    await focus(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueSpend 55');
    await view.render(<ColumnChart name="Spend" labels={['Mon', 'Tue']} bars={[]} />);
    await view.render(<ColumnChart name="Spend" labels={['Mon', 'Tue']} bars={series} />);
    expect(view.find('[role="tooltip"]'), 'nothing is hovered or focused').toBeNull();
  } finally {
    await view.unmount();
  }
});
