// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Security re-bind at a14bac3 (L3): a shown point a render removes is let go,
// so its label coming back later does not bring its tip back.
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { hover, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

const chart = (labels: readonly string[]) => (
  <LineChart name="Spend" labels={labels} series={[{ label: 'Spend', values: [10, 77] }]} />
);

it('a hovered point a render removes shows no tip when its label returns', async () => {
  const view = await mount(chart(['Mon', 'Tue']));
  try {
    await resize(600);
    await hover(view.all('.chart__hit')[1]);
    expect(view.find('[role="tooltip"]')?.textContent).toBe('TueSpend 77');
    await view.render(chart(['Mon', 'Wed']));
    expect(view.find('[role="tooltip"]')).toBeNull();
    await view.render(chart(['Mon', 'Tue']));
    expect(view.find('[role="tooltip"]'), 'nothing is hovered or focused').toBeNull();
  } finally {
    await view.unmount();
  }
});
